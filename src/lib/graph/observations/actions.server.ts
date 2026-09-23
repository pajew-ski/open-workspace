/**
 * Aktionen der Beobachtungsgrößen (ACTIONS_SPEC, A4; CAUSAL_LAYER_SPEC
 * §5/§6, C3): Definition, Erfassungszustand, Messreihe, Rückgriff auf
 * Long-Term-Statistics und der Erfassungslauf auf Anforderung.
 *
 * Die Definition ist ein Registry-Eintrag des Aufrufers in graph/meta;
 * die Werte stehen NICHT im Store (Invariante C3), sondern im
 * Beobachtungsspeicher auf dem Dateibaum — deshalb brauchen Reihe,
 * Rückgriff und Lauf `platform`, und ohne Dateibaum gibt es sie nicht.
 */

import { z } from 'zod';
import { ActionError, defineAction, notFound, withStatusFromMessage, type ActionContext } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { OW } from '../vocab';
import { backfillFromStatistics, DEFAULT_STATISTICS_DAYS, MAX_STATISTICS_DAYS } from './backfill';
import { findCandidate, listCaptureCandidates } from './candidates';
import { variableIdFor } from './naming';
import { captureScheduleStatus, dataRoot, runCaptureOnce } from './schedule.server';
import { ObservationStore } from './store';
import { ALLOWED_AGGREGATIONS } from './types';
import { createVariable, deleteVariable, getVariable, listVariables, updateVariable } from './variables';

const variableIdSchema = z.string().min(1).max(200);
const aggregationSchema = z.enum(['last', 'mean', 'min', 'max', 'sum']);

/**
 * Quellarten, für die es eine Erfassung gibt (`observations/sources.ts`).
 * Eine Quelle ohne Erfassung wird gar nicht erst aufgenommen: Sonst
 * stünde im Graphen eine Größe, die bei jedem Lauf scheitert
 * (Invariante 10 — keine Attrappen).
 */
const CAPTURABLE_SOURCE_KINDS: ReadonlySet<string> = new Set([
    'home-assistant', 'rest-timeseries', 'csv-observations', 'solar-position',
]);

/** Harte Obergrenze je Anfrage — wie überall im Graph-Kern (SPEC §7.5). */
const MAX_POINTS = 50_000;
const DEFAULT_POINTS = 5_000;

const VARIABLE_ERROR_RULES: ReadonlyArray<readonly [RegExp, number]> = [
    [/existiert bereits/, 409],
    [/nicht zulässig|Ungültige/, 400],
];

/** Sinnvolle Verdichtung je Skalenniveau, wenn der Aufrufer keine nennt. */
function defaultAggregation(kind: 'numeric' | 'binary' | 'categorical'): 'last' | 'mean' {
    return kind === 'numeric' ? 'mean' : 'last';
}

function observationStore(ctx: ActionContext): ObservationStore {
    return new ObservationStore({
        files: ctx.platform!.files,
        root: dataRoot(),
        userId: ctx.graph.iri.userId,
    });
}

export const observationsOverview = defineAction({
    name: 'observations_overview',
    title: 'Beobachtungsgrößen',
    description: 'Erfasste Beobachtungsgrößen mit Zustand, erfassbare Kandidaten aus dem Graphen und der Zeitgeber.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'registry' },
    async run(_input, ctx) {
        const variables = await listVariables(ctx.graph);
        const captured = new Map(variables.map(variable => [variable.source, variable.id]));
        const candidates = (await listCaptureCandidates(ctx.graph.store, ctx.graph.iri, { allowedGraphs: ctx.grant.readableGraphs }))
            .map(candidate => ({
                ...candidate,
                ...(captured.has(candidate.source) ? { variableId: captured.get(candidate.source) } : {}),
            }));
        return {
            variables,
            candidates,
            schedule: captureScheduleStatus(),
            allowedAggregations: ALLOWED_AGGREGATIONS,
        };
    },
});

