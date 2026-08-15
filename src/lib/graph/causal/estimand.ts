/**
 * Die Frage als Graph-Bürger: `ow:Estimand`
 * (CAUSAL_LAYER_SPEC §5.2, Meilenstein C4).
 *
 * Ein Estimand ist die **Frage**, nicht die Antwort: Welche Wirkung
 * welcher Größe auf welche, mit welchem Verfahren, in welchem Fenster,
 * mit welchem gesetzten Zufall. Er ist eine menschliche Setzung und
 * überlebt deshalb jeden Lauf.
 *
 * Deshalb liegt er in `graph/meta` — dasselbe Muster wie
 * Retrieval-Profile (M8), Query-Views (M5) und Beobachtungsgrößen (C3) —
 * und **nicht** im Inferenz-Graphen. Dort landen ausschließlich die
 * Ergebnisse, und die werden bei jedem Lauf vollständig ersetzt
 * (Invariante C4). Ohne diese Trennung gäbe es nur zwei schlechte
 * Möglichkeiten: entweder verschwindet mit jedem Lauf die Frage, oder
 * die Ergebnisse häufen sich an, statt ersetzt zu werden.
 *
 * Der Lauf rechnet **alle** Estimands eines Scopes neu und schreibt sie
 * gemeinsam — so ist der vollständige Replace kein Datenverlust, sondern
 * genau das, was Invariante 3 meint.
 */

import type { Quad } from '@rdfjs/types';
import type { IriFactory } from '../iri';
import { factory, literal, namedNode, typedLiteral } from '../rdf';
import { DCTERMS, OW, RDF, SCHEMA } from '../vocab';
import { ESTIMATOR_CHOICES, isoDurationSeconds, secondsToIsoDuration, type EstimatorChoice } from './study';
import type { GraphHandle } from './model';

/** IDs sind Dateinamen-tauglich und IRI-arm — dieselbe Regel wie sonst. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertEstimandId(id: string): void {
    if (!ID_PATTERN.test(id)) {
        throw new Error(
            `Ungültige Kennung "${id}": erlaubt sind Kleinbuchstaben, Ziffern und Bindestriche ` +
            '(1–64 Zeichen, Beginn mit Buchstabe oder Ziffer).',
        );
    }
}

export function estimandIri(iri: IriFactory, id: string): string {
    return iri.entity('estimand', id);
}

export interface EstimandInput {
    id: string;
    name: string;
    /** Kennung des Modells, dessen Annahme die Frage benutzt. */
    modelId: string;
    treatment: string;
    outcome: string;
    estimator: EstimatorChoice;
    /** Gesetzter Zufall — ohne ihn wäre keine Studie reproduzierbar (C7). */
    seed: number;
    description?: string;
    controlOutcome?: string;
    /** ISO-Zeitpunkt des Eingriffs (DiD/ITS). */
    interventionAt?: string;
    /** Fenstergrenzen als ISO-Zeitpunkte; ohne sie zählt alles Erfasste. */
    windowFrom?: string;
    windowThrough?: string;
    /**
     * Rechenraster in Sekunden (`ow:studyInterval`). Ohne Angabe nimmt das
     * Panel den gröbsten Abstand der beteiligten Reihen.
     *
     * **Wozu es gut ist**: Über der aus Stundenaggregaten nachgefüllten
     * Strecke (§15.5) trägt eine Fünf-Minuten-Reihe nur die vollen
     * Stunden bei; auf ihrem eigenen Raster fallen elf von zwölf Zeilen
     * als Lücke heraus. Wer diese Strecke auswerten will, stellt die
     * Frage bewusst stündlich — das verliert nichts und erfindet nichts,
     * es fragt seltener. Feiner als der gröbste Reihenabstand darf es
     * nicht sein; das Panel lehnt das ab, statt es stumm anzuheben.
     */
    intervalSeconds?: number;
}

export interface EstimandView extends EstimandInput {
    iri: string;
    modelIri: string;
    created?: string;
}

/** ISO-8601-Intervall für `schema:temporalCoverage`; offene Enden als `..`. */
export function temporalCoverage(from?: string, through?: string): string | null {
    if (!from && !through) return null;
    return `${from ?? '..'}/${through ?? '..'}`;
}

export function parseTemporalCoverage(value: string): { from?: string; through?: string } {
    const [from, through] = value.split('/');
    return {
        ...(from && from !== '..' ? { from } : {}),
        ...(through && through !== '..' ? { through } : {}),
    };
}

function isTimestamp(value: string): boolean {
    return Number.isFinite(Date.parse(value));
}

