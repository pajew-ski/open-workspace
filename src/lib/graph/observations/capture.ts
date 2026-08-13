/**
 * Der Erfassungslauf — „früh materialisieren" (CAUSAL_LAYER_SPEC §6).
 *
 * **Warum das die zeitkritische Komponente des ganzen Kausal-Layers ist**:
 * Home Assistants Recorder hält vollständige Zustandswechsel nur wenige
 * Tage (`purge_keep_days`, Standard 10). Danach bleiben ausschließlich
 * Long-Term-Statistics — stündliche Aggregate, und die auch nur für
 * numerische Sensoren mit `state_class`. Schalter, Fenster, Bewegungs-
 * melder, Anwesenheit, Automations-Zustände: alles, was in einem
 * Kausalmodell die TREATMENT-Seite trägt, ist nach zehn Tagen ersatzlos
 * fort. Die Outcome-Seite überlebt, die Ursachenseite nicht.
 *
 * Genau diese Asymmetrie schließt dieser Lauf: Er kopiert eine
 * ausgewählte Teilmenge — nicht alles, sonst wäre er ein zweiter Recorder
 * — in einen eigenen, dauerhaften Bestand, verdichtet auf ein reguläres
 * Raster.
 *
 * Ablauf je Größe:
 *  1. **Fenster bestimmen.** Ohne Wasserzeichen ist es ein Backfill: so
 *     weit zurück, wie die Quelle noch etwas hat. Mit Wasserzeichen nur
 *     das, was seither dazugekommen ist.
 *  2. **Rohwerte holen**, in Zeitscheiben, damit eine Antwort nie
 *     unbegrenzt groß wird.
 *  3. **Verdichten** auf den Abtastabstand der Größe (`resample.ts`).
 *  4. **Anhängen**, strikt nach dem Wasserzeichen — dadurch ist jeder
 *     Lauf idempotent und ein Wiederholen erzeugt keine Dubletten.
 *  5. **Aufräumen** nach Aufbewahrungsfrist (Default: unbegrenzt).
 *  6. **Zustand schreiben**: Von-Bis, Anzahl, letzter Lauf — im Graphen,
 *     damit die Abdeckung per SPARQL abfragbar ist.
 *
 * Fehlerbild wie beim Connector-Runner: Ein Fehler bei einer Größe
 * beendet nie den Lauf der anderen; er landet im Zustand dieser einen.
 */

import type { FileSystemLike } from '@/lib/platform/runtime/types';
import { createGuardedFetch } from '../connectors/http';
import { clientFor, type HomeAssistantConfig } from '../connectors/home-assistant';
import type { HomeAssistantClient } from '../connectors/home-assistant/api';
import { parseState } from '../connectors/home-assistant/structure';
import { getConnector, listConnectors } from '../connectors/registry';
import { getConnectorKind } from '../connectors/catalog';
import { ObservationStore } from './store';
import { resample, type RawPoint } from './resample';
import { listVariables, saveVariable, type GraphHandle } from './variables';
import type { CaptureResult, VariableView } from './types';

/** Zeitscheibe eines Abrufs. Größer heißt weniger Anfragen, aber fettere Antworten. */
const SLICE_HOURS = 24;

/**
 * Wie weit ein Backfill zurückgreift. 14 Tage decken den üblichen
 * Recorder-Horizont (10 Tage) mit Reserve ab; alles Ältere ist über die
 * REST-Historie ohnehin nicht mehr zu holen.
 */
export const DEFAULT_BACKFILL_DAYS = 14;

/** Höchstzahl Rohpunkte je Größe und Lauf — Schutz vor Ausreißer-Sensoren. */
const MAX_RAW_POINTS = 200_000;

export interface CaptureOptions {
    files: FileSystemLike;
    /** Datenwurzel der Installation (server: `<cwd>/data`). */
    root: string;
    /** Nur diese Größen erfassen; ohne Angabe alle aktiven. */
    variableIds?: ReadonlyArray<string>;
    backfillDays?: number;
    now?: () => Date;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    /** Nur für Tests: fertiger Client statt Auflösung über die Registry. */
    clientOverride?: HomeAssistantClient;
}

export interface CaptureRunReport {
    results: CaptureResult[];
    startedAt: string;
    finishedAt: string;
    /** Kurzfassung in einem Satz (deutsch). */
    message: string;
}

