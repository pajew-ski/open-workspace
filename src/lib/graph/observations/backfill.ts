/**
 * Rückgriff auf die Long-Term-Statistics — der Bestand wächst nach hinten
 * (CAUSAL_LAYER_SPEC §15.5, offen geblieben aus C3).
 *
 * Die Erfassung (C3) hält fest, was ab ihrem ersten Lauf geschieht. Für
 * die Zeit davor gibt es genau eine Quelle, und sie ist halbiert: Home
 * Assistants Long-Term-Statistics führen **stündliche Aggregate**, und
 * die nur für numerische Größen mit `state_class`. Schalter, Fenster,
 * Anwesenheit — die ganze Ursachenseite — stehen dort nicht. Ein
 * Rückgriff verlängert deshalb die Wirkungsseite und niemals die
 * Ursachenseite; er ersetzt die Erfassung nicht, er ergänzt sie um das,
 * was ohne sie nur noch als Aggregat existiert.
 *
 * Die Regeln, nach denen das geschieht — jede einzelne davon verhindert
 * eine bestimmte stille Unwahrheit:
 *
 *  1. **Nur, wo nichts liegt.** Ein Tag mit erfassten Messpunkten wird
 *     nie angefasst (`ObservationStore.backfill`). Der feine Bestand hat
 *     immer Vorrang vor dem Aggregat, und keine Datei vermischt beides.
 *  2. **Nur außerhalb der Reichweite der Erfassung.** Die Obergrenze ist
 *     der älteste erfasste Punkt, höchstens aber der Beginn des
 *     Rückgriff-Fensters der Erfassung (14 Tage): Was die Erfassung noch
 *     in voller Auflösung holen kann, holt sie selbst.
 *  3. **Nur ganze Tage.** Die Grenze wird auf Mitternacht (UTC) abgerundet
 *     — die Partitionierung des Speichers ist tageweise, und ein halb
 *     gefüllter Tag wäre eine Datei, die nie wieder vervollständigt wird.
 *  4. **Ein Aggregat je Stunde bleibt ein Punkt je Stunde** (§statistics.ts).
 *  5. **Die Strecke wird benannt** (`ow:aggregatedFrom/-Through/
 *     ow:aggregateInterval`), damit niemand einen Stundenmittelwert für
 *     eine Messung hält — auch keine spätere Studie (C7).
 *
 * Ein Lauf ist damit idempotent: Beim zweiten Mal sind die Tage da, und
 * es wird nichts geschrieben.
 */

import type { FileSystemLike } from '@/lib/platform/runtime/types';
import { createGuardedWebSocketOpener, type WebSocketOpener } from '../connectors/home-assistant/websocket';
import { resolveHaAccess } from '../connectors/home-assistant/api';
import {
    HomeAssistantStatisticsClient,
    STATISTICS_PERIOD_SECONDS,
    statisticsFieldFor,
    statisticsPoints,
    type StatisticsPeriod,
} from '../connectors/home-assistant/statistics';
import { ObservationStore } from './store';
import { DEFAULT_BACKFILL_DAYS } from './capture';
import { resolveHomeAssistantConfig } from './sources';
import { getVariable, saveVariable, type GraphHandle } from './variables';
import type { Observation, VariableView } from './types';

/** Wie weit ein Rückgriff standardmäßig zurückgeht: ein Jahr. */
export const DEFAULT_STATISTICS_DAYS = 365;
/** Obergrenze — fünf Jahre Stundenwerte sind rund 44 000 Punkte je Größe. */
export const MAX_STATISTICS_DAYS = 1825;

/** Raster der Statistik, das hier gebraucht wird. */
const PERIOD: StatisticsPeriod = 'hour';

export interface StatisticsBackfillOptions {
    files: FileSystemLike;
    /** Datenwurzel der Installation (server: `<cwd>/data`). */
    root: string;
    /** Wie weit zurück (Tage). Default: ein Jahr. */
    days?: number;
    now?: () => Date;
    /** Kanal für die WebSocket-API; ohne Angabe der abgesicherte. */
    openSocket?: WebSocketOpener;
    /** Nur für Tests: fertiger Client statt Auflösung über die Registry. */
    clientOverride?: HomeAssistantStatisticsClient;
}

