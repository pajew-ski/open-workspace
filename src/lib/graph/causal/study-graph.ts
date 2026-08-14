/**
 * Studien als Graph-Bürger: der Lauf, sein Ergebnis und seine Signatur
 * (CAUSAL_LAYER_SPEC §5, §13, Meilenstein C4).
 *
 * Vier Regeln bestimmen alles in dieser Datei:
 *
 * 1. **Ergebnisse sind inferiert** (Invariante C4). Sie gehen
 *    ausschließlich nach `graph/<u>/inferred/causal/<scope>` und werden
 *    bei jedem Lauf **vollständig ersetzt**, nie gemerged (Invariante 3).
 *    Damit ein Replace kein Verlust ist, rechnet ein Lauf immer **alle**
 *    Fragen eines Scopes neu — die Fragen selbst leben in `graph/meta`
 *    (`estimand.ts`) und überleben.
 * 2. **Scope-partitioniert wie das Reasoning** (Invariante C6, §7.3). Ein
 *    Effekt ist eine Zahl, in der Beobachtungen stecken. Studien über
 *    private Reihen landen deshalb nie im öffentlichen Inferenz-Graphen —
 *    und weil Beobachtungen (C3) immer privat sind, ist der öffentliche
 *    Kausal-Inferenz-Graph in dieser Ausbaustufe stets leer. Das ist
 *    keine Lücke, sondern das Ergebnis der Regel.
 * 3. **Ohne Signatur wird nicht geschrieben** (Invariante C7). Vor dem
 *    Schreiben läuft SHACL über die Quads der Studie; was durchfällt,
 *    wird nicht geschrieben, sondern gemeldet.
 * 4. **Ein Effekt entsteht nur nach bestandener Refutation**
 *    (Invariante C5). Bei jedem anderen Ausgang wird die Studie samt
 *    Begründung und durchgefallenem Versuch geschrieben — aber keine
 *    Zahl. Sie steht nicht im Graphen, in keiner Form.
 */

import type { Quad } from '@rdfjs/types';
import type { IriFactory } from '../iri';
import type { Observation } from '../observations/types';
import { factory, literal, namedNode, typedLiteral } from '../rdf';
import { validateQuads, type ShaclResult } from '../reasoning/shacl';
import { DCTERMS, OW, PROV, RDF, RO, SCHEMA } from '../vocab';
import { causalEdgeReifier, readCausalModel, type GraphHandle } from './model';
import { listEstimands, type EstimandView } from './estimand';
import { ESTIMATORS, type EstimatorId } from './estimate';
import { REFUTATION_METHODS, REFUTATION_VERDICTS, type RefutationMethod, type RefutationVerdict } from './refute';
import {
    runStudy,
    STUDY_VERDICTS,
    type StudyDatasetInput,
    type StudyResult,
    type StudySeries,
    type StudyVerdict,
} from './study';
import type { CausalModelView } from './types';

/** Sichtbarkeits-Scopes des Kausal-Layers — dieselben wie beim Reasoning. */
export type CausalScopeId = 'workspace' | 'public';
export const CAUSAL_SCOPES: readonly CausalScopeId[] = ['workspace', 'public'];

/** `graph/<u>/inferred/causal/<scope>` (§5.1). */
export function causalInferredGraph(iri: IriFactory, scope: CausalScopeId): string {
    return iri.inferredGraph(`causal/${scope}`);
}

export function studyIri(iri: IriFactory, estimandId: string): string {
    return iri.entity('study', estimandId);
}

/**
 * In welchen Scope gehört ein Lauf? Nur was **ausschließlich** aus dem
 * öffentlichen Graphen stammt, darf in den öffentlichen Inferenz-Graphen
 * (Invariante C6). Beobachtungsreihen liegen im Datenverzeichnis des
 * Nutzers und ihre Definitionen in `graph/meta` — beides ist nicht
 * öffentlich, und deshalb ist die Antwort für jede Studie mit Daten
 * `workspace`. Die Funktion prüft es trotzdem, statt es vorauszusetzen:
 * Sobald C5 (Open Data) oder C8 (Föderation) Quellen hinzufügt, ist die
 * Regel schon da und wird nicht nachträglich erfunden.
 */
export function studyScope(iri: IriFactory, sourceGraphs: readonly string[]): CausalScopeId {
    const publicGraph = iri.graph('public');
    return sourceGraphs.length > 0 && sourceGraphs.every(graph => graph === publicGraph)
        ? 'public'
        : 'workspace';
}