export const createVariableAction = defineAction({
    name: 'observations_create_variable',
    title: 'Größe erfassen',
    description: 'Nimmt eine im Graphen bekannte Quelle (z. B. eine Home-Assistant-Entität) zur Erfassung als Beobachtungsgröße auf.',
    input: z.object({
        source: z.string().min(1).max(255).describe('Quellschlüssel (z. B. HA entity_id) — muss im Graphen bekannt sein'),
        name: z.string().min(1).max(200).optional(),
        aggregation: aggregationSchema.optional(),
        intervalSeconds: z.number().int().min(10).max(86_400).default(300),
        retentionDays: z.number().int().min(0).max(36_500).default(0),
    }).strict(),
    effect: 'constructive',
    target: { kind: 'registry' },
    changes: [OW.Variable],
    async run(input, ctx) {
        // Die Quelle muss im Graphen stehen. Sonst entstünde eine Variable
        // ohne Skalenniveau und ohne Ort — und damit eine Reihe, deren
        // Verdichtung niemand prüfen kann.
        const candidate = await findCandidate(ctx.graph.store, ctx.graph.iri, input.source, { allowedGraphs: ctx.grant.readableGraphs });
        if (!candidate) {
            throw new ActionError(404, `Die Quelle "${input.source}" ist im Graphen nicht bekannt.`,
                'Synchronisiere zuerst die passende Quelle unter Graph → Quellen (Home Assistant oder eine offene Zeitreihe).');
        }
        if (!CAPTURABLE_SOURCE_KINDS.has(candidate.sourceKind)) {
            throw new ActionError(422, `Für die Quellart "${candidate.sourceKind}" gibt es keine Erfassung.`,
                `Erfassbar sind: ${[...CAPTURABLE_SOURCE_KINDS].join(', ')}.`);
        }
        try {
            const variable = await createVariable(ctx.graph, {
                id: variableIdFor(input.source),
                name: input.name ?? candidate.name,
                sourceKind: candidate.sourceKind,
                source: candidate.source,
                kind: candidate.kind,
                aggregation: input.aggregation ?? defaultAggregation(candidate.kind),
                intervalSeconds: input.intervalSeconds,
                ...(candidate.unit ? { unit: candidate.unit } : {}),
                ...(candidate.placeIri ? { placeIri: candidate.placeIri } : {}),
                sensorIri: candidate.iri,
                retentionDays: input.retentionDays,
            });
            await ctx.persist?.snapshot();
            return { variable };
        } catch (error) {
            return withStatusFromMessage(error, VARIABLE_ERROR_RULES);
        }
    },
});

export const getVariableAction = defineAction({
    name: 'observations_get_variable',
    title: 'Größe lesen',
    description: 'Liest die Definition und den Erfassungszustand einer Beobachtungsgröße.',
    input: z.object({ id: variableIdSchema }),
    effect: 'read',
    target: { kind: 'registry' },
    async run(input, ctx) {
        const variable = await getVariable(ctx.graph, input.id);
        if (!variable) throw notFound('Beobachtungsgröße nicht gefunden.');
        return { variable };
    },
});

export const updateVariableAction = defineAction({
    name: 'observations_update_variable',
    title: 'Größe ändern',
    description: 'Ändert Name, Ein/Aus, Aufbewahrung oder Verdichtung einer Beobachtungsgröße.',
    input: z.object({
        id: variableIdSchema,
        name: z.string().min(1).max(200).optional(),
        enabled: z.boolean().optional(),
        retentionDays: z.number().int().min(0).max(36_500).optional(),
        aggregation: aggregationSchema.optional(),
    }).strict(),
    effect: 'constructive',
    target: { kind: 'registry' },
    changes: [OW.Variable],
    async run(input, ctx) {
        const { id, ...patch } = input;
        try {
            const variable = await updateVariable(ctx.graph, id, patch);
            if (!variable) throw notFound('Beobachtungsgröße nicht gefunden.');
            await ctx.persist?.snapshot();
            return { variable };
        } catch (error) {
            return withStatusFromMessage(error, VARIABLE_ERROR_RULES);
        }
    },
});

/**
 * Löschen ist zweistufig: Der erfasste Bestand ist genau das, was die
 * Quelle nicht mehr hat. Ihn mit der Definition wegzuwerfen, wäre für
 * einen Fehlklick eine unwiederbringliche Strafe — deshalb bleibt er
 * liegen, bis jemand ausdrücklich `purge` verlangt (und das braucht den
 * Dateibaum).
 */
export const deleteVariableAction = defineAction({
    name: 'observations_delete_variable',
    title: 'Größe entfernen',
    description: 'Entfernt die Definition einer Beobachtungsgröße; mit purge auch den erfassten Bestand.',
    input: z.object({ id: variableIdSchema, purge: z.boolean().default(false) }),
    effect: 'destructive',
    target: { kind: 'registry' },
    changes: [OW.Variable],
    async run(input, ctx) {
        if (input.purge && !ctx.platform) {
            throw new ActionError(501, 'Der erfasste Bestand ist aus diesem Kontext nicht erreichbar.');
        }
        const removed = await deleteVariable(ctx.graph, input.id);
        if (!removed) throw notFound('Beobachtungsgröße nicht gefunden.');
        const purgedSegments = input.purge ? await observationStore(ctx).drop(input.id) : 0;
        await ctx.persist?.snapshot();
        return {
            deleted: true as const,
            purgedSegments,
            message: input.purge
                ? `Größe entfernt, ${purgedSegments} Tagesdatei(en) gelöscht.`
                : 'Größe entfernt. Der erfasste Bestand bleibt erhalten.',
        };
    },
});

