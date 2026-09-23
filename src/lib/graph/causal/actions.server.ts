/**
 * Aktionen des Kausal-Layers (ACTIONS_SPEC, A4; CAUSAL_LAYER_SPEC §5, §8,
 * §13): Modelle, Strukturänderung, Fragen, Vorschläge, Studien, Chronik.
 *
 * Ziele folgen dem Named-Graph-Schnitt des Layers: Ein Modell IST sein
 * Graph (`causal/<id>`), Vorschläge liegen in `causal-hypotheses`, Fragen
 * als Setzung des Menschen in `graph/meta` (Registry-Eintrag), Studien
 * im Inferenz-Graphen `inferred/causal/workspace`, die Chronik in
 * `causal-archive`. Das Recht kommt aus dem Grant über dasselbe
 * Scope-Muster wie beim SPARQL-Editor (C1) — kein zweiter Pfad.
 *
 * Serverseitig, weil Vorschlags- und Studienlauf Runtime, Dateibaum und
 * Sprachmodell brauchen; die Filter sind Graphalgorithmik des Tier-1-Kerns
 * (Invariante C9): Wo die Runtime `causalTier: 'none'` meldet, gibt es
 * die Läufe nicht.
 */

import { z } from 'zod';
import {
    ActionError,
    defineAction,
    notFound,
    withStatusFromMessage,
    type ActionContext,
} from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { OW, PROV } from '../vocab';
import { validateStoreGraphs } from '../reasoning/run';
import { listVariables } from '../observations/variables';
import { causalArchiveGraph, deleteArchiveEntry, readCausalArchive } from './archive';
import { compareStructureSources } from './compare';
import { applyStructureOperation, CausalEditError } from './edit';
import { createEstimand, deleteEstimand, listEstimands } from './estimand';
import {
    adoptHypothesis,
    discardHypothesis,
    getHypothesis,
    hypothesesGraph,
    readHypotheses,
} from './hypothesis';
import { causalGraphsOf, createCausalModel, deleteCausalModel, listCausalModels, readCausalModel } from './model';
import { PROPOSAL_SOURCES } from './propose';
import { runProposalSources } from './propose.server';
import { ESTIMATOR_CHOICES } from './study';
import { causalInferredGraph, readCausalStudies } from './study-graph';
import { runCausalStudiesOnServer } from './study-run.server';
import { EDGE_CLASSES, EVIDENCE_LEVELS } from './types';

/**
 * Wie viele Chronik-Einträge eine Antwort bekommt. Die Chronik wächst
 * nur, wenn sich etwas ändert — trotzdem ist sie unbegrenzt, und eine
 * Aktion gibt nichts Unbegrenztes aus.
 */
const ARCHIVE_LIMIT = 100;

const modelIdSchema = z.string().min(1).max(64);
const withId = z.object({ id: modelIdSchema });

function actorOf(ctx: ActionContext): { actor?: string } {
    return ctx.identity.userId ? { actor: ctx.graph.iri.principal('user', ctx.identity.userId) } : {};
}

/** Tier-Prüfung (Invariante C9): Was die Runtime nicht rechnet, tut sie nicht so, als könnte sie es. */
function requireCausalTier(ctx: ActionContext, message: string): void {
    const tier = ctx.platform?.runtime.capabilities.causalTier ?? 'none';
    if (tier === 'none') throw new ActionError(501, message);
}

const CAUSAL_ERROR_RULES: ReadonlyArray<readonly [RegExp, number]> = [
    [/existiert bereits/, 409],
    [/gibt es nicht|nicht gefunden/, 404],
    [/Ungültige/, 400],
];

/** Layer-Fehler → Aktionsfehler mit dem Status, den der Layer schon kennt. */
function rethrowCausal(error: unknown): never {
    if (error instanceof CausalEditError) throw new ActionError(error.status, error.message);
    return withStatusFromMessage(error, CAUSAL_ERROR_RULES);
}

// ---------------------------------------------------------------------------
// Modelle (C0/C1)
// ---------------------------------------------------------------------------