export interface StatisticsBackfillResult {
    variableId: string;
    /**
     * `filled` — es kam etwas dazu; `noop` — es gab nichts (mehr) zu
     * holen; `refused` — die Quelle kann diese Größe grundsätzlich nicht
     * liefern (und das ist eine Auskunft, kein Fehler); `failed` — der
     * Abruf ist gescheitert.
     */
    status: 'filled' | 'noop' | 'refused' | 'failed';
    appended: number;
    /** Neu geschriebene Tage (UTC). */
    days: string[];
    /** Tage, die schon Messpunkte hatten und deshalb unangetastet blieben. */
    skippedDays: number;
    /** Nachgefüllte Strecke (ISO), falls etwas dazukam. */
    from?: string;
    through?: string;
    /** Auflösung der nachgefüllten Punkte in Sekunden. */
    intervalSeconds: number;
    message: string;
}

function isoOf(ms: number): string {
    return new Date(ms).toISOString();
}

/** Mitternacht (UTC) des Tages, in dem der Zeitpunkt liegt. */
function startOfUtcDay(ms: number): number {
    return Math.floor(ms / 86_400_000) * 86_400_000;
}

/**
 * Prüft, ob diese Größe überhaupt aus der Statistik gefüllt werden kann.
 * Gibt es einen Grund dagegen, steht er im Klartext — geraten wird nichts
 * und ersatzweise ein anderes Feld genommen erst recht nicht.
 */
export function refusalFor(variable: VariableView): string | null {
    if (variable.sourceKind !== 'home-assistant') {
        return `Die Langzeit-Statistik gibt es nur in Home Assistant; diese Größe kommt aus `
            + `„${variable.sourceKind}".`;
    }
    if (variable.kind !== 'numeric') {
        return 'Die Langzeit-Statistik führt nur numerische Größen mit state_class. Schalter, '
            + 'Fenster, Bewegung und Anwesenheit sind nach der Aufbewahrungsfrist des Recorders '
            + 'ersatzlos fort — genau deshalb ist die laufende Erfassung der einzige Weg zur '
            + 'Ursachenseite.';
    }
    const field = statisticsFieldFor(variable.aggregation);
    return 'problem' in field ? field.problem : null;
}

/**
 * Füllt eine Größe aus der Statistik nach. Wirft nur, wenn die Größe gar
 * nicht existiert — alles andere steht im Ergebnis, wie beim
 * Erfassungslauf.
 */