function isoOf(ms: number): string {
    return new Date(ms).toISOString();
}

/**
 * Sucht den `home-assistant`-Connector der Installation. Ohne ihn gibt es
 * keinen Zugang — und das ist ein ehrlicher Fehler, keine leere Erfassung.
 */
async function resolveHomeAssistantClient(
    handle: GraphHandle,
    options: CaptureOptions,
): Promise<HomeAssistantClient> {
    if (options.clientOverride) return options.clientOverride;
    const connectors = await listConnectors(handle);
    const entry = connectors.find(connector => connector.kind === 'home-assistant');
    if (!entry) {
        throw new Error(
            'Keine Home-Assistant-Verbindung eingerichtet. Lege unter Graph → Quellen einen ' +
            'Connector der Art "home-assistant" an.',
        );
    }
    const view = await getConnector(handle, entry.id);
    const impl = getConnectorKind('home-assistant');
    if (!view || !impl) throw new Error('Die Home-Assistant-Verbindung ist nicht lesbar.');
    const config = impl.configFromLocator(view.locator) as HomeAssistantConfig;
    const fetchImpl = createGuardedFetch({ fetchImpl: options.fetchImpl, signal: options.signal });
    return clientFor(config, { fetch: fetchImpl });
}

/**
 * Holt Rohpunkte einer Entität in Zeitscheiben. Die Scheiben halten die
 * Antwortgröße beherrschbar; ohne sie wäre ein Backfill über zwei Wochen
 * bei einem sekündlich wechselnden Sensor ein einziger, riesiger Abruf.
 */
async function fetchRawPoints(
    client: HomeAssistantClient,
    entityId: string,
    kind: VariableView['kind'],
    fromMs: number,
    toMs: number,
): Promise<{ points: RawPoint[]; truncated: boolean }> {
    const points: RawPoint[] = [];
    const sliceMs = SLICE_HOURS * 3600_000;
    let truncated = false;
    for (let start = fromMs; start < toMs; start += sliceMs) {
        const end = Math.min(start + sliceMs, toMs);
        const history = await client.history([entityId], isoOf(start), isoOf(end));
        for (const point of history) {
            if (point.entityId !== entityId) continue;
            const parsed = parseState(point.state, kind);
            points.push({
                t: point.t,
                value: parsed.value,
                ...(parsed.gap ? { gap: parsed.gap } : {}),
            });
            if (points.length >= MAX_RAW_POINTS) {
                truncated = true;
                break;
            }
        }
        if (truncated) break;
    }
    return { points, truncated };
}