export const causalOverview = defineAction({
    name: 'causal_overview',
    title: 'Kausal-Übersicht',
    description: 'Alle Kausalmodelle mit Variablen und Kanten, Vorschläge samt Quellenvergleich, Fragen, Studien, Chronik und SHACL-Befund der Kausal-Graphen.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(_input, ctx) {
        const handle = ctx.graph;
        const { store, iri } = handle;
        const allowedGraphs = ctx.grant.readableGraphs;
        const models = await listCausalModels(handle, { allowedGraphs });
        const hypotheses = await readHypotheses(handle, { allowedGraphs });
        // Die Shapes aus ontology/shapes/causal.ttl sind nur dann etwas
        // wert, wenn ihre Befunde ankommen — deshalb laufen sie bei jedem
        // Lesen über die Kausal-Graphen (§7.2 Stelle 3), blockieren aber
        // nichts. Validiert wird nur, was der Aufrufer lesen darf (§17.3).
        const proposals = hypothesesGraph(iri);
        const existing = (await store.graphs()).map(g => g.value);
        const targets = [
            ...causalGraphsOf(iri, existing).map(ref => ref.graph),
            ...existing.filter(graph => graph === proposals),
        ].filter(graph => allowedGraphs.includes(graph));
        // Ohne Ziel wird NICHT validiert: eine leere Liste hieße im
        // Validierer „alles Erlaubte".
        const validation = targets.length > 0
            ? await validateStoreGraphs(handle, [...new Set(targets)])
            : { conforms: true, graphs: [] as string[], results: [] };
        // Erfasste Größen (C3) als Auswahl für den DAG-Editor: Nur was
        // erfasst ist, lässt sich später adjustieren.
        const metaReadable = allowedGraphs.includes(iri.sharedGraph('meta'));
        const observedVariables = (metaReadable ? await listVariables(handle) : []).map(variable => ({
            iri: variable.iri,
            name: variable.name,
            ...(variable.unit ? { unit: variable.unit } : {}),
            count: variable.status.count,
            enabled: variable.enabled,
            intervalSeconds: variable.intervalSeconds,
            ...(variable.status.aggregate
                ? { aggregateIntervalSeconds: variable.status.aggregate.intervalSeconds }
                : {}),
        }));
        const inferredGraph = causalInferredGraph(iri, 'workspace');
        const estimands = metaReadable ? await listEstimands(handle) : [];
        const studies = allowedGraphs.includes(inferredGraph) ? await readCausalStudies(handle) : [];
        const archive = allowedGraphs.includes(causalArchiveGraph(iri))
            ? await readCausalArchive(handle, { limit: ARCHIVE_LIMIT })
            : [];
        // Der Quellenvergleich (§8 „Die Rückkopplung") ist je Modell eine
        // eigene Frage: Dieselbe Kante kann in einem Modell Widerspruch
        // sein und im anderen gar nicht vorkommen.
        const comparisons = models.map(model => {
            const names = new Map(model.variables.map(variable => [variable.iri, variable.name]));
            const own = hypotheses.filter(hypothesis => hypothesis.modelId === model.id);
            for (const hypothesis of own) {
                names.set(hypothesis.from, hypothesis.fromName);
                names.set(hypothesis.to, hypothesis.toName);
            }
            return {
                modelId: model.id,
                entries: compareStructureSources(own, model.edges, node => names.get(node) ?? node),
            };
        });
        return {
            models,
            hypotheses,
            comparisons,
            hypothesesGraph: proposals,
            observedVariables,
            estimands,
            studies,
            archive,
            causalTier: ctx.platform?.runtime.capabilities.causalTier ?? 'none',
            validation: { conforms: validation.conforms, graphs: validation.graphs, results: validation.results },
        };
    },
});

export const createModel = defineAction({
    name: 'causal_create_model',
    title: 'Kausalmodell anlegen',
    description: 'Legt ein leeres Kausalmodell an (eigener Named Graph plus Modell-Knoten).',
    input: z.object({
        id: modelIdSchema,
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
    }).strict(),
    effect: 'constructive',
    // Anlegen heißt: einen Named Graph im eigenen Kausal-Namensraum
    // erzeugen — das Recht kommt aus dem Scope-Muster des Grants (C1).
    target: { kind: 'graph', scope: input => `causal/${(input as { id: string }).id}` },
    changes: [OW.CausalModel],
    async run(input, ctx) {
        try {
            const model = await createCausalModel(ctx.graph, { ...input, ...actorOf(ctx) });
            await ctx.persist?.snapshot();
            return { model };
        } catch (error) {
            return rethrowCausal(error);
        }
    },
});

