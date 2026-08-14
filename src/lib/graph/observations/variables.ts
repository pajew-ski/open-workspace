/**
 * Beobachtungsgrößen als Graph-Bürger (CAUSAL_LAYER_SPEC §5).
 *
 * `ow:Variable`-Knoten liegen in `graph/meta` — dasselbe Muster wie
 * Retrieval-Profile (M8) und Query-Views (M5): Sie sind
 * Systemkonfiguration, überleben jeden Workspace-Replace und sind
 * trotzdem per SPARQL abfragbar (Invariante 6). Ihre IRI ist
 * nutzerskaliert (`u/<userId>/variable/<id>`), damit Mehrbenutzerbetrieb
 * keine Datenmigration ist.
 *
 * Im Knoten steht ausschließlich die Erfassungsregel und der Fortschritt:
 * Quelle, Skalenniveau, Verdichtung, Abtastabstand, Aufbewahrung, Von-Bis
 * und Anzahl. Die Werte liegen im Beobachtungs-Speicher (`store.ts`) und
 * werden nie zu Tripeln (Invariante C3).
 *
 * Der letzte Erfassungslauf ist — wie beim Connector — eine
 * `prov:Activity` pro Größe, die ersetzt und nicht angehäuft wird. Damit
 * ist ein Fehler in der UI sichtbar, ohne dass eine zweite Buchführung
 * entsteht.
 */

import type { Quad } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { factory, literal, namedNode, typedLiteral } from '../rdf';
import { DCTERMS, OW, PROV, RDF, SCHEMA, SOSA } from '../vocab';
import {
    ALLOWED_AGGREGATIONS,
    type Aggregation,
    type CaptureState,
    type CaptureStatus,
    type ObservationKind,
    type VariableDefinition,
    type VariableView,
} from './types';

export interface GraphHandle {
    store: GraphStore;
    iri: IriFactory;
}

/** Höchstzahl gespeicherter Fehlermeldungen pro Lauf (wie beim Connector). */
const MAX_STORED_ERRORS = 20;

const KINDS: ReadonlySet<string> = new Set(['numeric', 'binary', 'categorical']);
const AGGREGATIONS: ReadonlySet<string> = new Set(['last', 'mean', 'min', 'max', 'sum']);
const CAPTURE_STATES: ReadonlySet<string> = new Set(['idle', 'capturing', 'error']);

export function variableIriFor(iri: IriFactory, id: string): string {
    return iri.entity('variable', id);
}

export function captureRunIri(iri: IriFactory, id: string): string {
    return iri.entity('activity', `capture-${id}`);
}

function variableIdFromIri(iri: IriFactory, value: string): string | null {
    const prefix = variableIriFor(iri, '');
    if (!value.startsWith(prefix)) return null;
    const rest = value.slice(prefix.length);
    return rest === '' ? null : decodeURIComponent(rest);
}

async function readMeta(handle: GraphHandle): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of handle.store.dump(namedNode(handle.iri.sharedGraph('meta')))) {
        quads.push(q);
    }
    return quads;
}

/** `PT5M` → 300; unbekannte Formen → null (statt still zu raten). */
export function durationToSeconds(value: string): number | null {
    const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
    if (!match || (!match[1] && !match[2] && !match[3])) return null;
    return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

export function secondsToDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    const parts = [
        hours > 0 ? `${hours}H` : '',
        minutes > 0 ? `${minutes}M` : '',
        rest > 0 || seconds === 0 ? `${rest}S` : '',
    ].join('');
    return `PT${parts}`;
}

/**
 * Prüft die Kombination aus Skalenniveau und Verdichtung. Ein Mittelwert
 * über kategoriale Zustände ist keine grobe Näherung, sondern eine
 * Falschaussage — deshalb wird sie abgelehnt und nicht stillschweigend
 * korrigiert.
 */
export function assertAggregationAllowed(kind: ObservationKind, aggregation: Aggregation): void {
    if (!ALLOWED_AGGREGATIONS[kind].includes(aggregation)) {
        throw new Error(
            `Verdichtung "${aggregation}" ist für die Messgrößenart "${kind}" nicht zulässig ` +
            `(erlaubt: ${ALLOWED_AGGREGATIONS[kind].join(', ')}).`,
        );
    }
}

