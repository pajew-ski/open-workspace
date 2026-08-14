/**
 * Woher die Rohwerte einer Größe kommen (CAUSAL_LAYER_SPEC §6/§10).
 *
 * Bis C4 gab es genau eine Quelle, und der Erfassungslauf sprach direkt
 * mit ihr. Mit C5 kommen offene Zeitreihen dazu — und damit die Frage,
 * ob es einen zweiten Erfassungslauf gibt. **Nein.** Der Lauf bleibt
 * einer; was sich unterscheidet, ist nur das Holen der Rohpunkte. Genau
 * dieses Stück steckt hinter der Schnittstelle hier.
 *
 * Zwei Regeln, die daraus folgen:
 *
 *  1. **Die Quellart steht an der Größe** (`schema:category` am
 *     `ow:Variable`-Knoten), nicht in einer Fallunterscheidung im Lauf.
 *     Eine neue Quellart ist damit ein Eintrag in dieser Datei und sonst
 *     nichts.
 *  2. **Eine unerreichbare Quellart legt nur ihre eigenen Größen still.**
 *     Vor C5 machte ein fehlender Home-Assistant-Connector den ganzen
 *     Lauf zunichte; seither scheitert daran genau das, was ihn braucht,
 *     und die Wetterreihen laufen weiter. Das ist dieselbe
 *     Fehlerisolation, die die Abnahme von C3 je Größe schon verlangt.
 */

import { createGuardedFetch } from '../connectors/http';
import { clientFor, type HomeAssistantConfig } from '../connectors/home-assistant';
import type { HomeAssistantClient } from '../connectors/home-assistant/api';
import { parseState } from '../connectors/home-assistant/structure';
import { mappingForConfig, type RestTimeseriesConfig } from '../connectors/rest-timeseries';
import { RestTimeseriesClient } from '../connectors/rest-timeseries/client';
import type { RestSourceMapping } from '../connectors/rest-timeseries/mapping';
import { parseRestSourceKey } from '../connectors/rest-timeseries/structure';
import { getConnector, listConnectors } from '../connectors/registry';
import { getConnectorKind } from '../connectors/catalog';
import type { RawPoint } from './resample';
import type { GraphHandle } from './variables';
import type { VariableView } from './types';

/** Zeitscheibe eines Home-Assistant-Abrufs. */
const HA_SLICE_HOURS = 24;

/** Höchstzahl Rohpunkte je Größe und Lauf — Schutz vor Ausreißer-Sensoren. */
export const MAX_RAW_POINTS = 200_000;

export interface RawSeriesResult {
    points: RawPoint[];
    /** true, wenn bei MAX_RAW_POINTS abgeschnitten wurde. */
    truncated: boolean;
    /** Zusatz für die Zusammenfassung (deutsch), z. B. unbrauchbare Zeilen. */
    note?: string;
}

/** Eine Art von Messquelle. Holt Rohpunkte, sonst nichts. */
export interface ObservationSource {
    readonly kind: string;
    fetchRaw(variable: VariableView, fromMs: number, toMs: number): Promise<RawSeriesResult>;
}

export interface SourceOptions {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    /** Nur für Tests: fertiger HA-Client statt Auflösung über die Registry. */
    homeAssistantClient?: HomeAssistantClient;
}

function isoOf(ms: number): string {
    return new Date(ms).toISOString();
}

// --- Home Assistant ------------------------------------------------------

/**
 * Sucht den `home-assistant`-Connector der Installation. Ohne ihn gibt es
 * keinen Zugang — und das ist ein ehrlicher Fehler, keine leere Erfassung.
 */