// --- Ergebnis → Quads ----------------------------------------------------

export interface StudyWriteContext {
    result: StudyResult;
    model: CausalModelView;
    estimand: EstimandView;
    graph: string;
    generatedAt: string;
    softwareVersion: string;
    actor?: string;
}

function slug(value: string): string {
    const segment = value.split('#').pop() ?? value;
    return (segment.split('/').filter(Boolean).pop() ?? segment).replace(/[^A-Za-z0-9-]/g, '-');
}

function inputIri(study: string, input: StudyDatasetInput, index: number): string {
    return `${study}/input/${String(index + 1).padStart(2, '0')}-${slug(input.variable)}`;
}

const ROLE_LABEL: Record<StudyDatasetInput['role'], string> = {
    treatment: 'treatment',
    outcome: 'outcome',
    adjustment: 'adjustment',
    'control-outcome': 'control-outcome',
};

/** `900` → `PT15M`; Sekunden nur, wenn sie übrig bleiben. */
export function secondsToIsoDuration(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    const parts = [
        hours > 0 ? `${hours}H` : '',
        minutes > 0 ? `${minutes}M` : '',
        rest > 0 || total === 0 ? `${rest}S` : '',
    ].join('');
    return `PT${parts}`;
}

/**
 * Der vollständige Lauf als Quads. Enthalten ist immer die Signatur
 * (C7) und immer jeder Refutationsversuch — auch der durchgefallene.
 * Die Effekt-Annotation entsteht nur bei `passed` (C5).
 */
