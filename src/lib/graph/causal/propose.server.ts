/**
 * Der serverseitige Anschluss der neurosymbolischen Schleife
 * (CAUSAL_LAYER_SPEC §8, Meilenstein C6).
 *
 * Alles Entscheidende liegt im puren Kern: die Filter in `filters.ts`, die
 * Prompts und Abbildungen in `propose.ts`, der Quellenvergleich in
 * `compare.ts`. Hier steht nur, was ohne Netz und Store nicht geht — der
 * Zuschnitt ist derselbe wie bei `study-run.server.ts` und
 * `schedule.server.ts`: eine dünne Schicht, die I/O hereinreicht.
 *
 * **Die Reihenfolge der Filter ist die aus §8, wörtlich**: Azyklizität,
 * SHACL, temporale Zulässigkeit, topologische Plausibilität,
 * Identifizierbarkeit. Der erste, der greift, entscheidet — SHACL steht
 * deshalb hier und nicht im puren Modul, weil es die Shapes aus
 * `graph/shapes` braucht.
 *
 * **Eine Quelle, die nicht antwortet, legt die anderen nicht still.**
 * Dieselbe Fehlerisolation wie bei der quellenagnostischen Erfassung (C5):
 * Ohne konfiguriertes Sprachmodell laufen Topologie und Wikidata weiter,
 * und was ausgefallen ist, steht im Bericht statt in einem Stacktrace.
 */

import type { Quad } from '@rdfjs/types';
import { streamProviderChat } from '@/lib/ai/client';
import { resolveDefaultServerProvider } from '@/lib/ai/store.server';
import type { GraphStore } from '../store/types';
import { factory, namedNode } from '../rdf';
import { resolveDataset } from '../sparql/protocol';
import { validateQuads } from '../reasoning/shacl';
import { listFederatedEndpoints } from '../federation/registry';
import { FederationError, remoteSelect } from '../federation/remote';
import { listVariables } from '../observations/variables';
import { OW, RDF, SCHEMA, SOSA, SPARQL_PREFIXES } from '../vocab';
import { readCausalModel, type GraphHandle } from './model';
import { dagFromModel } from './view';
import {
    checkAcyclic,
    checkIdentifiable,
    checkTemporal,
    checkTopology,
    type CoverageWindow,
    type FilterContext,
    type FilterOutcome,
    type TopologyInfo,
} from './filters';
import {
    EDGE_CLASS_OF_SOURCE,
    PROPOSAL_PROMPT_VERSION,
    PROPOSAL_SOURCE_LABEL,
    TOPOLOGY_PROCEDURE_VERSION,
    WIKIDATA_PROCEDURE_VERSION,
    buildProposalPrompt,
    buildWikidataQuery,
    parseProposalResponse,
    parseWikidataRows,
    proposeFromTopology,
    type ProposalHarvest,
    type ProposalSource,
    type ProposalVariable,
    type RawProposal,
    type TopologyFact,
} from './propose';
import {
    hypothesesGraph,
    hypothesisId,
    hypothesisQuads,
    replaceHypotheses,
    type HypothesisRecord,
} from './hypothesis';

/** Zeitbudget des Sprachmodell-Aufrufs. Ein Vorschlag ist keine Rechnung. */
const LLM_TIMEOUT_MS = 90_000;
/** Höchstzahl an Größen im Prompt — darüber wird er teuer und unscharf. */
const MAX_PROMPT_VARIABLES = 60;

// --- Kontext aus dem Graphen --------------------------------------------

interface ProposalContext {
    modelName: string;
    modelEdges: Array<{ from: string; to: string }>;
    variables: ProposalVariable[];
    /** Zusatzangaben je Variable, nur für Wikidata. */
    observableNames: Map<string, string>;
    coverage: Map<string, CoverageWindow>;
    topology: Map<string, TopologyInfo>;
    facts: TopologyFact[];
    filter: FilterContext;
}

