/**
 * Fortschritt der Einführungsstrecke als RDF (GRAPH_CORE_SPEC §18, M14).
 *
 * Der Fortschritt ist KEIN UI-Zustand: Jeder ausgeführte Schritt ist eine
 * `ow:OnboardingStep` (⊑ prov:Activity) in `graph/meta` — wer ihn wann
 * ausgeführt hat, was er dabei benutzt (`prov:used`) und was er erzeugt
 * hat (`prov:generated`). Damit ist „wie weit bin ich" per SPARQL
 * beantwortbar, und „rückgängig" heißt: das Erzeugte und den Schritt
 * löschen — es gibt keine zweite Buchführung, die falsch sein könnte.
 *
 * Die Knoten sind nutzerskaliert (`u/<userId>/activity/onboarding/<id>`):
 * Zwei Nutzer derselben Installation haben getrennte Fortschritte, ohne
 * dass dafür ein Mechanismus nötig wäre.
 */

import type { NamedNode, Quad, Term } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { factory, namedNode, literal, typedLiteral } from '../rdf';
import { DCTERMS, OW, PROV, RDF, SPARQL_PREFIXES } from '../vocab';
import { resolveDataset, type DatasetAuthz } from '../sparql/protocol';
import type { OnboardingStepId } from './steps';

export interface GraphHandle {
    store: GraphStore;
    iri: IriFactory;
}

export interface OnboardingRecord {
    stepId: string;
    iri: string;
    completedAt: string;
    /** IRIs, die dieser Schritt erzeugt hat (Dokument, Connector). */
    generated: string[];
    /** IRIs, die dieser Schritt betrachtet hat (Selbstmodell, Graphen). */
    used: string[];
}

/** IRI des Schritt-Knotens — stabil, damit ein Schritt genau einmal zählt. */
export function onboardingStepIri(iri: IriFactory, stepId: string): string {
    return iri.entity('activity', `onboarding/${stepId}`);
}

function stepIdFromIri(iri: IriFactory, value: string): string | null {
    const prefix = onboardingStepIri(iri, '');
    return value.startsWith(prefix) ? decodeURIComponent(value.slice(prefix.length)) : null;
}

export interface RecordStepInput {
    stepId: OnboardingStepId;
    generated?: readonly string[];
    used?: readonly string[];
    /** Zeitquelle, injizierbar für deterministische Tests. */
    now?: string;
}

function stepQuads(handle: GraphHandle, input: RecordStepInput, graph: NamedNode): Quad[] {
    const node = namedNode(onboardingStepIri(handle.iri, input.stepId));
    const completedAt = input.now ?? new Date().toISOString();
    const quads: Quad[] = [
        factory.quad(node, namedNode(RDF.type), namedNode(OW.OnboardingStep), graph),
        factory.quad(node, namedNode(DCTERMS.identifier), literal(input.stepId), graph),
        factory.quad(node, namedNode(PROV.endedAtTime), typedLiteral.dateTime(completedAt), graph),
        factory.quad(
            node,
            namedNode(PROV.wasAttributedTo),
            namedNode(handle.iri.principal('user', handle.iri.userId)),
            graph,
        ),
    ];
    for (const generated of [...(input.generated ?? [])].sort()) {
        quads.push(factory.quad(node, namedNode(PROV.generated), namedNode(generated), graph));
    }
    for (const used of [...(input.used ?? [])].sort()) {
        quads.push(factory.quad(node, namedNode(PROV.used), namedNode(used), graph));
    }
    return quads;
}

/** Ersetzt den Knoten eines Schritts (idempotent: erneut ausführen ist erlaubt). */
export async function recordOnboardingStep(handle: GraphHandle, input: RecordStepInput): Promise<void> {
    const graph = namedNode(handle.iri.sharedGraph('meta'));
    const subject = onboardingStepIri(handle.iri, input.stepId);
    await handle.store.transaction(async tx => {
        const remaining: Quad[] = [];
        for await (const quad of tx.dump(graph)) {
            if (quad.subject.value !== subject) remaining.push(quad);
        }
        await tx.load([...remaining, ...stepQuads({ store: tx, iri: handle.iri }, input, graph)], graph, { replace: true });
    });
}

/** Entfernt den Knoten eines Schritts; `false`, wenn es ihn nicht gab. */
export async function removeOnboardingStep(handle: GraphHandle, stepId: string): Promise<boolean> {
    const graph = namedNode(handle.iri.sharedGraph('meta'));
    const subject = onboardingStepIri(handle.iri, stepId);
    let removed = false;
    await handle.store.transaction(async tx => {
        const remaining: Quad[] = [];
        for await (const quad of tx.dump(graph)) {
            if (quad.subject.value === subject) removed = true;
            else remaining.push(quad);
        }
        if (removed) await tx.load(remaining, graph, { replace: true });
    });
    return removed;
}

/**
 * Ausgeführte Schritte dieses Nutzers. Das Dataset kommt vom Resolver
 * (§17.3) — ohne Leserecht auf `graph/meta` ist die Strecke leer, nicht
 * heimlich gefüllt.
 */
export async function listOnboardingRecords(
    handle: GraphHandle,
    authz: DatasetAuthz = {},
): Promise<OnboardingRecord[]> {
    const dataset = await resolveDataset(handle.store, handle.iri, undefined, authz);
    const meta = `<${handle.iri.sharedGraph('meta')}>`;
    const result = await handle.store.query(`${SPARQL_PREFIXES}
        SELECT ?step ?id ?completedAt ?generated ?used WHERE { GRAPH ${meta} {
            ?step a ow:OnboardingStep ; dcterms:identifier ?id ; prov:endedAtTime ?completedAt .
            OPTIONAL { ?step prov:generated ?generated }
            OPTIONAL { ?step prov:used ?used }
        } } ORDER BY ?step`, {
        defaultGraphs: dataset.defaultGraphs,
        namedGraphs: dataset.namedGraphs,
    });
    if (result.type !== 'bindings') return [];

    const byIri = new Map<string, OnboardingRecord>();
    for await (const row of result.bindings as AsyncIterable<Record<string, Term>>) {
        const stepIri = row.step.value;
        // Nur Schritte DIESES Nutzers: ein fremder Fortschritt trüge zwar
        // dieselbe Klasse, aber einen anderen IRI-Namensraum.
        const stepId = stepIdFromIri(handle.iri, stepIri);
        if (stepId === null || stepId !== row.id.value) continue;
        const existing = byIri.get(stepIri) ?? {
            stepId,
            iri: stepIri,
            completedAt: row.completedAt.value,
            generated: [],
            used: [],
        };
        if (row.generated && !existing.generated.includes(row.generated.value)) {
            existing.generated.push(row.generated.value);
        }
        if (row.used && !existing.used.includes(row.used.value)) {
            existing.used.push(row.used.value);
        }
        byIri.set(stepIri, existing);
    }
    return [...byIri.values()].map(record => ({
        ...record,
        generated: [...record.generated].sort(),
        used: [...record.used].sort(),
    }));
}