/**
 * Prüft die Frage, bevor sie in den Graphen geht. Was hier abgelehnt
 * wird, wäre später eine Studie ohne Signatur — und die dürfte nach
 * Invariante C7 ohnehin nicht geschrieben werden.
 */
export function assertEstimandInput(input: EstimandInput): void {
    assertEstimandId(input.id);
    if (input.name.trim() === '') throw new Error('Eine Frage braucht einen Namen.');
    if (input.treatment === input.outcome) {
        throw new Error('Behandlung und Wirkung sind dieselbe Größe — dazu gibt es nichts zu schätzen.');
    }
    if (!(ESTIMATOR_CHOICES as readonly string[]).includes(input.estimator)) {
        throw new Error(`Unbekanntes Schätzverfahren „${input.estimator}".`);
    }
    if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 2 ** 31) {
        throw new Error('Der Startwert des Zufalls muss eine ganze Zahl zwischen 0 und 2^31 sein.');
    }
    for (const [label, value] of [
        ['Der Zeitpunkt des Eingriffs', input.interventionAt],
        ['Der Fensteranfang', input.windowFrom],
        ['Das Fensterende', input.windowThrough],
    ] as const) {
        if (value !== undefined && !isTimestamp(value)) {
            throw new Error(`${label} ist kein gültiger Zeitpunkt: „${value}".`);
        }
    }
    if (input.windowFrom && input.windowThrough && Date.parse(input.windowFrom) >= Date.parse(input.windowThrough)) {
        throw new Error('Das Fenster endet, bevor es beginnt.');
    }
    if (input.intervalSeconds !== undefined) {
        // Obergrenze ist ein Jahr: Ein Raster darüber hätte über jeden
        // realistischen Bestand weniger Zeilen als Parameter.
        if (!Number.isInteger(input.intervalSeconds)
            || input.intervalSeconds < 1
            || input.intervalSeconds > 366 * 86400) {
            throw new Error(
                'Das Rechenraster muss eine ganze Zahl von Sekunden zwischen 1 und einem Jahr sein.',
            );
        }
    }
}

export function estimandQuads(iri: IriFactory, input: EstimandView, graph: Quad['graph']): Quad[] {
    const subject = namedNode(input.iri);
    const quads: Quad[] = [
        factory.quad(subject, namedNode(RDF.type), namedNode(OW.Estimand), graph),
        factory.quad(subject, namedNode(DCTERMS.identifier), literal(input.id), graph),
        factory.quad(subject, namedNode(SCHEMA.name), literal(input.name), graph),
        // Die Frage gehört zum Modell: Wer das Modell verwirft, verwirft
        // die Frage — sie hat ohne ihre Annahme keinen Sinn.
        factory.quad(subject, namedNode(SCHEMA.isPartOf), namedNode(input.modelIri), graph),
        factory.quad(subject, namedNode(OW.treatment), namedNode(input.treatment), graph),
        factory.quad(subject, namedNode(OW.outcome), namedNode(input.outcome), graph),
        factory.quad(subject, namedNode(OW.estimator), literal(input.estimator), graph),
        factory.quad(subject, namedNode(OW.seed), typedLiteral.integer(input.seed), graph),
    ];
    if (input.description) {
        quads.push(factory.quad(subject, namedNode(SCHEMA.description), literal(input.description), graph));
    }
    if (input.controlOutcome) {
        quads.push(factory.quad(subject, namedNode(OW.controlOutcome), namedNode(input.controlOutcome), graph));
    }
    if (input.interventionAt) {
        quads.push(factory.quad(
            subject,
            namedNode(OW.interventionAt),
            typedLiteral.dateTime(input.interventionAt),
            graph,
        ));
    }
    const coverage = temporalCoverage(input.windowFrom, input.windowThrough);
    if (coverage) {
        quads.push(factory.quad(subject, namedNode(SCHEMA.temporalCoverage), literal(coverage), graph));
    }
    if (input.intervalSeconds !== undefined) {
        quads.push(factory.quad(
            subject,
            namedNode(OW.studyInterval),
            typedLiteral.duration(secondsToIsoDuration(input.intervalSeconds)),
            graph,
        ));
    }
    if (input.created) {
        quads.push(factory.quad(subject, namedNode(DCTERMS.created), typedLiteral.dateTime(input.created), graph));
    }
    return quads;
}

async function readMeta(handle: GraphHandle): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const quad of handle.store.dump(namedNode(handle.iri.sharedGraph('meta')))) quads.push(quad);
    return quads;
}