function iriRef(value: string): string {
    return `<${value.replace(/[<>"{}|^`\\\s]/g, encodeURIComponent)}>`;
}

interface SensorFacts {
    actuator: boolean;
    deviceIri?: string;
    deviceName?: string;
    observableName?: string;
}

/**
 * Was die Registry über die Messquellen sagt. Sie liegt in den
 * Import-Graphen der Connectoren (C3/C5), also über dem Dataset des
 * Aufrufers — deshalb kommt es vom Resolver und nicht aus einer eigenen
 * Graph-Liste (§17.3).
 */
async function readSensorFacts(
    store: GraphStore,
    iri: GraphHandle['iri'],
    sensors: readonly string[],
    allowedGraphs?: readonly string[],
): Promise<Map<string, SensorFacts>> {
    const facts = new Map<string, SensorFacts>();
    if (sensors.length === 0) return facts;
    const dataset = await resolveDataset(store, iri, undefined, {
        ...(allowedGraphs ? { allowedGraphs: [...allowedGraphs] } : {}),
    });
    const values = sensors.map(iriRef).join(' ');
    const result = await store.query(`${SPARQL_PREFIXES}
        SELECT ?sensor ?actuator ?device ?deviceName ?observableName WHERE {
            VALUES ?sensor { ${values} }
            GRAPH ?g {
                { ?sensor a <${SOSA.Actuator}> . BIND(true AS ?actuator) }
                UNION
                { ?sensor a <${SOSA.Sensor}> . BIND(false AS ?actuator) }
                OPTIONAL {
                    ?sensor <${SOSA.isHostedBy}> ?device .
                    OPTIONAL { ?device <${SCHEMA.name}> ?deviceName }
                }
                OPTIONAL {
                    ?sensor <${SOSA.observes}> ?observable .
                    ?observable a <${SOSA.ObservableProperty}> ;
                                <${SCHEMA.name}> ?observableName .
                }
            }
        }`, {
        defaultGraphs: dataset.defaultGraphs,
        namedGraphs: dataset.namedGraphs,
        timeoutMs: 15_000,
        readOnly: true,
    });
    if (result.type !== 'bindings') return facts;
    for await (const row of result.bindings) {
        const sensor = row.sensor?.value;
        if (!sensor) continue;
        const existing = facts.get(sensor) ?? { actuator: false };
        facts.set(sensor, {
            actuator: existing.actuator || row.actuator?.value === 'true',
            ...(row.device?.value ? { deviceIri: row.device.value } : {}),
            ...(row.deviceName?.value ? { deviceName: row.deviceName.value } : existing.deviceName
                ? { deviceName: existing.deviceName }
                : {}),
            ...(row.observableName?.value
                ? { observableName: row.observableName.value }
                : existing.observableName ? { observableName: existing.observableName } : {}),
        });
    }
    return facts;
}

/** Orte samt Oberort — die Grundlage des Topologie-Filters. */
async function readPlaces(
    store: GraphStore,
    iri: GraphHandle['iri'],
    allowedGraphs?: readonly string[],
): Promise<Map<string, { name: string; parent?: string }>> {
    const places = new Map<string, { name: string; parent?: string }>();
    const dataset = await resolveDataset(store, iri, undefined, {
        ...(allowedGraphs ? { allowedGraphs: [...allowedGraphs] } : {}),
    });
    const result = await store.query(`${SPARQL_PREFIXES}
        SELECT ?place ?name ?parent WHERE {
            GRAPH ?g {
                ?place a <${SCHEMA.Place}> .
                OPTIONAL { ?place <${SCHEMA.name}> ?name }
                OPTIONAL { ?place <${SCHEMA.containedInPlace}> ?parent }
            }
        }`, {
        defaultGraphs: dataset.defaultGraphs,
        namedGraphs: dataset.namedGraphs,
        timeoutMs: 15_000,
        readOnly: true,
    });
    if (result.type !== 'bindings') return places;
    for await (const row of result.bindings) {
        const place = row.place?.value;
        if (!place) continue;
        places.set(place, {
            name: row.name?.value ?? place,
            ...(row.parent?.value ? { parent: row.parent.value } : {}),
        });
    }
    return places;
}

function placeChain(
    start: string | undefined,
    places: ReadonlyMap<string, { name: string; parent?: string }>,
): string[] {
    const chain: string[] = [];
    let current = start;
    // Ein Ort, der sich selbst enthält, ist ein Modellierungsfehler der
    // Quelle — er darf hier keine Endlosschleife auslösen.
    while (current && !chain.includes(current)) {
        chain.push(current);
        current = places.get(current)?.parent;
    }
    return chain;
}

export interface GatherOptions {
    allowedGraphs?: readonly string[];
}

/**
 * Trägt zusammen, was jede Quelle und jeder Filter braucht. Eine einzige
 * Stelle, damit LLM, Topologie und Wikidata nachweislich dieselbe Sicht
 * auf das Modell haben — sonst verglichen sie nicht dasselbe.
 */
export async function gatherProposalContext(
    handle: GraphHandle,
    modelId: string,
    options: GatherOptions = {},
): Promise<ProposalContext | null> {
    const model = await readCausalModel(handle, {
        modelId,
        graph: handle.iri.causalGraph(modelId),
    }, { withStudies: false });
    if (!model) return null;

    const captured = await listVariables(handle);
    const inModel = new Set(model.variables.filter(variable => variable.inModel).map(variable => variable.iri));
    const names = new Map(model.variables.map(variable => [variable.iri, variable.name]));

    const sensors = captured
        .map(variable => variable.sensorIri)
        .filter((value): value is string => value !== undefined);
    const [sensorFacts, places] = await Promise.all([
        readSensorFacts(handle.store, handle.iri, [...new Set(sensors)], options.allowedGraphs),
        readPlaces(handle.store, handle.iri, options.allowedGraphs),
    ]);
    for (const [place, entry] of places) names.set(place, entry.name);

    const variables: ProposalVariable[] = [];
    const observableNames = new Map<string, string>();
    const coverage = new Map<string, CoverageWindow>();
    const topology = new Map<string, TopologyInfo>();
    const facts: TopologyFact[] = [];

    for (const variable of captured) {
        names.set(variable.iri, variable.name);
        const sensor = variable.sensorIri ? sensorFacts.get(variable.sensorIri) : undefined;
        // Ortlos heißt global: Wetter, Strompreis, Sonnenstand und
        // Feiertag gelten überall und sind deshalb nie topologisch
        // unplausibel (C5).
        const chain = placeChain(variable.placeIri, places);
        topology.set(variable.iri, {
            ...(variable.placeIri ? { placeIri: variable.placeIri } : {}),
            ...(chain.length > 0 ? { placeChain: chain } : {}),
            global: chain.length === 0,
        });
        coverage.set(variable.iri, {
            ...(variable.status.capturedFrom ? { from: variable.status.capturedFrom } : {}),
            ...(variable.status.capturedThrough ? { through: variable.status.capturedThrough } : {}),
        });
        if (sensor?.observableName) observableNames.set(variable.iri, sensor.observableName);
        variables.push({
            iri: variable.iri,
            name: variable.name,
            ...(variable.unit ? { unit: variable.unit } : {}),
            kind: variable.kind,
            ...(chain.length > 0 ? { placeName: places.get(chain[0])?.name ?? '' } : {}),
            sourceKind: variable.sourceKind,
            inModel: inModel.has(variable.iri),
            observed: true,
        });
        facts.push({
            variableIri: variable.iri,
            name: variable.name,
            actuator: sensor?.actuator ?? false,
            ...(sensor?.deviceIri ? { deviceIri: sensor.deviceIri } : {}),
            ...(sensor?.deviceName ? { deviceName: sensor.deviceName } : {}),
            ...(variable.placeIri ? { placeIri: variable.placeIri } : {}),
            ...(chain.length > 0 ? { placeName: places.get(chain[0])?.name ?? '' } : {}),
        });
    }

    // Reine Modellvariablen (ohne Erfassung) gehören in den Prompt: Über
    // sie lässt sich nichts schätzen, aber sehr wohl etwas behaupten — und
    // genau das ist der Zweck eines DAG (Invariante C1).
    const known = new Set(variables.map(variable => variable.iri));
    for (const variable of model.variables) {
        if (known.has(variable.iri)) continue;
        variables.push({
            iri: variable.iri,
            name: variable.name,
            ...(variable.unit ? { unit: variable.unit } : {}),
            inModel: variable.inModel,
            observed: false,
        });
    }

    const { dag, observable } = dagFromModel(model);
    const label = (node: string) => names.get(node) ?? node;
    return {
        modelName: model.name,
        modelEdges: model.edges.map(edge => ({ from: edge.from, to: edge.to })),
        variables: variables.slice(0, MAX_PROMPT_VARIABLES),
        observableNames,
        coverage,
        topology,
        facts,
        filter: { dag, observable, coverage, topology, label },
    };
}

// --- Die drei Quellen ----------------------------------------------------

export interface SourceRun {
    source: ProposalSource;
    harvest: ProposalHarvest;
    /** Sprachmodell bzw. Verfahren, das geantwortet hat. */
    agentName: string;
    agentVersion: string;
    /** Gesetzt, wenn die Quelle gar nicht lief — ehrlich statt leer. */
    unavailable?: string;
}

function empty(source: ProposalSource, agentName: string, version: string, unavailable: string): SourceRun {
    return {
        source,
        harvest: { proposals: [], problems: [] },
        agentName,
        agentVersion: version,
        unavailable,
    };
}

/**
 * Quelle 1: das Sprachmodell. Ohne konfigurierten Provider gibt es
 * KEINE Vorschläge und keine Attrappe — die Oberfläche sagt, dass die
 * Quelle nicht verfügbar ist (Invariante 10).
 */
export async function runLlmSource(context: ProposalContext): Promise<SourceRun> {
    const resolved = await resolveDefaultServerProvider();
    if (!resolved) {
        return empty('llm', 'kein Provider', PROPOSAL_PROMPT_VERSION,
            'Kein Sprachmodell konfiguriert. Richte im AI-Hub (/ai) einen Provider ein — '
            + 'ohne ihn schlägt niemand etwas vor, und geraten wird hier nichts.');
    }
    const modelName = resolved.model
        ?? resolved.resolved.provider.defaultModel
        ?? resolved.resolved.provider.pinnedModels?.[0]
        ?? resolved.resolved.provider.label;

    const prompt = buildProposalPrompt(context.modelName, context.variables, context.modelEdges);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    let text = '';
    try {
        const stream = streamProviderChat(resolved.resolved, {
            ...(resolved.model ? { model: resolved.model } : {}),
            messages: [{ role: 'user', content: prompt }],
            // Vorschläge sollen reproduzierbar genug sein, um zweimal
            // hintereinander vergleichbar zu bleiben. Kreativität ist hier
            // nicht die Tugend — Abdeckung ist es.
            options: { temperature: 0.2 },
            signal: controller.signal,
        });
        for await (const event of stream) {
            if (event.type === 'text') text += event.text;
        }
    } catch (error) {
        return empty('llm', modelName, PROPOSAL_PROMPT_VERSION,
            `Das Sprachmodell hat nicht geantwortet: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        clearTimeout(timer);
    }
    return {
        source: 'llm',
        harvest: parseProposalResponse(text, context.variables),
        agentName: modelName,
        agentVersion: PROPOSAL_PROMPT_VERSION,
    };
}

