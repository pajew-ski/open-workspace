/**
 * Der EINE Schreibweg für die Struktur eines Kausalmodells
 * (CAUSAL_LAYER_SPEC §5, Meilenstein C1).
 *
 * Bis C0 konnte man ein Modell anlegen und danach nur noch per SPARQL
 * füllen. Mit C1 gibt es den DAG-Editor — und damit die Pflicht, dass
 * Editor, CRUD und SPARQL-Editor **dasselbe** tun. Deshalb liegt hier
 * genau eine Operation je Änderung, und jede von ihnen:
 *
 *  1. arbeitet **chirurgisch** auf den vorhandenen Quads. Der Graph wird
 *     nie aus dem Lesemodell neu erzeugt — alles, was ein Mensch per
 *     SPARQL hineingeschrieben hat und wovon dieses Modul nichts weiß,
 *     bliebe sonst still auf der Strecke;
 *  2. schreibt eine **Revision** (`prov:Activity` + `schema:version`).
 *     Eine Studie beruft sich später auf genau diese Nummer (Invariante
 *     C7); wer die Historie erst dann anlegt, hat sie nicht;
 *  3. lehnt ab, was **kein DAG** mehr wäre. Azyklizität ist keine
 *     Geschmacksfrage: In einem Zyklus ist keine Aussage über
 *     Identifizierbarkeit mehr möglich (C1). Abgelehnt wird mit dem
 *     Zyklus im Klartext, nicht mit „ungültig".
 *
 * Was schon zyklisch IM Graphen steht (etwa per SPARQL geschrieben),
 * bleibt lesbar und bearbeitbar — dieselbe Haltung wie bei SHACL in
 * §7.2: Altbestand blockiert nicht, er wird gemeldet.
 */

import type { Quad } from '@rdfjs/types';
import { factory, literal, namedNode, typedLiteral } from '../rdf';
import { newViolations, ShaclViolationError, validateQuads } from '../reasoning/shacl';
import { DCTERMS, OW, PROV, RDF, RO, SCHEMA } from '../vocab';
import { createDag, findCycle } from './dag';
import {
    assertModelId,
    causalEdgeReifier,
    readCausalModel,
    type GraphHandle,
} from './model';
import { EDGE_CLASSES, EVIDENCE_LEVELS, type CausalModelView, type EdgeClass, type EvidenceLevel } from './types';

export type StructureOperation =
    /** Entweder eine vorhandene Größe (`iri`) oder eine neue nach Namen. */
    | { op: 'add-variable'; iri?: string; name?: string }
    | { op: 'remove-variable'; iri: string }
    | {
        op: 'add-edge';
        from: string;
        to: string;
        edgeClass: EdgeClass;
        evidenceLevel?: EvidenceLevel;
        temporalLag?: string;
    }
    | { op: 'remove-edge'; from: string; to: string }
    | { op: 'describe'; name?: string; description?: string };

export interface EditContext {
    /** Nutzer-IRI der Identität, die die Änderung verantwortet. */
    actor?: string;
    now?: Date;
}

export interface EditResult {
    model: CausalModelView;
    /** Was passiert ist, in einem Satz — für Toast und Aktivitätsprotokoll. */
    message: string;
}

/** Fehler, den die Route in eine 4xx-Antwort übersetzt. */
export class CausalEditError extends Error {
    constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
        super(message);
        this.name = 'CausalEditError';
    }
}

const ISO_DURATION = /^-?P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;

async function dumpGraph(handle: GraphHandle, graph: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const quad of handle.store.dump(namedNode(graph))) quads.push(quad);
    return quads;
}

function isEdgeQuad(quad: Quad, from: string, to: string): boolean {
    return quad.predicate.value === RO.causallyUpstreamOf
        && quad.subject.value === from
        && quad.object.termType === 'NamedNode'
        && quad.object.value === to;
}

/** Reifier, die genau diese Kante annotieren (RDF 1.2, `rdf:reifies`). */
function reifiersOf(quads: readonly Quad[], from: string, to: string): Set<string> {
    const out = new Set<string>();
    for (const quad of quads) {
        if (quad.predicate.value !== RDF.reifies) continue;
        if (quad.object.termType !== 'Quad') continue;
        const triple = quad.object;
        if (triple.predicate.value !== RO.causallyUpstreamOf) continue;
        if (triple.subject.value === from && triple.object.value === to) out.add(quad.subject.value);
    }
    return out;
}

