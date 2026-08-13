/**
 * Kausalmodelle als Graph-Bürger (CAUSAL_LAYER_SPEC §5, Meilenstein C0).
 *
 * Ein Modell ist ein Named Graph: `graph/<u>/causal/<modelId>`. Darin
 * stehen der Modell-Knoten (`ow:CausalModel`), seine Variablen
 * (`ow:Variable`, per `schema:hasPart` zugeordnet) und die kausalen
 * Kanten. Die Kante selbst ist fremdes Vokabular
 * (`obo:RO_0002411 causally upstream of`, Invariante C8); alles über sie
 * — Herkunftsklasse, Zeitversatz, Belegstand — hängt als RDF-1.2-
 * Annotation am benannten Reifier (§5.3), nicht in einer Nebentabelle.
 *
 * Drei Dinge, die dieses Modul bewusst NICHT tut:
 *
 *  - **Es rechnet nicht.** Azyklizität, D-Separation, Backdoor-Kriterium
 *    und Adjustment Sets sind Meilenstein C1. Hier wird gelesen,
 *    geschrieben und dargestellt — was zyklisch modelliert wurde, wird
 *    als solches gezeigt, aber nicht bewertet.
 *  - **Es behauptet keine Effekte.** Effektstärken, Konfidenzintervalle
 *    und Refutationen entstehen erst in C4 und leben dann in
 *    `graph/<u>/inferred/causal/<scope>` (Invariante C4), nie hier.
 *  - **Es vermischt nichts.** Hypothesen liegen in einem eigenen Graphen
 *    (`graph/<u>/causal-hypotheses`) und werden getrennt gelesen, damit
 *    ein Vorschlag nie wie gesetzte Struktur aussieht (Invariante C2).
 */

import type { Quad, Term } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import { describeGraph, type IriFactory } from '../iri';
import { factory, literal, namedNode, typedLiteral } from '../rdf';
import { DCTERMS, OW, RDF, RO, SCHEMA, SPARQL_PREFIXES } from '../vocab';

export interface GraphHandle {
    store: GraphStore;
    iri: IriFactory;
}

/** Vier disjunkte Herkunftsklassen einer kausalen Kante (Invariante C2). */
export const EDGE_CLASSES = ['hypothesis', 'structural', 'learned', 'asserted'] as const;
export type EdgeClass = (typeof EDGE_CLASSES)[number];