/** Quelle 2: die Geräte-Topologie. Kein Netz, kein Modell, deterministisch. */
export function runTopologySource(context: ProposalContext): SourceRun {
    return {
        source: 'topology',
        harvest: proposeFromTopology(context.facts),
        agentName: 'Geräte-Registry (Home Assistant)',
        agentVersion: TOPOLOGY_PROCEDURE_VERSION,
    };
}

/** Ein registrierter Wikidata-Endpoint mit Vertrauensstufe über `unknown`. */
async function wikidataEndpoint(handle: GraphHandle): Promise<{ url: string; label: string } | null> {
    for (const endpoint of await listFederatedEndpoints(handle)) {
        if (endpoint.trustLevel === 'unknown') continue;
        if (!/wikidata\.org/i.test(endpoint.url)) continue;
        return { url: endpoint.url, label: endpoint.name };
    }
    return null;
}

export interface WikidataOptions {
    /** Test-Injektion; im Betrieb läuft der Aufruf über den SSRF-Guard. */
    fetchImpl?: typeof fetch;
}

/**
 * Quelle 3: Wikidata über die Föderation (M11) — ohne Import. Gefragt wird
 * nur nach Größen*arten*; über dieses Haus weiß Wikidata nichts, und der
 * Vorschlag durchläuft dieselben Filter wie jeder andere.
 */