function nodesOf(model: CausalModelView): string[] {
    return model.variables.map(variable => variable.iri);
}

function nameOf(model: CausalModelView, iri: string): string {
    return model.variables.find(variable => variable.iri === iri)?.name
        ?? decodeURIComponent(iri.split('/').filter(Boolean).pop() ?? iri);
}

/**
 * Die Revision selbst: eine Aktivität im Modell-Graphen plus die neue
 * Versionsnummer am Modell. `prov:generated` zeigt auf das Modell — die
 * Änderung hat es in seinen neuen Zustand gebracht.
 */
function revisionQuads(
    model: CausalModelView,
    revision: number,
    description: string,
    context: EditContext,
): Quad[] {
    const graph = namedNode(model.graph);
    const at = (context.now ?? new Date()).toISOString();
    const activity = namedNode(`${model.iri}/revision/${String(revision).padStart(4, '0')}`);
    const quads: Quad[] = [
        factory.quad(activity, namedNode(RDF.type), namedNode(PROV.Activity), graph),
        factory.quad(activity, namedNode(SCHEMA.version), typedLiteral.integer(revision), graph),
        factory.quad(activity, namedNode(DCTERMS.created), typedLiteral.dateTime(at), graph),
        factory.quad(activity, namedNode(SCHEMA.description), literal(description), graph),
        factory.quad(activity, namedNode(PROV.generated), namedNode(model.iri), graph),
        factory.quad(namedNode(model.iri), namedNode(SCHEMA.version), typedLiteral.integer(revision), graph),
        factory.quad(namedNode(model.iri), namedNode(DCTERMS.modified), typedLiteral.dateTime(at), graph),
    ];
    if (context.actor) {
        quads.push(factory.quad(activity, namedNode(PROV.wasAttributedTo), namedNode(context.actor), graph));
    }
    return quads;
}

interface Applied {
    /** Quads, die verschwinden (per Prädikat-Vergleich auf N-Quad-Ebene). */
    remove: (quad: Quad) => boolean;
    add: Quad[];
    description: string;
}

/** Name → IRI-taugliche Kennung. Dieselbe Regel wie bei Modell-Kennungen. */
function variableSlug(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    if (slug === '') {
        throw new CausalEditError(`Aus „${name}" lässt sich keine Kennung bilden — nimm Buchstaben oder Ziffern.`);
    }
    return slug;
}

type ResolvedOperation = Exclude<StructureOperation, { op: 'add-variable' }> | {
    op: 'add-variable';
    iri: string;
    name?: string;
};