function viewFromQuads(handle: GraphHandle, variableIri: string, quads: Quad[]): VariableView | null {
    const mine = quads.filter(q => q.subject.termType === 'NamedNode' && q.subject.value === variableIri);
    if (!mine.some(q => q.predicate.value === RDF.type && q.object.value === OW.Variable)) return null;
    const id = variableIdFromIri(handle.iri, variableIri);
    if (!id) return null;

    const value = (predicate: string) => mine.find(q => q.predicate.value === predicate)?.object.value;
    const kindRaw = value(OW.observationKind) ?? 'numeric';
    const aggregationRaw = value(OW.aggregation) ?? 'last';
    const intervalRaw = value(OW.samplingInterval);
    const stateRaw = value(OW.captureState) ?? 'idle';

    const runIri = captureRunIri(handle.iri, id);
    const run = quads.filter(q => q.subject.termType === 'NamedNode' && q.subject.value === runIri);
    const runValue = (predicate: string) => run.find(q => q.predicate.value === predicate)?.object.value;
    const runAt = runValue(PROV.generatedAtTime);

    const status: CaptureStatus = {
        state: (CAPTURE_STATES.has(stateRaw) ? stateRaw : 'idle') as CaptureState,
        capturedFrom: value(OW.capturedFrom),
        capturedThrough: value(OW.capturedThrough),
        count: Number(value(OW.observationCount) ?? '0') || 0,
        ...(runAt
            ? {
                lastRun: {
                    at: runAt,
                    summary: runValue(SCHEMA.description) ?? '',
                    errors: run.filter(q => q.predicate.value === SCHEMA.error).map(q => q.object.value).sort(),
                },
            }
            : {}),
    };

    const unit = value(SCHEMA.unitText);
    const placeIri = value(SCHEMA.location);
    // Die Kante zeigt vom SENSOR auf die Variable (SOSA-Richtung, seit
    // docs/spec-widersprueche.md Eintrag 8) — sie steht deshalb nicht in
    // `mine`, wo nur Quads mit der Variablen als Subjekt liegen. Sie hier
    // zu suchen war der Fehler: Der Schreibpfad baut die Quads aus DIESEM
    // Lesemodell neu, also verlor jedes `saveVariable` die Kante still,
    // und mit ihr die Verbindung zur Messquelle (Ort, Gerät, Größenart).
    const sensorIri = quads.find(q =>
        q.predicate.value === SOSA.observes && q.object.value === variableIri)?.subject.value;

    return {
        id,
        iri: variableIri,
        name: value(SCHEMA.name) ?? id,
        sourceKind: value(SCHEMA.category) ?? 'unbekannt',
        source: value(OW.observationSource) ?? '',
        kind: (KINDS.has(kindRaw) ? kindRaw : 'numeric') as ObservationKind,
        aggregation: (AGGREGATIONS.has(aggregationRaw) ? aggregationRaw : 'last') as Aggregation,
        intervalSeconds: (intervalRaw ? durationToSeconds(intervalRaw) : null) ?? 300,
        ...(unit ? { unit } : {}),
        ...(placeIri ? { placeIri } : {}),
        ...(sensorIri ? { sensorIri } : {}),
        enabled: value(OW.captureEnabled) !== 'false',
        retentionDays: Number(value(OW.retentionDays) ?? '0') || 0,
        status,
    };
}