export async function runWikidataSource(
    handle: GraphHandle,
    context: ProposalContext,
    options: WikidataOptions = {},
): Promise<SourceRun> {
    const endpoint = await wikidataEndpoint(handle);
    if (!endpoint) {
        return empty('wikidata', 'kein Endpoint', WIKIDATA_PROCEDURE_VERSION,
            'Kein Wikidata-Endpoint registriert (oder nur mit Vertrauensstufe „unbekannt"). '
            + 'Trag ihn unter Graph → Föderation ein — angefragt wird nur, was dort steht.');
    }
    const byLabel = new Map<string, ProposalVariable>();
    for (const variable of context.variables) {
        const observable = context.observableNames.get(variable.iri);
        if (!observable) continue;
        const label = observable.replace(/_/g, ' ').toLowerCase();
        if (label.length <= 2 || byLabel.has(label)) continue;
        byLabel.set(label, variable);
    }
    if (byLabel.size === 0) {
        return empty('wikidata', endpoint.label, WIKIDATA_PROCEDURE_VERSION,
            'Keine der Größen trägt eine Größenart (device_class), unter der sich Wikidata '
            + 'befragen ließe. Ohne sie gäbe es nur geratene Suchbegriffe.');
    }
    const query = buildWikidataQuery([...byLabel.keys()]);
    try {
        const result = await remoteSelect(endpoint.url, query, {
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
        const rows = result.rows.map(row =>
            Object.fromEntries(Object.entries(row).map(([key, term]) => [key, { value: term.value }])));
        const harvest = parseWikidataRows(rows, byLabel);
        if (harvest.proposals.length === 0) {
            harvest.problems.push('Wikidata kennt zwischen diesen Größenarten keine Ursache-Wirkung-Beziehung '
                + '(P828/P1542). Das ist eine Auskunft, kein Fehler.');
        }
        return { source: 'wikidata', harvest, agentName: endpoint.label, agentVersion: WIKIDATA_PROCEDURE_VERSION };
    } catch (error) {
        const message = error instanceof FederationError
            ? error.message
            : error instanceof Error ? error.message : String(error);
        return empty('wikidata', endpoint.label, WIKIDATA_PROCEDURE_VERSION,
            `Wikidata war nicht erreichbar: ${message}`);
    }
}

// --- Die Filterstrecke ---------------------------------------------------

async function shapesOf(handle: GraphHandle): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const quad of handle.store.dump(namedNode(handle.iri.sharedGraph('shapes')))) quads.push(quad);
    return quads;
}