/** Belegstand einer Kante (§9 `minEvidence`, Invariante C5). */
export const EVIDENCE_LEVELS = ['hypothesis', 'estimated', 'refuted-clean'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export interface CausalVariableView {
    iri: string;
    name: string;
    /** Einheit, quelltreu aus der Beobachtungsgröße (schema:unitText). */
    unit?: string;
    /** Ist die Variable dem Modell per schema:hasPart zugeordnet? */
    inModel: boolean;
    /**
     * Erfassung aus `graph/meta` (C3), falls die Variable dort als
     * Beobachtungsgröße geführt wird. Ohne Erfassung ist sie eine reine
     * Modellvariable — zulässig, aber später nicht schätzbar.
     */
    observation?: { count: number; from?: string; through?: string };
}

export interface CausalEdgeView {
    from: string;
    to: string;
    /** Reifier der Annotation; fehlt, wenn die Kante unannotiert ist. */
    reifier?: string;
    /** `null`, wenn die Kante keine (oder eine unbekannte) Klasse trägt. */
    edgeClass: EdgeClass | null;
    /** Roher Wert einer unbekannten Klasse — wird angezeigt, nicht geraten. */
    edgeClassRaw?: string;
    evidenceLevel: EvidenceLevel | null;
    evidenceLevelRaw?: string;
    /** ISO-8601-Dauer, quelltreu (`PT15M`). */
    temporalLag?: string;
}

export interface CausalModelView {
    id: string;
    iri: string;
    /** Named Graph des Modells — zugleich seine Modellgrenze. */
    graph: string;
    name: string;
    description?: string;
    created?: string;
    modified?: string;
    variables: CausalVariableView[];
    edges: CausalEdgeView[];
}

export interface CausalModelInput {
    id: string;
    name: string;
    description?: string;
    /** Variablen-IRIs, die dem Modell angehören (`schema:hasPart`). */
    variables?: readonly string[];
    edges?: readonly CausalEdgeInput[];
    created?: string;
    modified?: string;
}

export interface CausalEdgeInput {
    from: string;
    to: string;
    edgeClass: EdgeClass;
    evidenceLevel?: EvidenceLevel;
    temporalLag?: string;
}

/** IDs sind Dateinamen-tauglich und IRI-arm — dieselbe Regel wie sonst. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertModelId(id: string): void {
    if (!ID_PATTERN.test(id)) {
        throw new Error(
            `Ungültige Modell-Kennung "${id}": erlaubt sind Kleinbuchstaben, Ziffern und ` +
            'Bindestriche (1–64 Zeichen, Beginn mit Buchstabe oder Ziffer).',
        );
    }
}

export function causalModelIri(iri: IriFactory, id: string): string {
    return iri.entity('causal-model', id);
}

/**
 * Reifier einer kausalen Kante. Die IRI ist aus der Kante abgeleitet und
 * damit stabil: dieselbe Kante bekommt beim Neuschreiben denselben
 * Reifier, und ein Modell bleibt byte-gleich serialisierbar. Für das
 * Lesen ist die Form egal — gesucht wird über `rdf:reifies`.
 */
export function causalEdgeReifier(iri: IriFactory, modelId: string, from: string, to: string): string {
    return iri.entity('link', `causal/${modelId}/${lastSegment(from)}/${lastSegment(to)}`);
}

function lastSegment(iriValue: string): string {
    const withoutFragment = iriValue.split('#').pop() ?? iriValue;
    return withoutFragment.split('/').filter(Boolean).pop() ?? withoutFragment;
}

// --- Mapping Modell → Quads ---------------------------------------------

/**
 * Reines Mapping (ohne Store): Modell → Quads seines Named Graphen.
 * Deterministisch, damit zweimal Schreiben denselben Snapshot ergibt.
 */
export function causalModelQuads(iri: IriFactory, input: CausalModelInput): Quad[] {
    assertModelId(input.id);
    const graph = namedNode(iri.causalGraph(input.id));
    const subject = namedNode(causalModelIri(iri, input.id));
    const quads: Quad[] = [
        factory.quad(subject, namedNode(RDF.type), namedNode(OW.CausalModel), graph),
        factory.quad(subject, namedNode(SCHEMA.name), literal(input.name), graph),
        factory.quad(subject, namedNode(DCTERMS.identifier), literal(input.id), graph),
    ];
    if (input.description) {
        quads.push(factory.quad(subject, namedNode(SCHEMA.description), literal(input.description), graph));
    }
    if (input.created) {
        quads.push(factory.quad(subject, namedNode(DCTERMS.created), typedLiteral.dateTime(input.created), graph));
    }
    if (input.modified) {
        quads.push(factory.quad(subject, namedNode(DCTERMS.modified), typedLiteral.dateTime(input.modified), graph));
    }
    for (const variable of [...new Set(input.variables ?? [])].sort()) {
        quads.push(
            factory.quad(subject, namedNode(SCHEMA.hasPart), namedNode(variable), graph),
            factory.quad(namedNode(variable), namedNode(RDF.type), namedNode(OW.Variable), graph),
        );
    }
    for (const edge of input.edges ?? []) {
        const triple = factory.quad(namedNode(edge.from), namedNode(RO.causallyUpstreamOf), namedNode(edge.to));
        const reifier = namedNode(causalEdgeReifier(iri, input.id, edge.from, edge.to));
        quads.push(
            factory.quad(triple.subject, triple.predicate, triple.object, graph),
            factory.quad(reifier, namedNode(RDF.reifies), triple, graph),
            factory.quad(reifier, namedNode(OW.edgeClass), literal(edge.edgeClass), graph),
        );
        // Ohne ausdrückliche Angabe ist eine Kante behauptet, nicht
        // belegt. Das Schweigen zur Evidenz wäre die gefährlichere
        // Voreinstellung (Invariante C5).
        quads.push(factory.quad(
            reifier,
            namedNode(OW.evidenceLevel),
            literal(edge.evidenceLevel ?? 'hypothesis'),
            graph,
        ));
        if (edge.temporalLag) {
            quads.push(factory.quad(reifier, namedNode(OW.temporalLag), typedLiteral.duration(edge.temporalLag), graph));
        }
    }
    return quads;
}

// --- Graph-Bestand -------------------------------------------------------

export interface CausalGraphRef {
    modelId: string;
    graph: string;
}

/**
 * Kausalmodell-Graphen einer Graph-Menge. Fremde Nutzer bleiben draußen —
 * die Fabrik gehört dem anfragenden Nutzer, und ein Modell eines anderen
 * Nutzers ist über den Grant erreichbar, nicht über diese Liste.
 */
export function causalGraphsOf(iri: IriFactory, existing: readonly string[]): CausalGraphRef[] {
    const refs: CausalGraphRef[] = [];
    for (const graph of existing) {
        const described = describeGraph(iri.instanceBase, graph);
        if (!described || described.kind !== 'user' || described.userId !== iri.userId) continue;
        if (!described.scope.startsWith('causal/')) continue;
        const modelId = described.scope.slice('causal/'.length);
        if (modelId === '' || modelId.includes('/')) continue;
        refs.push({ modelId, graph });
    }
    return refs.sort((a, b) => a.modelId.localeCompare(b.modelId, 'de'));
}

// --- SPARQL-Lesepfad -----------------------------------------------------

async function selectRows(
    handle: GraphHandle,
    sparql: string,
    graphs: readonly string[],
): Promise<Array<Record<string, Term>>> {
    if (graphs.length === 0) return [];
    const dataset = graphs.map(namedNode);
    const result = await handle.store.query(sparql, { defaultGraphs: dataset, namedGraphs: dataset });
    if (result.type !== 'bindings') return [];
    const rows: Array<Record<string, Term>> = [];
    for await (const row of result.bindings) rows.push(row);
    return rows;
}

function iriRef(value: string): string {
    return `<${value.replace(/[<>"{}|^`\\\s]/g, encodeURIComponent)}>`;
}

/**
 * Kanten eines Graphen samt Annotation. Die Annotation ist OPTIONAL:
 * eine Kante ohne Klasse ist ein Mangel, den die Oberfläche zeigen soll —
 * sie darf nicht dazu führen, dass die Kante unsichtbar wird.
 */
async function readEdges(handle: GraphHandle, graph: string): Promise<CausalEdgeView[]> {
    const rows = await selectRows(handle, `${SPARQL_PREFIXES}
        SELECT ?from ?to ?reifier ?class ?evidence ?lag WHERE {
            GRAPH ${iriRef(graph)} {
                ?from <${RO.causallyUpstreamOf}> ?to .
                OPTIONAL {
                    ?reifier <${RDF.reifies}> <<( ?from <${RO.causallyUpstreamOf}> ?to )>> .
                    OPTIONAL { ?reifier <${OW.edgeClass}> ?class }
                    OPTIONAL { ?reifier <${OW.evidenceLevel}> ?evidence }
                    OPTIONAL { ?reifier <${OW.temporalLag}> ?lag }
                }
            }
        } ORDER BY ?from ?to`, [graph]);
    return rows.map(row => {
        const classRaw = row.class?.value;
        const evidenceRaw = row.evidence?.value;
        const known = (EDGE_CLASSES as readonly string[]).includes(classRaw ?? '');
        const knownEvidence = (EVIDENCE_LEVELS as readonly string[]).includes(evidenceRaw ?? '');
        return {
            from: row.from.value,
            to: row.to.value,
            ...(row.reifier ? { reifier: row.reifier.value } : {}),
            edgeClass: known ? (classRaw as EdgeClass) : null,
            ...(classRaw !== undefined && !known ? { edgeClassRaw: classRaw } : {}),
            evidenceLevel: knownEvidence ? (evidenceRaw as EvidenceLevel) : null,
            ...(evidenceRaw !== undefined && !knownEvidence ? { evidenceLevelRaw: evidenceRaw } : {}),
            ...(row.lag ? { temporalLag: row.lag.value } : {}),
        };
    });
}

/**
 * Variablen eines Modells: die zugeordneten (`schema:hasPart`) und die,
 * die nur an einer Kante hängen. Letztere werden mitgeführt und als
 * `inModel: false` markiert — verschweigen wäre ein stiller Verlust.
 * Namen und Einheiten kommen aus dem Modell-Graphen ODER aus `graph/meta`
 * (dort liegen die erfassten Größen, C3).
 */
async function readVariables(
    handle: GraphHandle,
    graph: string,
    modelIri: string,
    edges: readonly CausalEdgeView[],
): Promise<CausalVariableView[]> {
    const metaGraph = handle.iri.sharedGraph('meta');
    const partRows = await selectRows(handle, `${SPARQL_PREFIXES}
        SELECT ?variable WHERE {
            GRAPH ${iriRef(graph)} { ${iriRef(modelIri)} <${SCHEMA.hasPart}> ?variable }
        }`, [graph]);
    const inModel = new Set(partRows.map(row => row.variable.value));
    const all = new Set<string>([...inModel]);
    for (const edge of edges) {
        all.add(edge.from);
        all.add(edge.to);
    }
    if (all.size === 0) return [];

    const byIri = new Map<string, CausalVariableView>();
    for (const variable of all) {
        byIri.set(variable, { iri: variable, name: lastSegment(variable), inModel: inModel.has(variable) });
    }

    // Zwei Abfragen statt einer über beide Graphen: So ist die Rangfolge
    // festgelegt statt der Reihenfolge des Stores überlassen. Was das
    // Modell über eine Variable sagt, gilt vor dem, was die Erfassung
    // sagt — das Modell ist der Ort, an dem der Mensch benennt.
    const values = [...all].map(iriRef).join(' ');
    const describe = async (target: string) => selectRows(handle, `${SPARQL_PREFIXES}
        SELECT ?variable ?name ?unit ?count ?from ?through WHERE {
            VALUES ?variable { ${values} }
            GRAPH ${iriRef(target)} {
                { ?variable <${SCHEMA.name}> ?name }
                UNION { ?variable <${SCHEMA.unitText}> ?unit }
                UNION { ?variable <${OW.observationCount}> ?count }
                UNION { ?variable <${OW.capturedFrom}> ?from }
                UNION { ?variable <${OW.capturedThrough}> ?through }
            }
        }`, [target]);

    for (const target of [metaGraph, graph]) {
        for (const row of await describe(target)) {
            const view = byIri.get(row.variable.value);
            if (!view) continue;
            if (row.name) view.name = row.name.value;
            if (row.unit) view.unit = row.unit.value;
            // Erfassungsangaben kommen aus mehreren Zeilen (UNION) und in
            // beliebiger Reihenfolge — der Träger entsteht deshalb bei der
            // ersten von ihnen, nicht erst beim Zähler.
            if (row.count || row.from || row.through) {
                const observation = view.observation ?? { count: 0 };
                if (row.count) {
                    const count = Number.parseInt(row.count.value, 10);
                    observation.count = Number.isFinite(count) ? count : 0;
                }
                if (row.from) observation.from = row.from.value;
                if (row.through) observation.through = row.through.value;
                view.observation = observation;
            }
        }
    }
    return [...byIri.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export interface ListOptions {
    /** Verengung durch den Grant (§17.3) — kann nur wegnehmen. */
    allowedGraphs?: readonly string[];
}

/** Ein Modell samt Variablen und Kanten; `null`, wenn es den Knoten nicht gibt. */
export async function readCausalModel(
    handle: GraphHandle,
    ref: CausalGraphRef,
): Promise<CausalModelView | null> {
    const rows = await selectRows(handle, `${SPARQL_PREFIXES}
        SELECT ?model ?name ?description ?created ?modified WHERE {
            GRAPH ${iriRef(ref.graph)} {
                ?model a <${OW.CausalModel}> .
                OPTIONAL { ?model <${SCHEMA.name}> ?name }
                OPTIONAL { ?model <${SCHEMA.description}> ?description }
                OPTIONAL { ?model <${DCTERMS.created}> ?created }
                OPTIONAL { ?model <${DCTERMS.modified}> ?modified }
            }
        } ORDER BY ?model LIMIT 1`, [ref.graph]);
    const row = rows[0];
    if (!row) return null;
    const modelIri = row.model.value;
    const edges = await readEdges(handle, ref.graph);
    return {
        id: ref.modelId,
        iri: modelIri,
        graph: ref.graph,
        name: row.name?.value ?? ref.modelId,
        ...(row.description ? { description: row.description.value } : {}),
        ...(row.created ? { created: row.created.value } : {}),
        ...(row.modified ? { modified: row.modified.value } : {}),
        variables: await readVariables(handle, ref.graph, modelIri, edges),
        edges,
    };
}

export async function listCausalModels(
    handle: GraphHandle,
    options: ListOptions = {},
): Promise<CausalModelView[]> {
    const existing = (await handle.store.graphs()).map(g => g.value);
    const allowed = options.allowedGraphs ? new Set(options.allowedGraphs) : null;
    const refs = causalGraphsOf(handle.iri, existing)
        .filter(ref => !allowed || allowed.has(ref.graph));
    const models: CausalModelView[] = [];
    for (const ref of refs) {
        const model = await readCausalModel(handle, ref);
        if (model) models.push(model);
    }
    return models;
}

/**
 * Hypothesen (Invariante C2): dieselbe Kantenform, aber aus dem eigenen
 * Graphen und ohne Modellzugehörigkeit. Bis C6 füllt sie niemand
 * automatisch — was hier steht, hat ein Mensch hineingeschrieben.
 */
export async function listCausalHypotheses(
    handle: GraphHandle,
    options: ListOptions = {},
): Promise<CausalEdgeView[]> {
    const graph = handle.iri.graph('causal-hypotheses');
    if (options.allowedGraphs && !options.allowedGraphs.includes(graph)) return [];
    const existing = (await handle.store.graphs()).map(g => g.value);
    if (!existing.includes(graph)) return [];
    return readEdges(handle, graph);
}

// --- Schreibpfad ---------------------------------------------------------

/**
 * Legt ein Modell an: ein leerer Named Graph mit genau einem Knoten. Die
 * Struktur selbst schreibt der Mensch (SPARQL-Editor) — C0 liefert
 * bewusst keinen DAG-Editor, sondern die Ansicht. Ohne diesen Schritt
 * gäbe es allerdings keinen Graphen, in den er schreiben könnte: ein
 * SPARQL-Update darf keine neuen Graphen außerhalb des vorhandenen
 * Bestands anlegen (§17.3).
 */
export async function createCausalModel(
    handle: GraphHandle,
    input: { id: string; name: string; description?: string; now?: Date },
): Promise<CausalModelView> {
    assertModelId(input.id);
    const graph = handle.iri.causalGraph(input.id);
    const existing = (await handle.store.graphs()).map(g => g.value);
    if (existing.includes(graph)) {
        throw new Error(`Ein Kausalmodell mit der Kennung "${input.id}" existiert bereits.`);
    }
    const now = (input.now ?? new Date()).toISOString();
    const quads = causalModelQuads(handle.iri, {
        id: input.id,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        created: now,
        modified: now,
    });
    await handle.store.load(quads, namedNode(graph), { replace: true });
    const model = await readCausalModel(handle, { modelId: input.id, graph });
    if (!model) throw new Error('Das Kausalmodell konnte nach dem Anlegen nicht gelesen werden.');
    return model;
}

/**
 * Entfernt ein Modell vollständig — der Graph ist die Modellgrenze, also
 * genügt sein Ersetzen durch nichts. Beobachtungsgrößen bleiben
 * unangetastet: sie leben in `graph/meta` und gehören keinem Modell.
 */
export async function deleteCausalModel(handle: GraphHandle, id: string): Promise<boolean> {
    assertModelId(id);
    const graph = handle.iri.causalGraph(id);
    const existing = (await handle.store.graphs()).map(g => g.value);
    if (!existing.includes(graph)) return false;
    await handle.store.load([], namedNode(graph), { replace: true });
    return true;
}