export const getModel = defineAction({
    name: 'causal_get_model',
    title: 'Kausalmodell lesen',
    description: 'Liest ein Kausalmodell samt Variablen, Kanten und Studien.',
    input: withId,
    effect: 'read',
    target: { kind: 'graph', scope: input => `causal/${(input as { id: string }).id}` },
    async run(input, ctx) {
        const model = await readCausalModel(ctx.graph, { modelId: input.id, graph: ctx.graph.iri.causalGraph(input.id) });
        if (!model) throw notFound('Kausalmodell nicht gefunden.');
        return { model };
    },
});

const operationSchema = z.discriminatedUnion('op', [
    z.object({
        op: z.literal('add-variable'),
        iri: z.string().min(1).max(500).optional(),
        name: z.string().min(1).max(200).optional(),
    }),
    z.object({ op: z.literal('remove-variable'), iri: z.string().min(1).max(500) }),
    z.object({
        op: z.literal('add-edge'),
        from: z.string().min(1).max(500),
        to: z.string().min(1).max(500),
        edgeClass: z.enum(EDGE_CLASSES),
        evidenceLevel: z.enum(EVIDENCE_LEVELS).optional(),
        temporalLag: z.string().max(40).optional(),
    }),
    z.object({ op: z.literal('remove-edge'), from: z.string().min(1).max(500), to: z.string().min(1).max(500) }),
    z.object({
        op: z.literal('describe'),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional(),
    }),
]);

/**
 * Genau eine Strukturänderung (C1) — derselbe Schreibweg für DAG-Editor
 * und Agent, mit Revision und Azyklizitätsprüfung. Ziel ist der Graph
 * des Modells; er existiert, also entscheidet allein die ACL.
 */
export const editModel = defineAction({
    name: 'causal_edit_model',
    title: 'Kausalmodell ändern',
    description: 'Führt genau eine Strukturänderung an einem Kausalmodell aus (Variable oder Kante hinzufügen/entfernen, Beschreibung).',
    input: z.object({ id: modelIdSchema, operation: operationSchema }),
    effect: 'constructive',
    target: { kind: 'graph', scope: input => `causal/${(input as { id: string }).id}`, mode: 'write' },
    changes: [OW.CausalModel],
    async run(input, ctx) {
        try {
            const result = await applyStructureOperation(ctx.graph, input.id, input.operation, actorOf(ctx));
            await ctx.persist?.snapshot();
            return result;
        } catch (error) {
            return rethrowCausal(error);
        }
    },
});

/**
 * Der Bestand an Beobachtungen bleibt unberührt: Messreihen gehören
 * keinem Modell, sondern der Installation (Invariante C3). Ein gelöschtes
 * Modell ist eine verworfene Annahme, kein verworfener Datenbestand.
 */
export const deleteModel = defineAction({
    name: 'causal_delete_model',
    title: 'Kausalmodell entfernen',
    description: 'Entfernt ein Kausalmodell samt Graph; erfasste Beobachtungen bleiben erhalten.',
    input: withId,
    effect: 'destructive',
    target: { kind: 'graph', scope: input => `causal/${(input as { id: string }).id}` },
    changes: [OW.CausalModel],
    async run(input, ctx) {
        let removed: boolean;
        try {
            removed = await deleteCausalModel(ctx.graph, input.id);
        } catch (error) {
            return rethrowCausal(error);
        }
        if (!removed) throw notFound('Kausalmodell nicht gefunden.');
        await ctx.persist?.snapshot();
        return { deleted: true as const, message: 'Modell entfernt. Erfasste Beobachtungen bleiben erhalten.' };
    },
});

// ---------------------------------------------------------------------------
// Chronik (docs/spec-widersprueche.md, Eintrag 3)
// ---------------------------------------------------------------------------

/**
 * Verworfen wird immer ein ganzer Eintrag, ausdrücklich und einzeln. Die
 * Adresse wird aus der ID gebildet, nicht vom Aufrufer übernommen: Sonst
 * könnte ein Aufruf auf einen beliebigen Knoten im Namensraum zeigen.
 */