/**
 * Filter 2 (§8): SHACL. Geprüft werden die Quads, die der Vorschlag
 * erzeugen WÜRDE — vor dem Schreiben, nicht danach. Ein Verstoß ist hier
 * anders als beim Altbestand des Editors (§7.2) blockierend: Einen
 * unförmigen Vorschlag gibt es nicht zu erhalten.
 */
function shaclOutcome(
    shapes: readonly Quad[],
    record: HypothesisRecord,
    quads: readonly Quad[],
): Promise<FilterOutcome | null> {
    return validateQuads([...shapes], [...quads]).then(report => {
        const violations = report.results.filter(result => result.severity === 'Violation');
        if (violations.length === 0) return null;
        return {
            verdict: 'rejected' as const,
            rejectedBy: 'shacl' as const,
            reason: `Der Vorschlag verstößt gegen die Shapes kausaler Kanten: `
                + `${violations.map(violation => violation.message).join(' ')} `
                + `(${record.source})`,
        };
    });
}

export interface ProposalRunOptions extends GatherOptions {
    sources?: readonly ProposalSource[];
    now?: Date;
    wikidata?: WikidataOptions;
}

export interface SourceSummary {
    source: ProposalSource;
    label: string;
    agentName: string;
    agentVersion: string;
    proposed: number;
    accepted: number;
    open: number;
    rejected: number;
    /** Quarantäne: was nicht lesbar war (Vorschlag für Vorschlag). */
    problems: string[];
    /** Gesetzt, wenn die Quelle gar nicht lief. */
    unavailable?: string;
}

export interface ProposalRunSummary {
    modelId: string;
    generatedAt: string;
    durationMs: number;
    sources: SourceSummary[];
}

/**
 * Ein Vorschlagslauf: Quellen befragen, filtern, schreiben.
 *
 * Der Rückgabewert zählt je Quelle, was durchkam und was nicht. Das ist
 * die Zahl, an der man sieht, ob eine Quelle trägt — §8 rechnet damit,
 * dass die Filter „einen erheblichen Teil des LLM-Rauschens ohne eine
 * einzige Schätzung" wegnehmen, und wer das behauptet, sollte es zeigen.
 */