export async function backfillFromStatistics(
    handle: GraphHandle,
    variableId: string,
    options: StatisticsBackfillOptions,
): Promise<StatisticsBackfillResult> {
    const variable = await getVariable(handle, variableId);
    if (!variable) throw new Error(`Beobachtungsgröße "${variableId}" gibt es nicht.`);

    const intervalSeconds = STATISTICS_PERIOD_SECONDS[PERIOD];
    const base = {
        variableId,
        appended: 0,
        days: [] as string[],
        skippedDays: 0,
        intervalSeconds,
    };

    const refusal = refusalFor(variable);
    if (refusal) return { ...base, status: 'refused', message: refusal };

    const field = statisticsFieldFor(variable.aggregation);
    if ('problem' in field) return { ...base, status: 'refused', message: field.problem };

    const now = (options.now ?? (() => new Date()))().getTime();
    const days = Math.min(Math.max(options.days ?? DEFAULT_STATISTICS_DAYS, 1), MAX_STATISTICS_DAYS);

    // Obergrenze: bis wohin die Erfassung selbst nicht mehr reicht.
    const capturedFrom = variable.status.capturedFrom ? Date.parse(variable.status.capturedFrom) : NaN;
    const captureReach = now - DEFAULT_BACKFILL_DAYS * 86_400_000;
    const through = startOfUtcDay(Math.min(
        Number.isFinite(capturedFrom) ? capturedFrom : captureReach,
        captureReach,
    ));
    const from = through - days * 86_400_000;
    if (through <= from) {
        return {
            ...base,
            status: 'noop',
            message: 'Vor dem erfassten Bestand liegt kein Tag, der sich nachfüllen ließe.',
        };
    }

    try {
        const client = options.clientOverride ?? await statisticsClientFor(handle, options);
        const answer = await client.statisticsDuringPeriod(
            [variable.source],
            isoOf(from),
            isoOf(through),
            PERIOD,
        );
        const entry = answer.get(variable.source);
        if (!entry || entry.rows.length === 0) {
            return {
                ...base,
                status: 'noop',
                message: `Home Assistant hält für „${variable.source}" im Fenster ab `
                    + `${isoOf(from).slice(0, 10)} keine Statistik.`,
            };
        }

        const { points, missingField } = statisticsPoints(entry.rows, field.field);
        if (points.length === 0) {
            return {
                ...base,
                status: 'failed',
                message: `Die Statistik von „${variable.source}" führt kein Feld „${field.field}" `
                    + `(${entry.rows.length} Zeilen geprüft). Passt die Verdichtung `
                    + `„${variable.aggregation}" zu dieser Größe?`,
            };
        }

        // Die Punkte gehen direkt in den Speicher: Ein Stundenaggregat ist
        // bereits verdichtet, ein zweiter Durchlauf durch die Verdichtung
        // würde es auf ein feineres Raster fortschreiben und damit
        // Messungen erfinden.
        const observations: Observation[] = points
            .filter(point => point.t >= from && point.t < through)
            .map(point => ({ t: point.t, v: point.value }));

        const store = new ObservationStore({
            files: options.files,
            root: options.root,
            userId: handle.iri.userId,
        });
        const written = await store.backfill(variableId, observations);
        if (written.written === 0) {
            return {
                ...base,
                status: 'noop',
                skippedDays: written.skippedDays.length,
                message: written.skippedDays.length > 0
                    ? `Alle ${written.skippedDays.length} Tage der Statistik sind bereits erfasst — `
                        + 'ein Rückgriff überschreibt nie einen vorhandenen Tag.'
                    : 'Im Fenster lag kein Statistik-Punkt, der noch fehlte.',
            };
        }

        const coverage = await store.coverage(variableId);
        const filledFrom = observations[0].t;
        const filledThrough = observations[observations.length - 1].t;
        const parts = [`${written.written} Stundenwerte aus der Langzeit-Statistik nachgefüllt`];
        if (written.skippedDays.length > 0) {
            parts.push(`${written.skippedDays.length} bereits erfasste Tage unberührt gelassen`);
        }
        if (missingField > 0) parts.push(`${missingField} Zeilen ohne Wert übersprungen`);
        if (entry.unusable > 0) parts.push(`${entry.unusable} unbrauchbare Zeilen`);
        const summary = `${parts.join(', ')}.`;
        const at = isoOf((options.now ?? (() => new Date()))().getTime());

        const previous = variable.status.aggregate;
        const next: VariableView = {
            ...variable,
            status: {
                ...variable.status,
                ...(coverage.from !== undefined ? { capturedFrom: isoOf(coverage.from) } : {}),
                count: coverage.count,
                aggregate: {
                    from: isoOf(Math.min(
                        filledFrom,
                        previous ? Date.parse(previous.from) : Number.POSITIVE_INFINITY,
                    )),
                    through: isoOf(Math.max(
                        filledThrough,
                        previous ? Date.parse(previous.through) : Number.NEGATIVE_INFINITY,
                    )),
                    intervalSeconds,
                    at,
                    summary,
                },
            },
        };
        await saveVariable(handle, next);

        return {
            ...base,
            status: 'filled',
            appended: written.written,
            days: written.days,
            skippedDays: written.skippedDays.length,
            from: isoOf(filledFrom),
            through: isoOf(filledThrough),
            message: summary,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...base, status: 'failed', message: `Rückgriff fehlgeschlagen: ${message}` };
    }
}

/** Baut den Statistik-Client aus der eingerichteten Verbindung. */
async function statisticsClientFor(
    handle: GraphHandle,
    options: StatisticsBackfillOptions,
): Promise<HomeAssistantStatisticsClient> {
    const config = await resolveHomeAssistantConfig(handle);
    const access = resolveHaAccess({ url: config.url, tokenEnv: config.tokenEnv });
    return new HomeAssistantStatisticsClient(access, options.openSocket ?? createGuardedWebSocketOpener());
}
