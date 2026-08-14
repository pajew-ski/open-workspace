/**
 * Vorschläge als Graph-Bürger (CAUSAL_LAYER_SPEC §5.1/§8, Meilenstein C6).
 *
 * Ein Vorschlag ist **keine neue Art von Ding**: Er ist dieselbe kausale
 * Kante wie im Modell (`obo:RO_0002411`, Invariante C8), nur in
 * `graph/<u>/causal-hypotheses` statt in einem Modell-Graphen. Genau diese
 * Trennung ist Invariante C2 in ihrer wörtlichen Form: „Eine Hypothese
 * sieht in der UI niemals aus wie ein bestätigter Effekt" — sie kann es
 * nicht, weil sie nicht im Modell steht und deshalb weder in die
 * Identifikation (C1) noch in eine Studie (C4) eingeht.
 *
 * **Ein Reifier je Quelle, nicht je Kante.** Schlagen Sprachmodell und
 * Geräte-Topologie dieselbe Kante vor, entstehen zwei benannte Reifier auf
 * DASSELBE Triple. Dafür gibt es benannte Reifier in RDF 1.2, und daraus
 * entsteht der Quellenvergleich aus §8 ohne eine einzige Nebentabelle:
 * Übereinstimmung ist mehr als ein Reifier auf einem Triple, Widerspruch
 * sind Reifier auf beiden Richtungen.
 *
 * **Herkunft ist Pflicht, nicht Zierde.** §8 verlangt die Zuschreibung
 * „auf Modell und Prompt-Version". Beides steht an einem
 * `prov:SoftwareAgent`: die Quellart als `dcterms:identifier`, das
 * benutzte Sprachmodell (oder das Verfahren) als `schema:name`, die
 * Prompt-Version als `schema:softwareVersion`. Ein Vorschlag ohne diesen
 * Agenten fällt durch die Shapes — er wäre nicht mehr zuzuordnen, sobald
 * jemand die Modellwahl ändert.
 *
 * **Ein Lauf ersetzt seine eigene Quelle, nicht die anderen.** Dasselbe
 * Muster wie beim Connector-Import (§6.2): Wer nur das Sprachmodell laufen
 * lässt, verliert die topologischen Vorschläge nicht.
 */

import type { Quad } from '@rdfjs/types';
import type { IriFactory } from '../iri';
import { factory, literal, namedNode, typedLiteral } from '../rdf';
import { DCTERMS, OW, PROV, RDF, RO, SCHEMA } from '../vocab';
import { EDGE_CLASSES, type CausalEdgeView, type EdgeClass } from './types';
import {
    HYPOTHESIS_FILTERS,
    HYPOTHESIS_VERDICTS,
    mayAdopt,
    type HypothesisFilter,
    type HypothesisVerdict,
} from './filters';
import { PROPOSAL_SOURCES, type ProposalSource } from './propose';
import { applyStructureOperation, CausalEditError, type EditContext } from './edit';
import { causalModelIri, readCausalModel, type GraphHandle } from './model';

/** `graph/<u>/causal-hypotheses` — behauptet, persistiert, im Snapshot. */
export function hypothesesGraph(iri: IriFactory): string {
    return iri.graph('causal-hypotheses');
}