export async function runProposalSources(
    handle: GraphHandle,
    modelId: string,
    options: ProposalRunOptions = {},
): Promise<ProposalRunSummary> {
    const started = Date.now();
    const generatedAt = (options.now ?? new Date()).toISOString();
    const context = await gatherProposalContext(handle, modelId, options);
    if (!context) throw new Error(`Kausalmodell „${modelId}" gibt es nicht.`);

    const wanted = options.sources ?? (['llm', 'topology', 'wikidata'] as const);
    const runs: SourceRun[] = [];
    if (wanted.includes('llm')) runs.push(await runLlmSource(context));
    if (wanted.includes('topology')) runs.push(runTopologySource(context));
    if (wanted.includes('wikidata')) {
        runs.push(await runWikidataSource(handle, context, options.wikidata ?? {}));
    }

    const shapes = await shapesOf(handle);
    const summaries: SourceSummary[] = [];
    for (const run of runs) {
        const records: HypothesisRecord[] = [];
        for (const proposal of run.harvest.proposals) {
            records.push(await judge(handle, context, shapes, run, proposal, generatedAt, modelId));
        }
        // Auch eine Quelle ohne Ergebnis schreibt: Ihr Replace räumt auf,
        // was sie beim letzten Mal gesagt hat und heute nicht mehr sagt.
        await replaceHypotheses(handle, modelId, run.source, records);
        summaries.push({
            source: run.source,
            label: PROPOSAL_SOURCE_LABEL[run.source],
            agentName: run.agentName,
            agentVersion: run.agentVersion,
            proposed: run.harvest.proposals.length,
            accepted: records.filter(record => record.verdict === 'accepted').length,
            open: records.filter(record => record.verdict === 'open').length,
            rejected: records.filter(record => record.verdict === 'rejected').length,
            problems: run.harvest.problems,
            ...(run.unavailable ? { unavailable: run.unavailable } : {}),
        });
    }

    return { modelId, generatedAt, durationMs: Date.now() - started, sources: summaries };
}

/** Ein Vorschlag durch die Filterstrecke — Reihenfolge exakt nach §8. */
async function judge(
    handle: GraphHandle,
    context: ProposalContext,
    shapes: readonly Quad[],
    run: SourceRun,
    proposal: RawProposal,
    generatedAt: string,
    modelId: string,
): Promise<HypothesisRecord> {
    const base: HypothesisRecord = {
        id: hypothesisId(modelId, run.source, proposal.from, proposal.to),
        modelId,
        source: run.source,
        from: proposal.from,
        to: proposal.to,
        edgeClass: EDGE_CLASS_OF_SOURCE[run.source],
        ...(proposal.temporalLag ? { temporalLag: proposal.temporalLag } : {}),
        verdict: 'accepted',
        reason: proposal.rationale,
        generatedAt,
        agentName: run.agentName,
        agentVersion: run.agentVersion,
    };
    const candidate = {
        from: proposal.from,
        to: proposal.to,
        ...(proposal.temporalLag ? { temporalLag: proposal.temporalLag } : {}),
    };

    const outcome = checkAcyclic(context.filter, candidate)
        ?? await shaclOutcome(shapes, base, quadsOf(handle, base))
        ?? checkTemporal(context.filter, candidate)
        ?? checkTopology(context.filter, candidate)
        ?? checkIdentifiable(context.filter, candidate);

    return {
        ...base,
        verdict: outcome.verdict,
        ...(outcome.rejectedBy ? { rejectedBy: outcome.rejectedBy } : {}),
        // Die Begründung der Quelle bleibt stehen — sie sagt, WARUM
        // vorgeschlagen wurde. Was die Filter dazu sagen, kommt dahinter.
        reason: `${proposal.rationale} ${outcome.reason}`.trim(),
    };
}

/**
 * Die Quads, die der Vorschlag erzeugen würde — plus die Typaussage der
 * beteiligten Größen. Ohne sie meldete `CausalEdgeSubjectShape` bei jedem
 * Vorschlag „keine ow:Variable", und das wäre ein Befund über den
 * Prüf-Ausschnitt, nicht über den Vorschlag.
 */
function quadsOf(handle: GraphHandle, record: HypothesisRecord): Quad[] {
    const graph = namedNode(hypothesesGraph(handle.iri));
    return [
        ...hypothesisQuads(handle.iri, record),
        ...[record.from, record.to].map(variable => factory.quad(
            namedNode(variable),
            namedNode(RDF.type),
            namedNode(OW.Variable),
            graph,
        )),
    ];
}