export async function listVariables(handle: GraphHandle): Promise<VariableView[]> {
    const quads = await readMeta(handle);
    const subjects = new Set<string>();
    for (const q of quads) {
        if (q.predicate.value === RDF.type && q.object.value === OW.Variable && q.subject.termType === 'NamedNode') {
            subjects.add(q.subject.value);
        }
    }
    const views: VariableView[] = [];
    for (const subject of subjects) {
        const view = viewFromQuads(handle, subject, quads);
        if (view) views.push(view);
    }
    return views.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export async function getVariable(handle: GraphHandle, id: string): Promise<VariableView | null> {
    return viewFromQuads(handle, variableIriFor(handle.iri, id), await readMeta(handle));
}

function variableQuads(handle: GraphHandle, view: VariableView, graph: Quad['graph']): Quad[] {
    const subject = namedNode(view.iri);
    const quads: Quad[] = [
        factory.quad(subject, namedNode(RDF.type), namedNode(OW.Variable), graph),
        factory.quad(subject, namedNode(SCHEMA.name), literal(view.name), graph),
        factory.quad(subject, namedNode(DCTERMS.identifier), literal(view.id), graph),
        factory.quad(subject, namedNode(SCHEMA.category), literal(view.sourceKind), graph),
        factory.quad(subject, namedNode(OW.observationSource), literal(view.source), graph),
        factory.quad(subject, namedNode(OW.observationKind), literal(view.kind), graph),
        factory.quad(subject, namedNode(OW.aggregation), literal(view.aggregation), graph),
        factory.quad(
            subject,
            namedNode(OW.samplingInterval),
            typedLiteral.duration(secondsToDuration(view.intervalSeconds)),
            graph,
        ),
        factory.quad(subject, namedNode(OW.captureEnabled), typedLiteral.boolean(view.enabled), graph),
        factory.quad(subject, namedNode(OW.captureState), literal(view.status.state), graph),
        factory.quad(subject, namedNode(OW.observationCount), typedLiteral.integer(view.status.count), graph),
        factory.quad(subject, namedNode(OW.retentionDays), typedLiteral.integer(view.retentionDays), graph),
    ];
    if (view.unit) {
        quads.push(factory.quad(subject, namedNode(SCHEMA.unitText), literal(view.unit), graph));
    }
    if (view.placeIri) {
        quads.push(factory.quad(subject, namedNode(SCHEMA.location), namedNode(view.placeIri), graph));
    }
    // Die Kante zeigt vom Sensor auf die beobachtete Größe (SOSA-Richtung),
    // nicht umgekehrt — sonst wäre die Struktur beim Föderieren falsch
    // herum lesbar.
    if (view.sensorIri) {
        quads.push(factory.quad(namedNode(view.sensorIri), namedNode(SOSA.observes), subject, graph));
    }
    if (view.status.capturedFrom) {
        quads.push(factory.quad(subject, namedNode(OW.capturedFrom), typedLiteral.dateTime(view.status.capturedFrom), graph));
    }
    if (view.status.capturedThrough) {
        quads.push(factory.quad(subject, namedNode(OW.capturedThrough), typedLiteral.dateTime(view.status.capturedThrough), graph));
    }
    if (view.status.lastRun) {
        const run = namedNode(captureRunIri(handle.iri, view.id));
        quads.push(
            factory.quad(run, namedNode(RDF.type), namedNode(PROV.Activity), graph),
            factory.quad(run, namedNode(PROV.wasAttributedTo), subject, graph),
            factory.quad(run, namedNode(PROV.generatedAtTime), typedLiteral.dateTime(view.status.lastRun.at), graph),
        );
        if (view.status.lastRun.summary) {
            quads.push(factory.quad(run, namedNode(SCHEMA.description), literal(view.status.lastRun.summary, 'de'), graph));
        }
        const errors = view.status.lastRun.errors.slice(0, MAX_STORED_ERRORS);
        if (view.status.lastRun.errors.length > MAX_STORED_ERRORS) {
            errors.push(`… und ${view.status.lastRun.errors.length - MAX_STORED_ERRORS} weitere (gekürzt).`);
        }
        for (const message of errors) {
            quads.push(factory.quad(run, namedNode(SCHEMA.error), literal(message), graph));
        }
    }
    return quads;
}

/**
 * Ersetzt die Knoten einer Größe (Variable, Sensor-Kante, letzter Lauf)
 * in `graph/meta`, ohne andere Meta-Inhalte anzufassen.
 */
async function replaceVariableNodes(handle: GraphHandle, id: string, view: VariableView | null): Promise<void> {
    const metaGraph = namedNode(handle.iri.sharedGraph('meta'));
    const variableIri = variableIriFor(handle.iri, id);
    const runIri = captureRunIri(handle.iri, id);
    const remaining = (await readMeta(handle)).filter(q => {
        if (q.subject.termType === 'NamedNode' && (q.subject.value === variableIri || q.subject.value === runIri)) {
            return false;
        }
        // Die sosa:observes-Kante hat den Sensor als Subjekt und muss beim
        // Ersetzen trotzdem mitgehen — sonst bliebe sie nach dem Löschen
        // als Verweis auf eine verschwundene Variable stehen.
        return !(q.predicate.value === SOSA.observes && q.object.value === variableIri);
    });
    const next = view ? [...remaining, ...variableQuads(handle, view, metaGraph)] : remaining;
    await handle.store.load(next, metaGraph, { replace: true });
}

export interface CreateVariableInput {
    id: string;
    name: string;
    sourceKind: string;
    source: string;
    kind: ObservationKind;
    aggregation: Aggregation;
    intervalSeconds: number;
    unit?: string;
    placeIri?: string;
    sensorIri?: string;
    retentionDays?: number;
    enabled?: boolean;
}

export async function createVariable(handle: GraphHandle, input: CreateVariableInput): Promise<VariableView> {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(input.id)) {
        throw new Error(`Ungültige Variablen-ID "${input.id}" (erlaubt: Buchstaben, Ziffern, Bindestriche).`);
    }
    if (await getVariable(handle, input.id)) {
        throw new Error(`Variablen-ID "${input.id}" existiert bereits.`);
    }
    assertAggregationAllowed(input.kind, input.aggregation);
    if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < 10) {
        throw new Error('Abtastabstand muss eine ganze Zahl ab 10 Sekunden sein.');
    }
    const view: VariableView = {
        id: input.id,
        iri: variableIriFor(handle.iri, input.id),
        name: input.name,
        sourceKind: input.sourceKind,
        source: input.source,
        kind: input.kind,
        aggregation: input.aggregation,
        intervalSeconds: input.intervalSeconds,
        ...(input.unit ? { unit: input.unit } : {}),
        ...(input.placeIri ? { placeIri: input.placeIri } : {}),
        ...(input.sensorIri ? { sensorIri: input.sensorIri } : {}),
        enabled: input.enabled ?? true,
        retentionDays: input.retentionDays ?? 0,
        status: { state: 'idle', count: 0 },
    };
    await handle.store.transaction(async tx => {
        await replaceVariableNodes({ store: tx, iri: handle.iri }, input.id, view);
    });
    return view;
}