function viewFrom(handle: GraphHandle, subject: string, quads: readonly Quad[]): EstimandView | null {
    const mine = quads.filter(quad => quad.subject.termType === 'NamedNode' && quad.subject.value === subject);
    if (!mine.some(quad => quad.predicate.value === RDF.type && quad.object.value === OW.Estimand)) return null;
    const value = (predicate: string) => mine.find(quad => quad.predicate.value === predicate)?.object.value;
    const id = value(DCTERMS.identifier);
    const modelIri = value(SCHEMA.isPartOf);
    const treatment = value(OW.treatment);
    const outcome = value(OW.outcome);
    if (!id || !modelIri || !treatment || !outcome) return null;
    const coverage = value(SCHEMA.temporalCoverage);
    const window = coverage ? parseTemporalCoverage(coverage) : {};
    const estimator = value(OW.estimator) ?? 'auto';
    // Ein unlesbares Raster wird weggelassen, nicht geraten: Ohne Angabe
    // rechnet das Panel auf der gröbsten Reihe, und das ist die
    // konservative Seite.
    const interval = value(OW.studyInterval);
    const intervalSeconds = interval ? isoDurationSeconds(interval) : null;
    const modelPrefix = handle.iri.entity('causal-model', '');
    return {
        id,
        iri: subject,
        name: value(SCHEMA.name) ?? id,
        modelIri,
        modelId: modelIri.startsWith(modelPrefix)
            ? decodeURIComponent(modelIri.slice(modelPrefix.length))
            : '',
        treatment,
        outcome,
        estimator: ((ESTIMATOR_CHOICES as readonly string[]).includes(estimator)
            ? estimator
            : 'auto') as EstimatorChoice,
        seed: Number.parseInt(value(OW.seed) ?? '0', 10) || 0,
        ...(value(SCHEMA.description) ? { description: value(SCHEMA.description) as string } : {}),
        ...(value(OW.controlOutcome) ? { controlOutcome: value(OW.controlOutcome) as string } : {}),
        ...(value(OW.interventionAt) ? { interventionAt: value(OW.interventionAt) as string } : {}),
        ...(window.from ? { windowFrom: window.from } : {}),
        ...(window.through ? { windowThrough: window.through } : {}),
        ...(intervalSeconds !== null && intervalSeconds > 0 ? { intervalSeconds } : {}),
        ...(value(DCTERMS.created) ? { created: value(DCTERMS.created) as string } : {}),
    };
}

export async function listEstimands(handle: GraphHandle): Promise<EstimandView[]> {
    const quads = await readMeta(handle);
    const subjects = new Set<string>();
    for (const quad of quads) {
        if (quad.predicate.value === RDF.type
            && quad.object.value === OW.Estimand
            && quad.subject.termType === 'NamedNode') {
            subjects.add(quad.subject.value);
        }
    }
    const views: EstimandView[] = [];
    for (const subject of subjects) {
        const view = viewFrom(handle, subject, quads);
        if (view) views.push(view);
    }
    return views.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export async function getEstimand(handle: GraphHandle, id: string): Promise<EstimandView | null> {
    return viewFrom(handle, estimandIri(handle.iri, id), await readMeta(handle));
}

async function replaceEstimandNode(
    handle: GraphHandle,
    id: string,
    view: EstimandView | null,
): Promise<void> {
    const metaGraph = namedNode(handle.iri.sharedGraph('meta'));
    const subject = estimandIri(handle.iri, id);
    const remaining = (await readMeta(handle))
        .filter(quad => !(quad.subject.termType === 'NamedNode' && quad.subject.value === subject));
    const next = view ? [...remaining, ...estimandQuads(handle.iri, view, metaGraph)] : remaining;
    await handle.store.load(next, metaGraph, { replace: true });
}

export async function createEstimand(
    handle: GraphHandle,
    input: EstimandInput,
    options: { now?: Date } = {},
): Promise<EstimandView> {
    assertEstimandInput(input);
    if (await getEstimand(handle, input.id)) {
        throw new Error(`Eine Frage mit der Kennung "${input.id}" existiert bereits.`);
    }
    const view: EstimandView = {
        ...input,
        iri: estimandIri(handle.iri, input.id),
        modelIri: handle.iri.entity('causal-model', input.modelId),
        created: (options.now ?? new Date()).toISOString(),
    };
    await handle.store.transaction(async tx => {
        await replaceEstimandNode({ store: tx, iri: handle.iri }, input.id, view);
    });
    return view;
}

export async function deleteEstimand(handle: GraphHandle, id: string): Promise<boolean> {
    assertEstimandId(id);
    if (!(await getEstimand(handle, id))) return false;
    await handle.store.transaction(async tx => {
        await replaceEstimandNode({ store: tx, iri: handle.iri }, id, null);
    });
    return true;
}