/**
 * Der Lesepfad, den jeder Schätzer benutzt: Zeitstempel und Werte,
 * aufsteigend, mit ausgewiesenen Lücken. Bewusst KEIN SPARQL — die Werte
 * stehen nicht im Store (Invariante C3).
 */
export const readSeries = defineAction({
    name: 'observations_series',
    title: 'Messreihe lesen',
    description: 'Liest die Messreihe einer Beobachtungsgröße (Zeitstempel, Werte, Qualität) in einem Zeitfenster.',
    input: z.object({
        id: variableIdSchema,
        from: z.string().max(40).optional().describe('ISO-Zeitpunkt, inklusiv'),
        to: z.string().max(40).optional().describe('ISO-Zeitpunkt, inklusiv'),
        limit: z.number().int().min(1).max(MAX_POINTS).default(DEFAULT_POINTS),
    }),
    effect: 'read',
    target: { kind: 'registry' },
    requires: ['platform'],
    async run(input, ctx) {
        const variable = await getVariable(ctx.graph, input.id);
        if (!variable) throw notFound('Beobachtungsgröße nicht gefunden.');
        const from = parseTimestamp(input.from);
        const to = parseTimestamp(input.to);
        const result = await observationStore(ctx).read(input.id, {
            // `after` ist exklusiv; `from` meint inklusiv — deshalb der Schritt.
            ...(from !== undefined ? { after: from - 1 } : {}),
            ...(to !== undefined ? { through: to } : {}),
            limit: input.limit,
        });
        return {
            variable: {
                id: variable.id,
                name: variable.name,
                kind: variable.kind,
                aggregation: variable.aggregation,
                intervalSeconds: variable.intervalSeconds,
                unit: variable.unit,
            },
            points: result.observations.map(point => ({
                t: new Date(point.t).toISOString(),
                v: point.v,
                ...(point.q ? { q: point.q } : {}),
            })),
            count: result.observations.length,
            truncated: result.truncated,
            // Ehrlich gemeldet statt still übersprungen: eine defekte Zeile
            // ist ein Hinweis auf einen abgebrochenen Schreibvorgang.
            corruptLines: result.corruptLines,
        };
    },
});

function parseTimestamp(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Rückgriff auf die Long-Term-Statistics — einmalig, bewusst ohne
 * Zeitgeber: Ein wiederholter Lauf ist ein No-Op, kostet aber eine
 * WebSocket-Verbindung und einen Abruf über Monate. `status` sagt, ob
 * gefüllt, verweigert (die Quelle kann diese Größe nicht liefern) oder
 * gescheitert wurde; die Route bildet das auf 200/409/502 ab.
 */
export const backfillAction = defineAction({
    name: 'observations_backfill',
    title: 'Historie nachfüllen',
    description: 'Füllt die Messreihe einer Größe einmalig aus den Long-Term-Statistics der Quelle zurück (Default ein Jahr).',
    input: z.object({
        id: variableIdSchema,
        days: z.number().int().min(1).max(MAX_STATISTICS_DAYS).default(DEFAULT_STATISTICS_DAYS),
    }).strict(),
    effect: 'constructive',
    target: { kind: 'registry' },
    requires: ['platform'],
    changes: [OW.Variable],
    async run(input, ctx) {
        let result;
        try {
            result = await backfillFromStatistics(ctx.graph, input.id, {
                files: ctx.platform!.files,
                root: dataRoot(),
                days: input.days,
            });
        } catch (error) {
            return withStatusFromMessage(error, [[/gibt es nicht/, 404]]);
        }
        if (result.status === 'filled') await ctx.persist?.snapshot();
        return result;
    },
});

/**
 * Der reguläre Weg ist der Zeitgeber im Serverprozess; das hier ist der
 * Knopf daneben — für den ersten Lauf nach dem Einrichten, für
 * Installationen, die von außen takten, und für die Fehlersuche.
 */
export const captureAction = defineAction({
    name: 'observations_capture',
    title: 'Erfassungslauf',
    description: 'Erfasst jetzt einen Wert je aktiver Beobachtungsgröße (oder nur der genannten).',
    input: z.object({
        ids: z.array(variableIdSchema).max(200).optional(),
    }).strict(),
    effect: 'constructive',
    target: { kind: 'registry' },
    requires: ['platform'],
    changes: [OW.Variable],
    async run(input, ctx) {
        const report = await runCaptureOnce(ctx.graph, input.ids);
        await ctx.persist?.snapshot();
        return report;
    },
});

registerActions('graph/observations', [
    observationsOverview, createVariableAction, getVariableAction, updateVariableAction, deleteVariableAction,
    readSeries, backfillAction, captureAction,
]);