function applyOperation(model: CausalModelView, quads: readonly Quad[], operation: ResolvedOperation, iriFactory: GraphHandle['iri']): Applied {
    const graph = namedNode(model.graph);
    const subject = namedNode(model.iri);

    switch (operation.op) {
        case 'add-variable': {
            if (model.variables.some(variable => variable.iri === operation.iri && variable.inModel)) {
                throw new CausalEditError(
                    `„${nameOf(model, operation.iri)}" gehört bereits zum Modell.`,
                    409,
                );
            }
            const target = namedNode(operation.iri);
            const add: Quad[] = [
                factory.quad(subject, namedNode(SCHEMA.hasPart), target, graph),
                factory.quad(target, namedNode(RDF.type), namedNode(OW.Variable), graph),
            ];
            // Der Name wird nur gesetzt, wenn im Modell-Graphen noch keiner
            // steht: Was aus der Erfassung (graph/meta) kommt, trägt seinen
            // eigenen und wird hier nicht überschrieben.
            const hasName = quads.some(quad =>
                quad.subject.value === operation.iri && quad.predicate.value === SCHEMA.name);
            if (operation.name && !hasName) {
                add.push(factory.quad(target, namedNode(SCHEMA.name), literal(operation.name), graph));
            }
            return {
                remove: () => false,
                add,
                description: `Variable „${operation.name ?? nameOf(model, operation.iri)}" aufgenommen.`,
            };
        }
        case 'remove-variable': {
            if (!model.variables.some(variable => variable.iri === operation.iri)) {
                throw new CausalEditError('Diese Variable steht nicht im Modell.', 404);
            }
            const touching = model.edges.filter(edge => edge.from === operation.iri || edge.to === operation.iri);
            const reifiers = new Set<string>();
            for (const edge of touching) {
                for (const reifier of reifiersOf(quads, edge.from, edge.to)) reifiers.add(reifier);
            }
            const name = nameOf(model, operation.iri);
            return {
                remove: quad =>
                    quad.subject.value === operation.iri
                    || (quad.object.termType === 'NamedNode' && quad.object.value === operation.iri)
                    || reifiers.has(quad.subject.value)
                    || (quad.object.termType === 'Quad'
                        && (quad.object.subject.value === operation.iri || quad.object.object.value === operation.iri)),
                add: [],
                description: touching.length === 0
                    ? `Variable „${name}" entfernt.`
                    : `Variable „${name}" mit ${touching.length} Kante(n) entfernt.`,
            };
        }
        case 'add-edge': {
            if (operation.from === operation.to) {
                throw new CausalEditError('Eine Größe kann nicht ihre eigene Ursache sein.');
            }
            const known = new Set(nodesOf(model));
            if (!known.has(operation.from) || !known.has(operation.to)) {
                throw new CausalEditError('Ursache und Wirkung müssen erst als Variablen im Modell stehen.', 404);
            }
            if (model.edges.some(edge => edge.from === operation.from && edge.to === operation.to)) {
                throw new CausalEditError('Diese Kante steht bereits im Modell.', 409);
            }
            if (operation.temporalLag && !ISO_DURATION.test(operation.temporalLag)) {
                throw new CausalEditError(
                    `„${operation.temporalLag}" ist keine ISO-8601-Dauer (z. B. PT15M für 15 Minuten).`,
                );
            }
            // Azyklizität VOR dem Schreiben (C1): Ein Zyklus macht jede
            // Identifikation unmöglich, also entsteht er gar nicht erst.
            const next = createDag({
                nodes: nodesOf(model),
                edges: [...model.edges.map(edge => ({ from: edge.from, to: edge.to })),
                    { from: operation.from, to: operation.to }],
            });
            const cycle = findCycle(next);
            if (cycle) {
                throw new CausalEditError(
                    `Diese Kante schließt einen Kreis: ${cycle.map(node => nameOf(model, node)).join(' → ')}. `
                    + 'Ein Kausalmodell muss azyklisch sein — dreh eine der beteiligten Kanten um '
                    + 'oder trenne die Größen.',
                    409,
                );
            }
            const triple = factory.quad(
                namedNode(operation.from),
                namedNode(RO.causallyUpstreamOf),
                namedNode(operation.to),
            );
            const reifier = namedNode(causalEdgeReifier(iriFactory, model.id, operation.from, operation.to));
            const add: Quad[] = [
                factory.quad(triple.subject, triple.predicate, triple.object, graph),
                factory.quad(reifier, namedNode(RDF.reifies), triple, graph),
                factory.quad(reifier, namedNode(OW.edgeClass), literal(operation.edgeClass), graph),
                factory.quad(
                    reifier,
                    namedNode(OW.evidenceLevel),
                    literal(operation.evidenceLevel ?? 'hypothesis'),
                    graph,
                ),
            ];
            if (operation.temporalLag) {
                add.push(factory.quad(
                    reifier,
                    namedNode(OW.temporalLag),
                    typedLiteral.duration(operation.temporalLag),
                    graph,
                ));
            }
            return {
                remove: () => false,
                add,
                description: `Kante ${nameOf(model, operation.from)} → ${nameOf(model, operation.to)} `
                    + `ergänzt (${operation.edgeClass}).`,
            };
        }
        case 'remove-edge': {
            if (!model.edges.some(edge => edge.from === operation.from && edge.to === operation.to)) {
                throw new CausalEditError('Diese Kante steht nicht im Modell.', 404);
            }
            const reifiers = reifiersOf(quads, operation.from, operation.to);
            return {
                remove: quad => isEdgeQuad(quad, operation.from, operation.to) || reifiers.has(quad.subject.value),
                add: [],
                description: `Kante ${nameOf(model, operation.from)} → ${nameOf(model, operation.to)} entfernt.`,
            };
        }
        case 'describe': {
            const add: Quad[] = [];
            if (operation.name !== undefined) {
                add.push(factory.quad(subject, namedNode(SCHEMA.name), literal(operation.name), graph));
            }
            if (operation.description !== undefined && operation.description !== '') {
                add.push(factory.quad(subject, namedNode(SCHEMA.description), literal(operation.description), graph));
            }
            return {
                remove: quad => quad.subject.value === model.iri
                    && ((operation.name !== undefined && quad.predicate.value === SCHEMA.name)
                        || (operation.description !== undefined && quad.predicate.value === SCHEMA.description)),
                add,
                description: 'Beschreibung des Modells geändert.',
            };
        }
    }
}