async function resolveHomeAssistantClient(
    handle: GraphHandle,
    options: SourceOptions,
): Promise<HomeAssistantClient> {
    if (options.homeAssistantClient) return options.homeAssistantClient;
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
async function homeAssistantRaw(
    client: HomeAssistantClient,
    variable: VariableView,
    fromMs: number,
    toMs: number,
): Promise<RawSeriesResult> {
    const points: RawPoint[] = [];
    const sliceMs = HA_SLICE_HOURS * 3600_000;
    let truncated = false;
    for (let start = fromMs; start < toMs; start += sliceMs) {
        const end = Math.min(start + sliceMs, toMs);
        const history = await client.history([variable.source], isoOf(start), isoOf(end));
        for (const point of history) {
            if (point.entityId !== variable.source) continue;
            const parsed = parseState(point.state, variable.kind);
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

// --- Offene Zeitreihen ---------------------------------------------------

/**
 * Die Abbildung einer `rest-timeseries`-Instanz, einmal je Lauf
 * aufgelöst. Der Zwischenspeicher ist hier kein Luxus: Acht Wetter-Größen
 * aus derselben Quelle sollen die Registry nicht achtmal befragen.
 */
class RestTimeseriesSource implements ObservationSource {
    readonly kind = 'rest-timeseries';
    private readonly mappings = new Map<string, RestSourceMapping>();

    constructor(
        private readonly handle: GraphHandle,
        private readonly options: SourceOptions,
    ) {}

    private async mappingFor(connectorId: string): Promise<RestSourceMapping> {
        const cached = this.mappings.get(connectorId);
        if (cached) return cached;
        const view = await getConnector(this.handle, connectorId);
        if (!view) {
            throw new Error(
                `Die Quelle „${connectorId}" gibt es nicht (mehr). Ohne sie ist nicht bekannt, `
                + 'wo diese Reihe abzurufen wäre.',
            );
        }
        const impl = getConnectorKind('rest-timeseries');
        if (!impl) throw new Error('Die Connector-Art "rest-timeseries" ist nicht verfügbar.');
        const mapping = mappingForConfig(impl.configFromLocator(view.locator) as RestTimeseriesConfig);
        this.mappings.set(connectorId, mapping);
        return mapping;
    }

    async fetchRaw(variable: VariableView, fromMs: number, toMs: number): Promise<RawSeriesResult> {
        const parsed = parseRestSourceKey(variable.source);
        if (!parsed) {
            throw new Error(
                `Der Quellschlüssel „${variable.source}" nennt keine Quelle und keine Reihe `
                + '(erwartet: <quelle>#<reihe>).',
            );
        }
        const mapping = await this.mappingFor(parsed.connectorId);
        const client = new RestTimeseriesClient(mapping, {
            fetchImpl: createGuardedFetch({
                fetchImpl: this.options.fetchImpl,
                ...(this.options.signal ? { signal: this.options.signal } : {}),
            }),
            ...(this.options.signal ? { signal: this.options.signal } : {}),
        });
        const result = await client.window(fromMs, toMs);
        const points = result.series.get(parsed.seriesKey);
        if (!points) {
            throw new Error(`Die Quelle „${mapping.label}" kennt keine Reihe „${parsed.seriesKey}".`);
        }
        // Ein Fehlschlag ohne einen einzigen Punkt ist ein Fehler und wird
        // gemeldet. Ein Fehlschlag mit Punkten ist eine Teilantwort — was
        // ankam, wird erfasst, der Rest steht im Bericht.
        if (points.length === 0 && result.problems.length > 0) {
            throw new Error(result.problems[0]);
        }
        const truncated = points.length > MAX_RAW_POINTS;
        const notes: string[] = [];
        if (result.unusable > 0) notes.push(`${result.unusable} Zeilen unbrauchbar`);
        if (result.problems.length > 0) notes.push(`${result.problems.length} Abrufe fehlgeschlagen`);
        return {
            points: truncated ? points.slice(0, MAX_RAW_POINTS) : points,
            truncated,
            ...(notes.length > 0 ? { note: notes.join(', ') } : {}),
        };
    }
}

// --- Auflösung -----------------------------------------------------------

/**
 * Hält die Quellen eines Laufs. Eine Quellart wird höchstens einmal
 * aufgelöst; scheitert sie, gilt derselbe Fehler für jede Größe dieser
 * Art — und für keine andere.
 */
export class SourceRegistry {
    private readonly resolved = new Map<string, ObservationSource | Error>();

    constructor(
        private readonly handle: GraphHandle,
        private readonly options: SourceOptions = {},
    ) {}

    async get(kind: string): Promise<ObservationSource> {
        const existing = this.resolved.get(kind);
        if (existing instanceof Error) throw existing;
        if (existing) return existing;
        try {
            const source = await this.create(kind);
            this.resolved.set(kind, source);
            return source;
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            this.resolved.set(kind, failure);
            throw failure;
        }
    }

    private async create(kind: string): Promise<ObservationSource> {
        if (kind === 'home-assistant') {
            const client = await resolveHomeAssistantClient(this.handle, this.options);
            return {
                kind,
                fetchRaw: (variable, fromMs, toMs) => homeAssistantRaw(client, variable, fromMs, toMs),
            };
        }
        if (kind === 'rest-timeseries') {
            return new RestTimeseriesSource(this.handle, this.options);
        }
        throw new Error(
            `Für die Quellart „${kind}" gibt es keine Erfassung. `
            + 'Bekannt sind "home-assistant" und "rest-timeseries".',
        );
    }
}