function lastSegment(value: string): string {
    const withoutFragment = value.split('#').pop() ?? value;
    const segment = withoutFragment.split('/').filter(Boolean).pop() ?? withoutFragment;
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/**
 * Adresse eines Vorschlags: Modell, Quelle, Ursache, Wirkung — mit `~`
 * getrennt, weil das Zeichen in IRIs unreserviert ist und in keiner
 * Variablen-Kennung vorkommt (die sind auf `[a-z0-9-]` beschränkt).
 * Derselbe Vorschlag bekommt so beim zweiten Lauf dieselbe Adresse, und
 * der Snapshot bleibt byte-gleich.
 */
export function hypothesisId(
    modelId: string,
    source: string,
    from: string,
    to: string,
): string {
    return [modelId, source, lastSegment(from), lastSegment(to)].join('~');
}

export function hypothesisIri(iri: IriFactory, id: string): string {
    return iri.entity('link', `hypothesis/${id}`);
}

/** Der vorschlagende Agent — je Modell und Quelle einer. */
export function proposalAgentIri(iri: IriFactory, modelId: string, source: string): string {
    return iri.entity('agent', `causal/${modelId}/${source}`);
}

/** Ein Vorschlag, wie er in den Graphen geht. */
export interface HypothesisRecord {
    id: string;
    modelId: string;
    source: ProposalSource;
    from: string;
    to: string;
    edgeClass: EdgeClass;
    temporalLag?: string;
    verdict: HypothesisVerdict;
    rejectedBy?: HypothesisFilter;
    /** Begründung: warum vorgeschlagen — und was die Filter dazu sagen. */
    reason: string;
    generatedAt: string;
    /** Sprachmodell bzw. Verfahren, das vorgeschlagen hat. */
    agentName: string;
    /** Prompt- bzw. Verfahrensversion (§8). */
    agentVersion: string;
}

/** Ein Vorschlag, wie ihn die Oberfläche sieht. */
export interface HypothesisView extends HypothesisRecord {
    iri: string;
    modelIri: string;
    fromName: string;
    toName: string;
    /** Steht die Kante inzwischen im Modell? Beim Lesen abgeleitet. */
    inModel: boolean;
    /** Größen, deren Erfassung den Effekt schätzbar machen würde. */
    missingVariables?: string[];
}

// --- Mapping Vorschlag → Quads ------------------------------------------

/**
 * Reines Mapping, deterministisch (zweimal schreiben = derselbe
 * Snapshot). Der Agent-Knoten wird mitgeschrieben: Er gehört zum
 * Vorschlag und darf nicht in `graph/meta` landen, wo er neben den
 * A2A-Agenten aus M9 stünde und wie einer aussähe.
 */
export function hypothesisQuads(iri: IriFactory, record: HypothesisRecord): Quad[] {
    const graph = namedNode(hypothesesGraph(iri));
    const triple = factory.quad(
        namedNode(record.from),
        namedNode(RO.causallyUpstreamOf),
        namedNode(record.to),
    );
    const reifier = namedNode(hypothesisIri(iri, record.id));
    const agent = namedNode(proposalAgentIri(iri, record.modelId, record.source));
    const quads: Quad[] = [
        factory.quad(triple.subject, triple.predicate, triple.object, graph),
        factory.quad(reifier, namedNode(RDF.reifies), triple, graph),
        factory.quad(reifier, namedNode(DCTERMS.identifier), literal(record.id), graph),
        factory.quad(reifier, namedNode(OW.edgeClass), literal(record.edgeClass), graph),
        // Ein Vorschlag ist unbelegt, immer. Die Evidenzstufe steht
        // trotzdem da: Schweigen wäre die gefährlichere Voreinstellung
        // (Invariante C5), und die Shapes verlangen sie neben der Klasse.
        factory.quad(reifier, namedNode(OW.evidenceLevel), literal('hypothesis'), graph),
        factory.quad(reifier, namedNode(SCHEMA.isPartOf), namedNode(causalModelIri(iri, record.modelId)), graph),
        factory.quad(reifier, namedNode(OW.hypothesisVerdict), literal(record.verdict), graph),
        factory.quad(reifier, namedNode(SCHEMA.description), literal(record.reason, 'de'), graph),
        factory.quad(reifier, namedNode(PROV.wasAttributedTo), agent, graph),
        factory.quad(reifier, namedNode(PROV.generatedAtTime), typedLiteral.dateTime(record.generatedAt), graph),
        factory.quad(agent, namedNode(RDF.type), namedNode(PROV.SoftwareAgent), graph),
        factory.quad(agent, namedNode(DCTERMS.identifier), literal(record.source), graph),
        factory.quad(agent, namedNode(SCHEMA.name), literal(record.agentName), graph),
        factory.quad(agent, namedNode(SCHEMA.softwareVersion), literal(record.agentVersion), graph),
    ];
    if (record.temporalLag) {
        quads.push(factory.quad(
            reifier,
            namedNode(OW.temporalLag),
            typedLiteral.duration(record.temporalLag),
            graph,
        ));
    }
    if (record.rejectedBy) {
        quads.push(factory.quad(reifier, namedNode(OW.filterRejectedBy), literal(record.rejectedBy), graph));
    }
    return quads;
}

// --- Lesepfad ------------------------------------------------------------

async function dumpHypotheses(handle: GraphHandle): Promise<Quad[]> {
    const graph = hypothesesGraph(handle.iri);
    const existing = (await handle.store.graphs()).map(g => g.value);
    if (!existing.includes(graph)) return [];
    const quads: Quad[] = [];
    for await (const quad of handle.store.dump(namedNode(graph))) quads.push(quad);
    return quads;
}

function bySubject(quads: readonly Quad[]): Map<string, Quad[]> {
    const map = new Map<string, Quad[]>();
    for (const quad of quads) {
        if (quad.subject.termType !== 'NamedNode') continue;
        const list = map.get(quad.subject.value);
        if (list) list.push(quad);
        else map.set(quad.subject.value, [quad]);
    }
    return map;
}

export interface ReadHypothesesOptions {
    /** Verengung durch den Grant (§17.3) — kann nur wegnehmen. */
    allowedGraphs?: readonly string[];
    modelId?: string;
}

/**
 * Alle Vorschläge mit Namen und Modellbezug. Die Namen kommen aus dem
 * Modell-Graphen bzw. `graph/meta` — ein Vorschlag über „variable/aussen"
 * wäre sonst unlesbar, und Lesbarkeit ist bei einer Liste, die ein Mensch
 * abarbeiten soll, kein Luxus.
 */
export async function readHypotheses(
    handle: GraphHandle,
    options: ReadHypothesesOptions = {},
): Promise<HypothesisView[]> {
    const graph = hypothesesGraph(handle.iri);
    if (options.allowedGraphs && !options.allowedGraphs.includes(graph)) return [];
    const quads = await dumpHypotheses(handle);
    if (quads.length === 0) return [];
    const subjects = bySubject(quads);
    const valueOf = (subject: string, predicate: string): string | undefined =>
        (subjects.get(subject) ?? []).find(quad => quad.predicate.value === predicate)?.object.value;

    // Namen einmal für alle: Modelle liegen je in ihrem Graphen, und
    // zweimal dasselbe zu lesen wäre bei zwanzig Vorschlägen zwanzig
    // Abfragen zu viel.
    const names = new Map<string, string>();
    const modelEdges = new Map<string, Set<string>>();
    const modelIds = new Set<string>();
    for (const [subject, own] of subjects) {
        if (!own.some(quad => quad.predicate.value === OW.hypothesisVerdict)) continue;
        const partOf = valueOf(subject, SCHEMA.isPartOf);
        const modelId = partOf ? lastSegment(partOf) : undefined;
        if (modelId) modelIds.add(modelId);
    }
    for (const modelId of modelIds) {
        const modelGraph = handle.iri.causalGraph(modelId);
        // Der Grant klammert auch hier (§17.3): Ein Modell, das der
        // Aufrufer nicht lesen darf, liefert keine Namen — der Vorschlag
        // bleibt sichtbar, aber mit der nackten Kennung statt mit
        // Variablennamen, die aus einem gesperrten Graphen stammen.
        if (options.allowedGraphs && !options.allowedGraphs.includes(modelGraph)) continue;
        const model = await readCausalModel(handle, {
            modelId,
            graph: modelGraph,
        }, { withStudies: false });
        if (!model) continue;
        for (const variable of model.variables) names.set(variable.iri, variable.name);
        modelEdges.set(modelId, new Set(model.edges.map(edge => `${edge.from} ${edge.to}`)));
    }

    const views: HypothesisView[] = [];
    for (const [subject, own] of subjects) {
        const verdictRaw = own.find(quad => quad.predicate.value === OW.hypothesisVerdict)?.object.value;
        if (!verdictRaw) continue;
        const reifies = own.find(quad => quad.predicate.value === RDF.reifies)?.object;
        if (!reifies || reifies.termType !== 'Quad') continue;
        const from = reifies.subject.value;
        const to = reifies.object.value;
        const modelIri = valueOf(subject, SCHEMA.isPartOf) ?? '';
        const modelId = modelIri ? lastSegment(modelIri) : '';
        if (options.modelId && modelId !== options.modelId) continue;

        const agentIri = valueOf(subject, PROV.wasAttributedTo);
        const sourceRaw = agentIri ? valueOf(agentIri, DCTERMS.identifier) : undefined;
        const edgeClassRaw = valueOf(subject, OW.edgeClass) ?? 'hypothesis';
        const rejectedRaw = valueOf(subject, OW.filterRejectedBy);
        views.push({
            id: valueOf(subject, DCTERMS.identifier) ?? lastSegment(subject),
            iri: subject,
            modelId,
            modelIri,
            source: ((PROPOSAL_SOURCES as readonly string[]).includes(sourceRaw ?? '')
                ? sourceRaw
                : 'llm') as ProposalSource,
            from,
            to,
            fromName: names.get(from) ?? lastSegment(from),
            toName: names.get(to) ?? lastSegment(to),
            edgeClass: ((EDGE_CLASSES as readonly string[]).includes(edgeClassRaw)
                ? edgeClassRaw
                : 'hypothesis') as EdgeClass,
            ...(valueOf(subject, OW.temporalLag) ? { temporalLag: valueOf(subject, OW.temporalLag) as string } : {}),
            verdict: ((HYPOTHESIS_VERDICTS as readonly string[]).includes(verdictRaw)
                ? verdictRaw
                : 'rejected') as HypothesisVerdict,
            ...(rejectedRaw && (HYPOTHESIS_FILTERS as readonly string[]).includes(rejectedRaw)
                ? { rejectedBy: rejectedRaw as HypothesisFilter }
                : {}),
            reason: valueOf(subject, SCHEMA.description) ?? '',
            generatedAt: valueOf(subject, PROV.generatedAtTime) ?? '',
            agentName: (agentIri ? valueOf(agentIri, SCHEMA.name) : undefined) ?? 'unbekannt',
            agentVersion: (agentIri ? valueOf(agentIri, SCHEMA.softwareVersion) : undefined) ?? 'unbekannt',
            inModel: modelEdges.get(modelId)?.has(`${from} ${to}`) ?? false,
        });
    }

    // Verworfene zuletzt: Die Liste ist eine Arbeitsliste, und was
    // durchgefallen ist, arbeitet niemand ab.
    const order: Record<HypothesisVerdict, number> = { accepted: 0, open: 1, rejected: 2 };
    return views.sort((a, b) =>
        order[a.verdict] - order[b.verdict]
        || a.fromName.localeCompare(b.fromName, 'de')
        || a.toName.localeCompare(b.toName, 'de'));
}

export async function getHypothesis(handle: GraphHandle, id: string): Promise<HypothesisView | null> {
    return (await readHypotheses(handle)).find(view => view.id === id) ?? null;
}

// --- Schreibpfad ---------------------------------------------------------

/**
 * Ein Triple ohne Reifier ist im Hypothesen-Graphen eine herkunftslose
 * Behauptung — und genau die verbietet Invariante C2. Sobald die letzte
 * Quelle einen Vorschlag zurückzieht, verschwindet deshalb auch das
 * Triple.
 */
function pruneOrphanEdges(quads: readonly Quad[]): Quad[] {
    const reified = new Set<string>();
    for (const quad of quads) {
        if (quad.predicate.value !== RDF.reifies || quad.object.termType !== 'Quad') continue;
        reified.add(`${quad.object.subject.value} ${quad.object.object.value}`);
    }
    return quads.filter(quad => quad.predicate.value !== RO.causallyUpstreamOf
        || reified.has(`${quad.subject.value} ${quad.object.value}`));
}

/**
 * Ersetzt die Vorschläge EINER Quelle für EIN Modell. Dieselbe Regel wie
 * beim Connector-Lauf (§6.2): vollständiger Replace des eigenen Bereichs,
 * fremde Bereiche bleiben unberührt. Wer nur das Sprachmodell laufen
 * lässt, verliert die topologischen Vorschläge nicht.
 */
export async function replaceHypotheses(
    handle: GraphHandle,
    modelId: string,
    source: ProposalSource,
    records: readonly HypothesisRecord[],
): Promise<void> {
    const graph = hypothesesGraph(handle.iri);
    const prefix = hypothesisIri(handle.iri, `${modelId}~${source}~`);
    const agent = proposalAgentIri(handle.iri, modelId, source);
    const existing = await dumpHypotheses(handle);
    const kept = existing.filter(quad => {
        if (quad.subject.termType !== 'NamedNode') return true;
        return !(quad.subject.value.startsWith(prefix) || quad.subject.value === agent);
    });
    const next = pruneOrphanEdges([
        ...kept,
        ...records.flatMap(record => hypothesisQuads(handle.iri, record)),
    ]);
    await handle.store.transaction(async tx => {
        await tx.load(next, namedNode(graph), { replace: true });
    });
}

/**
 * Verwirft einen Vorschlag. Er kommt beim nächsten Lauf derselben Quelle
 * wieder — das ist kein Mangel, sondern ehrlich: Die Quelle sagt es
 * weiterhin. Verworfen wird eine Arbeitsliste, keine Meinung.
 */
export async function discardHypothesis(handle: GraphHandle, id: string): Promise<boolean> {
    const graph = hypothesesGraph(handle.iri);
    const target = hypothesisIri(handle.iri, id);
    const existing = await dumpHypotheses(handle);
    if (existing.length === 0) return false;
    const kept = existing.filter(quad =>
        !(quad.subject.termType === 'NamedNode' && quad.subject.value === target));
    if (kept.length === existing.length) return false;
    const next = pruneOrphanEdges(kept);
    await handle.store.transaction(async tx => {
        await tx.load(next, namedNode(graph), { replace: true });
    });
    return true;
}

export interface AdoptResult {
    message: string;
    /** Die Schritte, die dafür nötig waren — je einer eine Revision. */
    steps: string[];
}

/**
 * Übernimmt einen Vorschlag ins Modell — die einzige Brücke vom
 * Hypothesen-Graphen in die gesetzte Struktur, und damit die Stelle, an
 * der die C6-Abnahme hängt: **Keine Hypothese erreicht ohne Filter den
 * Studien-Pfad.** Ein verworfener Vorschlag wird hier abgelehnt, nicht in
 * der Oberfläche ausgegraut; wer ihn trotzdem will, zieht die Kante im
 * DAG-Editor selbst und verantwortet sie dann als `asserted`.
 *
 * Der Vorschlag bleibt danach im Hypothesen-Graphen stehen. Ihn zu
 * löschen hieße die Herkunft zu verlieren — und der Quellenvergleich aus
 * §8 lebt genau davon, dass sichtbar bleibt, wer eine Kante zuerst
 * genannt hat.
 */
export async function adoptHypothesis(
    handle: GraphHandle,
    id: string,
    context: EditContext = {},
): Promise<AdoptResult> {
    const view = await getHypothesis(handle, id);
    if (!view) throw new CausalEditError('Diesen Vorschlag gibt es nicht.', 404);
    if (!mayAdopt(view.verdict)) {
        throw new CausalEditError(
            `Dieser Vorschlag wurde von den Filtern verworfen und kommt so nicht ins Modell: ${view.reason} `
            + 'Wenn du ihn trotzdem für richtig hältst, zieh die Kante im Editor selbst — '
            + 'dann trägt sie deine Herkunft („gesetzt") statt einer fremden.',
            409,
        );
    }
    if (view.inModel) {
        throw new CausalEditError('Diese Kante steht bereits im Modell.', 409);
    }

    const steps: string[] = [];
    const model = await readCausalModel(handle, {
        modelId: view.modelId,
        graph: handle.iri.causalGraph(view.modelId),
    }, { withStudies: false });
    if (!model) throw new CausalEditError('Das Modell zu diesem Vorschlag gibt es nicht mehr.', 404);

    // Eine Störgröße, die noch nicht im Modell steht, ist der Regelfall —
    // §8 hält Confounder-Vorschläge für den wertvolleren Teil. Sie wird
    // deshalb mit aufgenommen, statt die Übernahme abzulehnen.
    for (const variable of [view.from, view.to]) {
        if (model.variables.some(entry => entry.iri === variable && entry.inModel)) continue;
        const result = await applyStructureOperation(
            handle,
            view.modelId,
            { op: 'add-variable', iri: variable },
            context,
        );
        steps.push(result.message);
    }
    const edge = await applyStructureOperation(handle, view.modelId, {
        op: 'add-edge',
        from: view.from,
        to: view.to,
        edgeClass: view.edgeClass,
        evidenceLevel: 'hypothesis',
        ...(view.temporalLag ? { temporalLag: view.temporalLag } : {}),
    }, context);
    steps.push(edge.message);

    return {
        message: `„${view.fromName}" → „${view.toName}" ins Modell übernommen `
            + `(${view.edgeClass}, unbelegt). Ob daraus eine Zahl wird, entscheidet erst eine Studie.`,
        steps,
    };
}

/**
 * Die Vorschläge im Format des Kanten-Lesemodells — für die Stellen, die
 * schon vor C6 Hypothesen anzeigten (`listCausalHypotheses`). Sie bleiben
 * damit unverändert bedienbar, sehen aber jetzt auch das Urteil.
 */
export function asEdgeViews(views: readonly HypothesisView[]): CausalEdgeView[] {
    return views.map(view => ({
        from: view.from,
        to: view.to,
        reifier: view.iri,
        edgeClass: view.edgeClass,
        evidenceLevel: 'hypothesis' as const,
        ...(view.temporalLag ? { temporalLag: view.temporalLag } : {}),
    }));
}