export function studyQuads(iri: IriFactory, context: StudyWriteContext): Quad[] {
    const { result, model, estimand, generatedAt, softwareVersion } = context;
    const graph = namedNode(context.graph);
    const study = namedNode(studyIri(iri, estimand.id));
    const quads: Quad[] = [
        factory.quad(study, namedNode(RDF.type), namedNode(OW.CausalStudy), graph),
        factory.quad(study, namedNode(DCTERMS.identifier), literal(estimand.id), graph),
        factory.quad(study, namedNode(SCHEMA.name), literal(estimand.name), graph),
        factory.quad(study, namedNode(PROV.used), namedNode(estimand.iri), graph),
        factory.quad(study, namedNode(PROV.used), namedNode(model.iri), graph),
        factory.quad(study, namedNode(OW.modelRevision), typedLiteral.integer(result.modelRevision), graph),
        factory.quad(study, namedNode(OW.treatment), namedNode(result.spec.treatment), graph),
        factory.quad(study, namedNode(OW.outcome), namedNode(result.spec.outcome), graph),
        factory.quad(
            study,
            namedNode(OW.identificationStrategy),
            literal(result.identification.strategy),
            graph,
        ),
        factory.quad(study, namedNode(OW.seed), typedLiteral.integer(result.spec.seed), graph),
        factory.quad(study, namedNode(OW.studyVerdict), literal(result.verdict), graph),
        factory.quad(study, namedNode(SCHEMA.softwareVersion), literal(softwareVersion), graph),
        factory.quad(study, namedNode(SCHEMA.description), literal(result.reason, 'de'), graph),
        factory.quad(study, namedNode(PROV.generatedAtTime), typedLiteral.dateTime(generatedAt), graph),
    ];
    if (context.actor) {
        quads.push(factory.quad(study, namedNode(PROV.wasAttributedTo), namedNode(context.actor), graph));
    }
    if (result.spec.controlOutcome) {
        quads.push(factory.quad(
            study,
            namedNode(OW.controlOutcome),
            namedNode(result.spec.controlOutcome),
            graph,
        ));
    }
    if (result.spec.interventionAt !== undefined) {
        quads.push(factory.quad(
            study,
            namedNode(OW.interventionAt),
            typedLiteral.dateTime(new Date(result.spec.interventionAt).toISOString()),
            graph,
        ));
    }
    if (result.estimator) {
        quads.push(factory.quad(study, namedNode(OW.estimator), literal(result.estimator), graph));
    }

    // Datenfenster und Umfang: die halbe Signatur aus C7. Ohne sie wäre
    // nicht rekonstruierbar, WORAUF die Zahl beruht.
    if (result.dataset) {
        const { dataset } = result;
        quads.push(factory.quad(
            study,
            namedNode(SCHEMA.numberOfItems),
            typedLiteral.integer(dataset.rows),
            graph,
        ));
        if (dataset.from !== undefined && dataset.through !== undefined) {
            quads.push(factory.quad(
                study,
                namedNode(SCHEMA.temporalCoverage),
                literal(`${new Date(dataset.from).toISOString()}/${new Date(dataset.through).toISOString()}`),
                graph,
            ));
        }
        dataset.inputs.forEach((input, index) => {
            const node = namedNode(inputIri(study.value, input, index));
            quads.push(
                factory.quad(node, namedNode(RDF.type), namedNode(PROV.Entity), graph),
                // Der Eingabe-Knoten friert die Erfassungsregel ein, mit
                // denselben Termen wie die Variable selbst: Eine zweite,
                // parallele Terminologie für dieselbe Sache wäre genau der
                // Wildwuchs, den Invariante 8 verhindern soll.
                factory.quad(node, namedNode(PROV.wasDerivedFrom), namedNode(input.variable), graph),
                factory.quad(node, namedNode(SCHEMA.roleName), literal(ROLE_LABEL[input.role]), graph),
                factory.quad(
                    node,
                    namedNode(OW.samplingInterval),
                    typedLiteral.duration(secondsToIsoDuration(input.intervalSeconds)),
                    graph,
                ),
                factory.quad(
                    node,
                    namedNode(SCHEMA.numberOfItems),
                    typedLiteral.integer(input.observationCount),
                    graph,
                ),
                factory.quad(study, namedNode(SCHEMA.hasPart), node, graph),
                factory.quad(study, namedNode(PROV.used), namedNode(input.variable), graph),
            );
            if (input.name) {
                quads.push(factory.quad(node, namedNode(SCHEMA.name), literal(input.name), graph));
            }
            if (input.aggregation) {
                quads.push(factory.quad(node, namedNode(OW.aggregation), literal(input.aggregation), graph));
            }
            if (input.lagSeconds > 0) {
                quads.push(factory.quad(
                    node,
                    namedNode(OW.temporalLag),
                    typedLiteral.duration(secondsToIsoDuration(input.lagSeconds)),
                    graph,
                ));
            }
        });
    }

    // Die Adjustierungsmenge existiert auch leer: „nichts nötig" ist eine
    // Aussage, „keine Angabe" wäre keine.
    if (result.verdict === 'passed' || result.verdict === 'refuted') {
        const adjustment = namedNode(`${study.value}/adjustment`);
        quads.push(
            factory.quad(adjustment, namedNode(RDF.type), namedNode(OW.AdjustmentSet), graph),
            factory.quad(study, namedNode(SCHEMA.hasPart), adjustment, graph),
        );
        for (const variable of result.adjustedFor) {
            quads.push(factory.quad(adjustment, namedNode(OW.adjustedFor), namedNode(variable), graph));
        }
    }

    // Was die Adjustierung geändert hat (C5). Der rohe Wert steht hier
    // bewusst unter eigenen Termen: Er ist ein Zusammenhang, kein Effekt,
    // und dürfte weder ow:effectSize noch ow:refutationPassed tragen
    // (Invariante C5).
    if (result.contrast) {
        const { contrast } = result;
        const node = namedNode(`${study.value}/confounding`);
        quads.push(
            factory.quad(node, namedNode(RDF.type), namedNode(OW.ConfoundingContrast), graph),
            factory.quad(study, namedNode(SCHEMA.hasPart), node, graph),
            factory.quad(node, namedNode(SCHEMA.description), literal(contrast.explanation, 'de'), graph),
        );
        // Worüber adjustiert wurde, steht bereits an der ow:AdjustmentSet
        // derselben Studie. Es hier zu wiederholen hieße, dieselbe Aussage
        // an zwei Stellen zu führen — und irgendwann widersprächen sie sich.
        if (contrast.crude !== undefined) {
            quads.push(factory.quad(node, namedNode(OW.crudeAssociation), typedLiteral.decimal(contrast.crude), graph));
        }
        if (contrast.crudeCiLow !== undefined && contrast.crudeCiHigh !== undefined) {
            quads.push(
                factory.quad(node, namedNode(OW.crudeCiLow), typedLiteral.decimal(contrast.crudeCiLow), graph),
                factory.quad(node, namedNode(OW.crudeCiHigh), typedLiteral.decimal(contrast.crudeCiHigh), graph),
            );
        }
        if (contrast.shift !== undefined) {
            quads.push(factory.quad(
                node,
                namedNode(OW.confoundingShift),
                typedLiteral.decimal(contrast.shift),
                graph,
            ));
        }
    }

    for (const refutation of result.refutations) {
        const node = namedNode(`${study.value}/refutation/${refutation.method}`);
        quads.push(
            factory.quad(node, namedNode(RDF.type), namedNode(OW.Refutation), graph),
            factory.quad(node, namedNode(OW.refutationMethod), literal(refutation.method), graph),
            factory.quad(node, namedNode(OW.refutationVerdict), literal(refutation.verdict), graph),
            factory.quad(node, namedNode(SCHEMA.description), literal(refutation.description, 'de'), graph),
            factory.quad(study, namedNode(SCHEMA.hasPart), node, graph),
        );
        if (refutation.value !== undefined && Number.isFinite(refutation.value)) {
            quads.push(factory.quad(node, namedNode(SCHEMA.value), typedLiteral.decimal(refutation.value), graph));
        }
    }

    if (result.verdict === 'passed' && result.effect) {
        quads.push(...effectQuads(iri, context, result.effect, study, graph));
    }
    return quads;
}