export const deleteArchiveEntryAction = defineAction({
    name: 'causal_delete_archive_entry',
    title: 'Chronik-Eintrag verwerfen',
    description: 'Verwirft einen Eintrag der Studien-Chronik (ein Lauf auf falschen Daten ist Störung, keine Geschichte).',
    input: z.object({ id: z.string().min(1).max(200) }),
    effect: 'destructive',
    target: { kind: 'graph', scope: 'causal-archive' },
    changes: [OW.CausalStudy],
    async run(input, ctx) {
        const removed = await deleteArchiveEntry(ctx.graph, ctx.graph.iri.entity('study-record', input.id));
        if (!removed) throw notFound('Chronik-Eintrag nicht gefunden.');
        await ctx.persist?.snapshot();
        return { deleted: true as const, message: 'Eintrag verworfen. Der nächste Lauf hält wieder fest, was sich ändert.' };
    },
});

// ---------------------------------------------------------------------------
// Fragen (ow:Estimand, C4) — Setzung des Menschen in graph/meta
// ---------------------------------------------------------------------------

export const listEstimandsAction = defineAction({
    name: 'causal_list_estimands',
    title: 'Fragen auflisten',
    description: 'Listet die Fragen an die Kausalmodelle (Estimands).',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'registry' },
    async run(_input, ctx) {
        return { estimands: await listEstimands(ctx.graph) };
    },
});

export const createEstimandAction = defineAction({
    name: 'causal_create_estimand',
    title: 'Frage anlegen',
    description: 'Legt eine Frage an ein Kausalmodell an (Behandlung, Wirkung, Schätzer); die Antwort entsteht im Studienlauf.',
    input: z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
        modelId: modelIdSchema,
        treatment: z.string().min(1).max(500).describe('IRI der Behandlungsvariable'),
        outcome: z.string().min(1).max(500).describe('IRI der Wirkungsvariable'),
        estimator: z.enum(ESTIMATOR_CHOICES).default('auto'),
        seed: z.number().int().min(0).max(2 ** 31).default(42),
        description: z.string().max(2000).optional(),
        controlOutcome: z.string().min(1).max(500).optional(),
        interventionAt: z.string().max(40).optional(),
        windowFrom: z.string().max(40).optional(),
        windowThrough: z.string().max(40).optional(),
        // Rechenraster in Sekunden; die inhaltliche Grenze (nie feiner als
        // die gröbste beteiligte Reihe) kennt erst das Panel.
        intervalSeconds: z.number().int().min(1).max(366 * 86400).optional(),
    }).strict(),
    effect: 'constructive',
    target: { kind: 'registry' },
    changes: [OW.Estimand],
    async run(input, ctx) {
        // Eine Frage ohne Modell wäre eine Frage ohne Annahme. Und lesen
        // muss der Fragende das Modell dürfen — sonst verriete die Frage,
        // dass es das Modell gibt (§17.3).
        const modelGraph = ctx.graph.iri.causalGraph(input.modelId);
        if (!ctx.grant.readableGraphs.includes(modelGraph)) throw notFound('Kausalmodell nicht gefunden.');
        const model = await readCausalModel(ctx.graph, { modelId: input.modelId, graph: modelGraph });
        if (!model) throw notFound('Kausalmodell nicht gefunden.');
        const known = new Set(model.variables.map(variable => variable.iri));
        for (const [label, value] of [
            ['Die Behandlung', input.treatment],
            ['Die Wirkung', input.outcome],
            ['Die Kontroll-Wirkung', input.controlOutcome],
        ] as const) {
            if (value !== undefined && !known.has(value)) {
                throw new ActionError(400, `${label} steht nicht im Modell „${model.name}".`);
            }
        }
        try {
            const estimand = await createEstimand(ctx.graph, input);
            await ctx.persist?.snapshot();
            return { estimand };
        } catch (error) {
            return withStatusFromMessage(error, [
                [/existiert bereits/, 409],
                [/Ungültige|braucht|dieselbe Größe|Zeitpunkt|Fenster|Startwert|Unbekanntes|Rechenraster/, 400],
            ]);
        }
    },
});

/**
 * Die Antworten verschwinden nicht mit dem Aufruf, sondern mit dem
 * nächsten Lauf: Der Inferenz-Graph wird vollständig ersetzt (C4).
 */
export const deleteEstimandAction = defineAction({
    name: 'causal_delete_estimand',
    title: 'Frage entfernen',
    description: 'Entfernt eine Frage; ihr Ergebnis verschwindet mit dem nächsten Studienlauf.',
    input: z.object({ id: z.string().min(1).max(64) }),
    effect: 'destructive',
    target: { kind: 'registry' },
    changes: [OW.Estimand],
    async run(input, ctx) {
        let removed: boolean;
        try {
            removed = await deleteEstimand(ctx.graph, input.id);
        } catch (error) {
            return rethrowCausal(error);
        }
        if (!removed) throw notFound('Frage nicht gefunden.');
        await ctx.persist?.snapshot();
        return { deleted: true as const, message: 'Frage entfernt. Ihr Ergebnis verschwindet mit dem nächsten Lauf.' };
    },
});