async function assertConforms(
    handle: GraphHandle,
    before: readonly Quad[],
    after: readonly Quad[],
): Promise<void> {
    const shapes: Quad[] = [];
    for await (const quad of handle.store.dump(namedNode(handle.iri.sharedGraph('shapes')))) shapes.push(quad);
    if (shapes.length === 0) return;
    const fresh = newViolations(
        await validateQuads(shapes, [...before]),
        await validateQuads(shapes, [...after]),
    );
    if (fresh.length > 0) throw new ShaclViolationError(fresh);
}

/**
 * Führt genau eine Strukturänderung aus. Rückgabe ist das frisch gelesene
 * Modell — der Aufrufer bekommt den Zustand, der wirklich im Graphen
 * steht, nicht den, den er erwartet hat.
 */
export async function applyStructureOperation(
    handle: GraphHandle,
    modelId: string,
    operation: StructureOperation,
    context: EditContext = {},
): Promise<EditResult> {
    assertModelId(modelId);
    if (operation.op === 'add-edge' && !(EDGE_CLASSES as readonly string[]).includes(operation.edgeClass)) {
        throw new CausalEditError(`Unbekannte Herkunftsklasse „${operation.edgeClass}".`);
    }
    if (operation.op === 'add-edge' && operation.evidenceLevel
        && !(EVIDENCE_LEVELS as readonly string[]).includes(operation.evidenceLevel)) {
        throw new CausalEditError(`Unbekannter Belegstand „${operation.evidenceLevel}".`);
    }

    const graph = handle.iri.causalGraph(modelId);
    const model = await readCausalModel(handle, { modelId, graph });
    if (!model) throw new CausalEditError('Kausalmodell nicht gefunden.', 404);

    // Eine neue Variable bekommt ihre IRI aus dem Namen. Trifft sie dabei
    // eine erfasste Größe (C3), ist genau das gemeint — dieselbe Größe,
    // ein Knoten; erfunden wird kein zweiter daneben.
    let resolved: ResolvedOperation;
    if (operation.op === 'add-variable') {
        const target = operation.iri
            ?? handle.iri.entity('variable', variableSlug(operation.name ?? ''));
        if (!operation.iri && !operation.name) {
            throw new CausalEditError('Eine Variable braucht einen Namen.');
        }
        resolved = { ...operation, iri: target };
    } else {
        resolved = operation;
    }

    const quads = await dumpGraph(handle, graph);
    const applied = applyOperation(model, quads, resolved, handle.iri);
    const revision = model.revision + 1;

    const kept = quads.filter(quad => !applied.remove(quad)
        // Version und Änderungszeitpunkt werden ersetzt, nicht ergänzt.
        && !(quad.subject.value === model.iri
            && (quad.predicate.value === SCHEMA.version || quad.predicate.value === DCTERMS.modified)));
    const next = [...kept, ...applied.add, ...revisionQuads(model, revision, applied.description, context)];

    // SHACL-Stelle 1 (SPEC §7.2): blockierend NUR bei Verstößen, die
    // diese Änderung neu einführt. Ein Altbestand mit Mängeln bleibt
    // bearbeitbar — er darf nur nicht schlechter werden.
    await assertConforms(handle, quads, next);

    await handle.store.load(next, namedNode(graph), { replace: true });

    const updated = await readCausalModel(handle, { modelId, graph });
    if (!updated) throw new CausalEditError('Das Modell konnte nach der Änderung nicht gelesen werden.', 404);
    return { model: updated, message: applied.description };
}