function effectQuads(
    iri: IriFactory,
    context: StudyWriteContext,
    effect: NonNullable<StudyResult['effect']>,
    study: ReturnType<typeof namedNode>,
    graph: ReturnType<typeof namedNode>,
): Quad[] {
    const { result, model } = context;
    const edge = model.edges.find(candidate =>
        candidate.from === result.spec.treatment && candidate.to === result.spec.outcome);
    // Steht die Kante im Modell, hängt der Effekt an ihrem Reifier — genau
    // wie §5.3 es vorsieht, nur im Inferenz-Graphen statt im Modell.
    // Fragt jemand nach einer Wirkung über mehrere Schritte, gibt es keine
    // Kante, die man annotieren könnte; eine zu erfinden hieße, Struktur
    // zu behaupten, die das Modell nicht enthält. Dann trägt ein
    // studieneigener Knoten die Zahl.
    const subject = edge
        ? namedNode(causalEdgeReifier(iri, context.estimand.modelId, result.spec.treatment, result.spec.outcome))
        : namedNode(`${study.value}/effect`);
    const quads: Quad[] = [
        factory.quad(subject, namedNode(OW.effectSize), typedLiteral.decimal(effect.effect), graph),
        factory.quad(subject, namedNode(OW.standardError), typedLiteral.decimal(effect.standardError), graph),
        factory.quad(subject, namedNode(OW.ciLow), typedLiteral.decimal(effect.ciLow), graph),
        factory.quad(subject, namedNode(OW.ciHigh), typedLiteral.decimal(effect.ciHigh), graph),
        factory.quad(subject, namedNode(OW.refutationPassed), typedLiteral.boolean(true), graph),
        factory.quad(subject, namedNode(PROV.wasGeneratedBy), study, graph),
    ];
    if (result.outcomeUnit) {
        quads.push(factory.quad(subject, namedNode(SCHEMA.unitText), literal(result.outcomeUnit), graph));
    }
    if (edge) {
        const triple = factory.quad(
            namedNode(result.spec.treatment),
            namedNode(RO.causallyUpstreamOf),
            namedNode(result.spec.outcome),
        );
        quads.push(
            factory.quad(subject, namedNode(RDF.reifies), triple, graph),
            // Die Herkunftsklasse wird aus dem Modell mitgeführt, nicht neu
            // gesetzt: Eine annotierte Kante muss auch dann noch sagen
            // können, woher sie kommt, wenn sie föderiert wird (§14) —
            // und ohne sie verletzte die Evidenzstufe die Shapes (C2).
            factory.quad(subject, namedNode(OW.edgeClass), literal(edge.edgeClass ?? 'asserted'), graph),
            factory.quad(subject, namedNode(OW.evidenceLevel), literal('refuted-clean'), graph),
        );
    } else {
        quads.push(
            factory.quad(subject, namedNode(OW.treatment), namedNode(result.spec.treatment), graph),
            factory.quad(subject, namedNode(OW.outcome), namedNode(result.spec.outcome), graph),
        );
    }
    return quads;
}

// --- Lesepfad ------------------------------------------------------------