/** Erfasst genau eine Größe. Wirft nie — Fehler stehen im Ergebnis. */
async function captureVariable(
    handle: GraphHandle,
    variable: VariableView,
    client: HomeAssistantClient,
    observations: ObservationStore,
    options: CaptureOptions,
): Promise<CaptureResult> {
    const now = (options.now ?? (() => new Date()))();
    const nowMs = now.getTime();
    const backfillDays = options.backfillDays ?? DEFAULT_BACKFILL_DAYS;

    if (!variable.enabled) {
        return {
            variableId: variable.id,
            status: 'skipped',
            appended: 0,
            pruned: 0,
            backfill: false,
            message: 'Erfassung ist ausgeschaltet.',
        };
    }

    const watermark = variable.status.capturedThrough ? Date.parse(variable.status.capturedThrough) : NaN;
    const hasWatermark = Number.isFinite(watermark);
    const backfill = !hasWatermark;
    const fromMs = hasWatermark ? watermark : nowMs - backfillDays * 86_400_000;

    try {
        const { points, truncated } = await fetchRawPoints(client, variable.source, variable.kind, fromMs, nowMs);
        const resampled = resample(points, {
            intervalSeconds: variable.intervalSeconds,
            aggregation: variable.aggregation,
            kind: variable.kind,
            after: hasWatermark ? watermark : undefined,
            through: nowMs,
            carry: undefined,
        });
        const appended = await observations.append(variable.id, resampled, {
            after: hasWatermark ? watermark : undefined,
        });

        let pruned = 0;
        if (variable.retentionDays > 0) {
            const cutoff = nowMs - variable.retentionDays * 86_400_000;
            pruned = (await observations.prune(variable.id, cutoff)).pruned;
        }

        // Abdeckung und Anzahl aus dem BESTAND lesen, nicht hochzählen:
        // Aufräumen, externe Eingriffe und abgebrochene Läufe machen jeden
        // mitgeführten Zähler früher oder später unwahr.
        const coverage = await observations.coverage(variable.id);
        const summaryParts = [`${appended.appended} Messpunkte übernommen`];
        if (pruned > 0) summaryParts.push(`${pruned} nach Aufbewahrungsfrist entfernt`);
        if (backfill) summaryParts.push(`Erstbefüllung über ${backfillDays} Tage`);
        if (truncated) summaryParts.push(`bei ${MAX_RAW_POINTS} Rohpunkten gekappt`);
        const summary = `${summaryParts.join(', ')}.`;

        const next: VariableView = {
            ...variable,
            status: {
                state: 'idle',
                ...(coverage.from !== undefined ? { capturedFrom: isoOf(coverage.from) } : {}),
                // Das Wasserzeichen ist das Ende des ABGEFRAGTEN Fensters,
                // nicht der jüngste Messpunkt: Ein Sensor, der stundenlang
                // schweigt, dürfte sonst dasselbe leere Fenster endlos neu
                // abfragen.
                capturedThrough: isoOf(Math.max(coverage.through ?? 0, hasWatermark ? watermark : fromMs, nowMs)),
                count: coverage.count,
                lastRun: { at: now.toISOString(), summary, errors: [] },
            },
        };
        await saveVariable(handle, next);

        return {
            variableId: variable.id,
            status: appended.appended > 0 ? 'captured' : 'noop',
            appended: appended.appended,
            pruned,
            from: coverage.from !== undefined ? isoOf(coverage.from) : undefined,
            through: next.status.capturedThrough,
            backfill,
            message: summary,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await saveVariable(handle, {
            ...variable,
            status: {
                ...variable.status,
                state: 'error',
                lastRun: {
                    at: now.toISOString(),
                    summary: `Erfassung fehlgeschlagen: ${message}`,
                    errors: [message],
                },
            },
        });
        return {
            variableId: variable.id,
            status: 'failed',
            appended: 0,
            pruned: 0,
            backfill,
            message: `Erfassung fehlgeschlagen: ${message}`,
        };
    }
}

/**
 * Führt einen Erfassungslauf über alle (oder die benannten) Größen aus.
 * Läuft seriell: Home Assistant ist eine Installation auf einem
 * Kleinrechner, und zwanzig parallele Historien-Abrufe sind dort kein
 * Durchsatzgewinn, sondern ein Ausfallrisiko.
 */
export async function captureObservations(
    handle: GraphHandle,
    options: CaptureOptions,
): Promise<CaptureRunReport> {
    const now = options.now ?? (() => new Date());
    const startedAt = now().toISOString();
    const all = await listVariables(handle);
    const selected = options.variableIds
        ? all.filter(variable => options.variableIds?.includes(variable.id))
        : all.filter(variable => variable.enabled);

    if (selected.length === 0) {
        const finishedAt = now().toISOString();
        return {
            results: [],
            startedAt,
            finishedAt,
            message: 'Keine aktive Beobachtungsgröße — nichts zu erfassen.',
        };
    }

    const observations = new ObservationStore({
        files: options.files,
        root: options.root,
        userId: handle.iri.userId,
    });

    let client: HomeAssistantClient;
    try {
        client = await resolveHomeAssistantClient(handle, options);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const finishedAt = now().toISOString();
        return {
            results: selected.map(variable => ({
                variableId: variable.id,
                status: 'failed' as const,
                appended: 0,
                pruned: 0,
                backfill: false,
                message,
            })),
            startedAt,
            finishedAt,
            message: `Erfassung nicht möglich: ${message}`,
        };
    }

    const results: CaptureResult[] = [];
    for (const variable of selected) {
        if (options.signal?.aborted) break;
        results.push(await captureVariable(handle, variable, client, observations, options));
    }

    const appended = results.reduce((sum, result) => sum + result.appended, 0);
    const failed = results.filter(result => result.status === 'failed').length;
    const parts = [`${appended} Messpunkte aus ${results.length} Größen übernommen`];
    if (failed > 0) parts.push(`${failed} fehlgeschlagen`);
    return {
        results,
        startedAt,
        finishedAt: now().toISOString(),
        message: `${parts.join(', ')}.`,
    };
}