// ---------------------------------------------------------------------------
// Vorschläge: die neurosymbolische Schleife (§8, C6)
// ---------------------------------------------------------------------------

export const listHypotheses = defineAction({
    name: 'causal_list_hypotheses',
    title: 'Vorschläge auflisten',
    description: 'Listet die Kanten-Vorschläge der Quellen (Sprachmodell, Topologie, Wikidata) mit Urteil und Begründung.',
    input: z.object({ modelId: modelIdSchema.optional() }),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(input, ctx) {
        const hypotheses = await readHypotheses(ctx.graph, {
            allowedGraphs: ctx.grant.readableGraphs,
            ...(input.modelId ? { modelId: input.modelId } : {}),
        });
        return { hypotheses };
    },
});

/**
 * Ein Lauf ersetzt die Vorschläge je Quelle (§6.2-Muster). Geschrieben
 * wird ausschließlich nach `causal-hypotheses` — nie in ein Modell; der
 * Weg dorthin führt über das Übernehmen, und das prüft die Filter erneut.
 */
export const proposeAction = defineAction({
    name: 'causal_propose',
    title: 'Vorschläge einholen',
    description: 'Befragt die Vorschlagsquellen zu einem Kausalmodell, filtert die Kandidaten und ersetzt die Vorschläge je Quelle.',
    input: z.object({
        modelId: modelIdSchema,
        sources: z.array(z.enum(PROPOSAL_SOURCES)).min(1).optional(),
    }).strict(),
    effect: 'constructive',
    target: { kind: 'graph', scope: 'causal-hypotheses' },
    requires: ['platform'],
    changes: [OW.CausalModel, PROV.Activity],
    async run(input, ctx) {
        requireCausalTier(ctx, 'Diese Runtime prüft keine kausalen Vorschläge.');
        const handle = ctx.graph;
        const allowedGraphs = ctx.grant.readableGraphs;
        let summary;
        try {
            summary = await runProposalSources(handle, input.modelId, {
                ...(input.sources ? { sources: input.sources } : {}),
                allowedGraphs,
            });
        } catch (error) {
            return rethrowCausal(error);
        }
        // Vorschläge sind behauptet und persistiert — anders als eine
        // Studie überleben sie den Neustart.
        await ctx.persist?.snapshot();
        const hypotheses = await readHypotheses(handle, { allowedGraphs, modelId: input.modelId });
        const model = await readCausalModel(handle, {
            modelId: input.modelId,
            graph: handle.iri.causalGraph(input.modelId),
        }, { withStudies: false });
        const names = new Map((model?.variables ?? []).map(variable => [variable.iri, variable.name]));
        for (const hypothesis of hypotheses) {
            names.set(hypothesis.from, hypothesis.fromName);
            names.set(hypothesis.to, hypothesis.toName);
        }
        return {
            ...summary,
            hypotheses,
            comparison: compareStructureSources(hypotheses, model?.edges ?? [], node => names.get(node) ?? node),
        };
    },
});

/** Ziel eines Vorschlags ist das Modell, in das er übernommen würde. */
async function hypothesisModelScope(input: unknown, ctx: ActionContext): Promise<string> {
    const hypothesis = await getHypothesis(ctx.graph, (input as { id: string }).id);
    if (!hypothesis) throw notFound('Diesen Vorschlag gibt es nicht.');
    return `causal/${hypothesis.modelId}`;
}

/**
 * Das Übernehmen ist die einzige Brücke vom Hypothesen-Graphen in die
 * gesetzte Struktur. Ein von den Filtern verworfener Vorschlag wird hier
 * abgelehnt, nicht bloß in der Oberfläche ausgegraut (C6-Abnahme).
 */