export interface StudyRefutationView {
    method: RefutationMethod;
    verdict: RefutationVerdict;
    value?: number;
    description: string;
}

export interface StudyInputView {
    variable: string;
    name?: string;
    role: string;
    aggregation?: string;
    samplingInterval?: string;
    temporalLag?: string;
    observationCount?: number;
}

export interface StudyEffectView {
    /** Träger der Annotation: Reifier der Kante oder studieneigener Knoten. */
    subject: string;
    value: number;
    standardError?: number;
    ciLow: number;
    ciHigh: number;
    unit?: string;
}

/** Der Adjustierungs-Kontrast, so wie er im Graphen steht (C5). */
export interface StudyContrastView {
    adjustedFor: string[];
    /** Roher Zusammenhang — nie als Effekt zu lesen (Invariante C5). */
    crude?: number;
    crudeCiLow?: number;
    crudeCiHigh?: number;
    shift?: number;
    explanation: string;
}

export interface StudyView {
    iri: string;
    estimandId: string;
    name: string;
    modelIri: string;
    modelRevision: number;
    treatment: string;
    outcome: string;
    controlOutcome?: string;
    verdict: StudyVerdict;
    strategy?: string;
    estimator?: EstimatorId;
    seed: number;
    softwareVersion?: string;
    generatedAt?: string;
    reason: string;
    rows?: number;
    /** Datenfenster als ISO-Intervall, quelltreu. */
    window?: string;
    adjustedFor: string[];
    refutations: StudyRefutationView[];
    inputs: StudyInputView[];
    effect?: StudyEffectView;
    /** Was die Adjustierung geändert hat (C5), falls adjustiert wurde. */
    contrast?: StudyContrastView;
}

async function dumpGraph(handle: GraphHandle, graph: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const quad of handle.store.dump(namedNode(graph))) quads.push(quad);
    return quads;
}