/** Speichert einen bestehenden Zustand (Erfassungslauf, Ein/Aus). */
export async function saveVariable(handle: GraphHandle, view: VariableView): Promise<void> {
    await handle.store.transaction(async tx => {
        await replaceVariableNodes({ store: tx, iri: handle.iri }, view.id, view);
    });
}

export type UpdateVariableInput = Partial<Pick<VariableDefinition, 'name' | 'enabled' | 'retentionDays' | 'aggregation'>>;

export async function updateVariable(
    handle: GraphHandle,
    id: string,
    patch: UpdateVariableInput,
): Promise<VariableView | null> {
    const existing = await getVariable(handle, id);
    if (!existing) return null;
    if (patch.aggregation) assertAggregationAllowed(existing.kind, patch.aggregation);
    const next: VariableView = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.retentionDays !== undefined ? { retentionDays: patch.retentionDays } : {}),
        ...(patch.aggregation !== undefined ? { aggregation: patch.aggregation } : {}),
    };
    await saveVariable(handle, next);
    return next;
}

/**
 * Entfernt die Definition. Der Bestand im Beobachtungs-Speicher wird
 * NICHT hier gelöscht — das entscheidet der Aufrufer bewusst (Route),
 * weil erfasste Jahre nicht durch einen Fehlklick verschwinden sollen.
 */
export async function deleteVariable(handle: GraphHandle, id: string): Promise<boolean> {
    if (!(await getVariable(handle, id))) return false;
    await handle.store.transaction(async tx => {
        await replaceVariableNodes({ store: tx, iri: handle.iri }, id, null);
    });
    return true;
}