export const adoptHypothesisAction = defineAction({
    name: 'causal_adopt_hypothesis',
    title: 'Vorschlag übernehmen',
    description: 'Übernimmt einen zulässigen Kanten-Vorschlag in sein Kausalmodell (die Filter werden erneut geprüft).',
    input: z.object({ id: z.string().min(1).max(200) }),
    effect: 'constructive',
    target: { kind: 'graph', scope: hypothesisModelScope, mode: 'write' },
    changes: [OW.CausalModel],
    async run(input, ctx) {
        try {
            const result = await adoptHypothesis(ctx.graph, input.id, actorOf(ctx));
            await ctx.persist?.snapshot();
            return result;
        } catch (error) {
            return rethrowCausal(error);
        }
    },
});

export const discardHypothesisAction = defineAction({
    name: 'causal_discard_hypothesis',
    title: 'Vorschlag verwerfen',
    description: 'Verwirft einen Vorschlag aus der Arbeitsliste; der nächste Lauf derselben Quelle nennt ihn wieder.',
    input: z.object({ id: z.string().min(1).max(200) }),
    effect: 'destructive',
    target: { kind: 'graph', scope: 'causal-hypotheses' },
    changes: [OW.CausalModel],
    async run(input, ctx) {
        const removed = await discardHypothesis(ctx.graph, input.id);
        if (!removed) throw notFound('Diesen Vorschlag gibt es nicht.');
        await ctx.persist?.snapshot();
        return {
            deleted: true as const,
            message: 'Vorschlag verworfen. Der nächste Lauf derselben Quelle nennt ihn wieder — '
                + 'aufgeräumt wird eine Arbeitsliste, keine Meinung.',
        };
    },
});

// ---------------------------------------------------------------------------
// Studien: der Lauf und sein Ergebnis (§13, C4)
// ---------------------------------------------------------------------------

export const listStudies = defineAction({
    name: 'causal_list_studies',
    title: 'Studien auflisten',
    description: 'Liest die Studien (Effektschätzungen) aus dem Inferenz-Graphen des Kausal-Layers.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'graph', scope: 'inferred/causal/workspace' },
    async run(_input, ctx) {
        return { studies: await readCausalStudies(ctx.graph) };
    },
});

/**
 * Ein Lauf rechnet alle Fragen und ersetzt den Inferenz-Graphen
 * vollständig (Invariante C4). Der Inferenz-Graph wird nie persistiert
 * (§8.1) — die Chronik schon: Ein Lauf, der etwas festgehalten hat,
 * schreibt den Snapshot.
 */
export const runStudies = defineAction({
    name: 'causal_run_studies',
    title: 'Studien rechnen',
    description: 'Rechnet alle Fragen neu (Schätzung, Intervall, Refutation) und ersetzt den Inferenz-Graphen des Kausal-Layers.',
    input: z.object({}),
    effect: 'constructive',
    target: { kind: 'graph', scope: 'inferred/causal/workspace' },
    requires: ['platform'],
    changes: [OW.CausalStudy, PROV.Activity],
    async run(_input, ctx) {
        requireCausalTier(ctx, 'Diese Runtime rechnet keine Kausalstudien.');
        const summary = await runCausalStudiesOnServer(ctx.graph, actorOf(ctx));
        if (summary.archived.length > 0) await ctx.persist?.snapshot();
        return {
            scope: summary.scope,
            graph: summary.graph,
            generatedAt: summary.generatedAt,
            durationMs: summary.durationMs,
            counts: {
                total: summary.results.length,
                passed: summary.results.filter(result => result.verdict === 'passed').length,
                refuted: summary.results.filter(result => result.verdict === 'refuted').length,
                notEstimable: summary.results.filter(result => result.verdict === 'not-estimable').length,
                notIdentifiable: summary.results.filter(result => result.verdict === 'not-identifiable').length,
            },
            skipped: summary.skipped,
            archived: summary.archived,
            // Was die Signaturprüfung nicht bestand, wurde nicht geschrieben
            // (Invariante C7) — gemeldet wird es trotzdem.
            rejected: summary.rejected.map(entry => ({
                estimandId: entry.estimandId,
                messages: entry.violations.map(violation => violation.message),
            })),
            studies: await readCausalStudies(ctx.graph),
            archive: await readCausalArchive(ctx.graph, { limit: ARCHIVE_LIMIT }),
        };
    },
});

registerActions('graph/causal', [
    causalOverview, createModel, getModel, editModel, deleteModel, deleteArchiveEntryAction,
    listEstimandsAction, createEstimandAction, deleteEstimandAction,
    listHypotheses, proposeAction, adoptHypothesisAction, discardHypothesisAction,
    listStudies, runStudies,
]);