function numberOf(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Studien eines Scopes, so wie sie im Graphen stehen. Gelesen wird über
 * einen Dump und nicht per SPARQL: Eine Studie ist ein kleiner Baum aus
 * Knoten, und ihn in einer Abfrage zusammenzusetzen wäre mehr Aufwand
 * als das Gruppieren hier.
 */
export async function readCausalStudies(
    handle: GraphHandle,
    scope: CausalScopeId = 'workspace',
): Promise<StudyView[]> {
    const graph = causalInferredGraph(handle.iri, scope);
    const existing = (await handle.store.graphs()).map(g => g.value);
    if (!existing.includes(graph)) return [];
    const quads = await dumpGraph(handle, graph);

    const bySubject = new Map<string, Quad[]>();
    for (const quad of quads) {
        if (quad.subject.termType !== 'NamedNode') continue;
        const list = bySubject.get(quad.subject.value);
        if (list) list.push(quad);
        else bySubject.set(quad.subject.value, [quad]);
    }
    const valuesOf = (subject: string, predicate: string): string[] =>
        (bySubject.get(subject) ?? [])
            .filter(quad => quad.predicate.value === predicate)
            .map(quad => quad.object.value);
    const valueOf = (subject: string, predicate: string): string | undefined =>
        valuesOf(subject, predicate)[0];

    const studies: StudyView[] = [];
    for (const [subject, own] of bySubject) {
        if (!own.some(quad => quad.predicate.value === RDF.type && quad.object.value === OW.CausalStudy)) continue;
        const verdictRaw = valueOf(subject, OW.studyVerdict) ?? 'not-estimable';
        const estimatorRaw = valueOf(subject, OW.estimator);
        const parts = valuesOf(subject, SCHEMA.hasPart);

        const refutations: StudyRefutationView[] = [];
        const inputs: StudyInputView[] = [];
        let adjustedFor: string[] = [];
        let contrast: StudyContrastView | undefined;
        for (const part of parts) {
            const types = valuesOf(part, RDF.type);
            if (types.includes(OW.ConfoundingContrast)) {
                contrast = {
                    // Die Adjustierungsmenge steht an der Studie, nicht am
                    // Kontrast — sie wird unten nachgetragen.
                    adjustedFor: [],
                    ...(numberOf(valueOf(part, OW.crudeAssociation)) !== undefined
                        ? { crude: numberOf(valueOf(part, OW.crudeAssociation)) as number }
                        : {}),
                    ...(numberOf(valueOf(part, OW.crudeCiLow)) !== undefined
                        ? { crudeCiLow: numberOf(valueOf(part, OW.crudeCiLow)) as number }
                        : {}),
                    ...(numberOf(valueOf(part, OW.crudeCiHigh)) !== undefined
                        ? { crudeCiHigh: numberOf(valueOf(part, OW.crudeCiHigh)) as number }
                        : {}),
                    ...(numberOf(valueOf(part, OW.confoundingShift)) !== undefined
                        ? { shift: numberOf(valueOf(part, OW.confoundingShift)) as number }
                        : {}),
                    explanation: valueOf(part, SCHEMA.description) ?? '',
                };
            } else if (types.includes(OW.Refutation)) {
                const method = valueOf(part, OW.refutationMethod) ?? '';
                const verdict = valueOf(part, OW.refutationVerdict) ?? 'inconclusive';
                if (!(REFUTATION_METHODS as readonly string[]).includes(method)) continue;
                refutations.push({
                    method: method as RefutationMethod,
                    verdict: ((REFUTATION_VERDICTS as readonly string[]).includes(verdict)
                        ? verdict
                        : 'inconclusive') as RefutationVerdict,
                    ...(numberOf(valueOf(part, SCHEMA.value)) !== undefined
                        ? { value: numberOf(valueOf(part, SCHEMA.value)) as number }
                        : {}),
                    description: valueOf(part, SCHEMA.description) ?? '',
                });
            } else if (types.includes(OW.AdjustmentSet)) {
                adjustedFor = valuesOf(part, OW.adjustedFor).sort();
            } else if (types.includes(PROV.Entity)) {
                const variable = valueOf(part, PROV.wasDerivedFrom);
                if (!variable) continue;
                inputs.push({
                    variable,
                    ...(valueOf(part, SCHEMA.name) ? { name: valueOf(part, SCHEMA.name) as string } : {}),
                    role: valueOf(part, SCHEMA.roleName) ?? 'adjustment',
                    ...(valueOf(part, OW.aggregation) ? { aggregation: valueOf(part, OW.aggregation) as string } : {}),
                    ...(valueOf(part, OW.samplingInterval)
                        ? { samplingInterval: valueOf(part, OW.samplingInterval) as string }
                        : {}),
                    ...(valueOf(part, OW.temporalLag) ? { temporalLag: valueOf(part, OW.temporalLag) as string } : {}),
                    ...(numberOf(valueOf(part, SCHEMA.numberOfItems)) !== undefined
                        ? { observationCount: numberOf(valueOf(part, SCHEMA.numberOfItems)) as number }
                        : {}),
                });
            }
        }
        refutations.sort((a, b) => a.method.localeCompare(b.method));
        inputs.sort((a, b) => a.role.localeCompare(b.role) || a.variable.localeCompare(b.variable));

        // Der Effekt hängt am Reifier der Kante oder am studieneigenen
        // Knoten — beide zeigen per prov:wasGeneratedBy auf die Studie.
        let effect: StudyEffectView | undefined;
        for (const [candidate] of bySubject) {
            if (!valuesOf(candidate, PROV.wasGeneratedBy).includes(subject)) continue;
            const value = numberOf(valueOf(candidate, OW.effectSize));
            const ciLow = numberOf(valueOf(candidate, OW.ciLow));
            const ciHigh = numberOf(valueOf(candidate, OW.ciHigh));
            if (value === undefined || ciLow === undefined || ciHigh === undefined) continue;
            effect = {
                subject: candidate,
                value,
                ciLow,
                ciHigh,
                ...(numberOf(valueOf(candidate, OW.standardError)) !== undefined
                    ? { standardError: numberOf(valueOf(candidate, OW.standardError)) as number }
                    : {}),
                ...(valueOf(candidate, SCHEMA.unitText) ? { unit: valueOf(candidate, SCHEMA.unitText) as string } : {}),
            };
            break;
        }

        studies.push({
            iri: subject,
            estimandId: valueOf(subject, DCTERMS.identifier) ?? '',
            name: valueOf(subject, SCHEMA.name) ?? '',
            modelIri: valuesOf(subject, PROV.used).find(used => used.includes('/causal-model/')) ?? '',
            modelRevision: numberOf(valueOf(subject, OW.modelRevision)) ?? 0,
            treatment: valueOf(subject, OW.treatment) ?? '',
            outcome: valueOf(subject, OW.outcome) ?? '',
            ...(valueOf(subject, OW.controlOutcome)
                ? { controlOutcome: valueOf(subject, OW.controlOutcome) as string }
                : {}),
            verdict: ((STUDY_VERDICTS as readonly string[]).includes(verdictRaw)
                ? verdictRaw
                : 'not-estimable') as StudyVerdict,
            ...(valueOf(subject, OW.identificationStrategy)
                ? { strategy: valueOf(subject, OW.identificationStrategy) as string }
                : {}),
            ...(estimatorRaw && (ESTIMATORS as readonly string[]).includes(estimatorRaw)
                ? { estimator: estimatorRaw as EstimatorId }
                : {}),
            seed: numberOf(valueOf(subject, OW.seed)) ?? 0,
            ...(valueOf(subject, SCHEMA.softwareVersion)
                ? { softwareVersion: valueOf(subject, SCHEMA.softwareVersion) as string }
                : {}),
            ...(valueOf(subject, PROV.generatedAtTime)
                ? { generatedAt: valueOf(subject, PROV.generatedAtTime) as string }
                : {}),
            reason: valueOf(subject, SCHEMA.description) ?? '',
            ...(numberOf(valueOf(subject, SCHEMA.numberOfItems)) !== undefined
                ? { rows: numberOf(valueOf(subject, SCHEMA.numberOfItems)) as number }
                : {}),
            ...(valueOf(subject, SCHEMA.temporalCoverage)
                ? { window: valueOf(subject, SCHEMA.temporalCoverage) as string }
                : {}),
            adjustedFor,
            refutations,
            inputs,
            ...(effect ? { effect } : {}),
            ...(contrast ? { contrast: { ...contrast, adjustedFor } } : {}),
        });
    }
    return studies.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

// --- Der Lauf ------------------------------------------------------------

export interface StudyRunOptions {
    now?: Date;
    actor?: string;
    /** Version, mit der gerechnet wurde — Pflichtangabe der Signatur (C7). */
    softwareVersion: string;
    bootstrapSamples?: number;
    /** Obergrenze an Panel-Zeilen je Studie; gekappt wird am älteren Ende. */
    maxRows?: number;
    /** Der einzige I/O-Anteil: die Messwerte einer Größe (C3). */
    readSeries(variableId: string, range: { after?: number; through?: number }): Promise<readonly Observation[]>;
}

export interface StudyRunSummary {
    scope: CausalScopeId;
    graph: string;
    generatedAt: string;
    durationMs: number;
    /** Ergebnisse in der Reihenfolge der Fragen. */
    results: StudyResult[];
    /** Fragen, die nicht einmal zu einem Lauf kamen — mit Grund. */
    skipped: Array<{ estimandId: string; reason: string }>;
    /** Studien, die die Signaturprüfung nicht bestanden haben (C7). */
    rejected: Array<{ estimandId: string; violations: ShaclResult[] }>;
}

/** Zeilenobergrenze je Studie, wenn nichts anderes gesagt ist. */
export const DEFAULT_MAX_ROWS = 10_000;

/**
 * Variablen-ID aus ihrer IRI (`…/u/<u>/variable/<id>`). Der Umweg über
 * die Fabrik statt über das letzte Segment, damit eine ID mit Schrägstrich
 * nicht stillschweigend zerfällt.
 */
export function variableIdOf(iri: IriFactory, value: string): string | null {
    const prefix = iri.entity('variable', '');
    if (!value.startsWith(prefix)) return null;
    const rest = value.slice(prefix.length);
    return rest === '' ? null : decodeURIComponent(rest);
}

export interface VariableMetadata {
    iri: string;
    id: string;
    name: string;
    kind: StudySeries['kind'];
    aggregation: NonNullable<StudySeries['aggregation']>;
    intervalSeconds: number;
    unit?: string;
}

/**
 * Rechnet **alle** Fragen neu und ersetzt den Inferenz-Graphen ihres
 * Scopes vollständig (Invariante C4 + Invariante 3). Ein Lauf ist damit
 * idempotent: Gleiche Fragen, gleiche Daten, gleicher Seed → gleicher
 * Graph.
 */
export async function runCausalStudies(
    handle: GraphHandle,
    variables: readonly VariableMetadata[],
    options: StudyRunOptions,
): Promise<StudyRunSummary> {
    const started = Date.now();
    const generatedAt = (options.now ?? new Date()).toISOString();
    const scope: CausalScopeId = 'workspace';
    const graph = causalInferredGraph(handle.iri, scope);
    const estimands = await listEstimands(handle);
    const byIri = new Map(variables.map(variable => [variable.iri, variable]));

    const results: StudyResult[] = [];
    const skipped: StudyRunSummary['skipped'] = [];
    const rejected: StudyRunSummary['rejected'] = [];
    const quads: Quad[] = [];

    const shapes = await dumpGraph(handle, handle.iri.sharedGraph('shapes'));

    for (const estimand of estimands) {
        const modelGraph = handle.iri.causalGraph(estimand.modelId);
        const model = estimand.modelId
            ? await readCausalModel(handle, { modelId: estimand.modelId, graph: modelGraph })
            : null;
        if (!model) {
            skipped.push({
                estimandId: estimand.id,
                reason: `Das Kausalmodell „${estimand.modelId}" gibt es nicht (mehr). `
                    + 'Ohne Modell gibt es keine Annahme und damit nichts zu schätzen.',
            });
            continue;
        }
        // Der Scope entscheidet sich an den Quellen, nicht an der Frage
        // (Invariante C6). Beobachtungen sind privat — deshalb bleibt es
        // bei `workspace`, und der öffentliche Graph bekommt nichts.
        const sources = [modelGraph, handle.iri.sharedGraph('meta')];
        if (studyScope(handle.iri, sources) !== scope) {
            skipped.push({
                estimandId: estimand.id,
                reason: 'Die Quellen dieser Frage gehören nicht in diesen Sichtbarkeits-Scope.',
            });
            continue;
        }

        const windowFrom = estimand.windowFrom ? Date.parse(estimand.windowFrom) : undefined;
        const windowThrough = estimand.windowThrough ? Date.parse(estimand.windowThrough) : undefined;

        const series: StudySeries[] = [];
        for (const variable of model.variables) {
            const metadata = byIri.get(variable.iri);
            if (!metadata || variable.observation === undefined) continue;
            const observations = await options.readSeries(metadata.id, {
                ...(windowFrom !== undefined ? { after: windowFrom - 1 } : {}),
                ...(windowThrough !== undefined ? { through: windowThrough } : {}),
            });
            if (observations.length === 0) continue;
            series.push({
                key: variable.iri,
                name: metadata.name,
                kind: metadata.kind,
                aggregation: metadata.aggregation,
                intervalSeconds: metadata.intervalSeconds,
                observations,
                ...(metadata.unit ? { unit: metadata.unit } : {}),
            });
        }

        const result = runStudy({
            spec: {
                id: estimand.id,
                treatment: estimand.treatment,
                outcome: estimand.outcome,
                estimator: estimand.estimator,
                seed: estimand.seed,
                ...(estimand.controlOutcome ? { controlOutcome: estimand.controlOutcome } : {}),
                ...(estimand.interventionAt ? { interventionAt: Date.parse(estimand.interventionAt) } : {}),
                ...(windowFrom !== undefined ? { windowFrom } : {}),
                ...(windowThrough !== undefined ? { windowThrough } : {}),
            },
            model,
            series,
            ...(options.bootstrapSamples !== undefined ? { bootstrapSamples: options.bootstrapSamples } : {}),
            maxRows: options.maxRows ?? DEFAULT_MAX_ROWS,
        });
        results.push(result);

        const studyQuadList = studyQuads(handle.iri, {
            result,
            model,
            estimand,
            graph,
            generatedAt,
            softwareVersion: options.softwareVersion,
            ...(options.actor ? { actor: options.actor } : {}),
        });
        // Signaturprüfung vor dem Schreiben (Invariante C7): Was die
        // Shapes nicht bestehen, wird nicht geschrieben — auch nicht
        // teilweise. Gemeldet wird es trotzdem.
        if (shapes.length > 0) {
            const report = await validateQuads(shapes, studyQuadList);
            const violations = report.results.filter(entry => entry.severity.endsWith('Violation'));
            if (violations.length > 0) {
                rejected.push({ estimandId: estimand.id, violations });
                continue;
            }
        }
        quads.push(...studyQuadList);
    }

    await handle.store.transaction(async tx => {
        await tx.load(quads, namedNode(graph), { replace: true });
    });

    return {
        scope,
        graph,
        generatedAt,
        durationMs: Date.now() - started,
        results,
        skipped,
        rejected,
    };
}
