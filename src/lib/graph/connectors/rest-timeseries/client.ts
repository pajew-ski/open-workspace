/**
 * Der Netzanteil des `rest-timeseries`-Connectors: Anfragen, Drosselung
 * und Zwischenspeicher (CAUSAL_LAYER_SPEC §10).
 *
 * Drei Dinge, die eine offene Quelle von einer eigenen unterscheidet:
 *
 * 1. **Sie gehört jemand anderem.** Deshalb ein Mindestabstand zwischen
 *    zwei Anfragen je Host. Ein Erfassungslauf über zwanzig Größen darf
 *    keine zwanzig gleichzeitigen Abrufe auslösen — das wäre bei einem
 *    kostenlosen Dienst schlicht unhöflich und führt zu Sperren.
 * 2. **Sie liefert viele Größen in einer Antwort.** Bright Sky schickt
 *    Temperatur, Wind und Strahlung in demselben Dokument. Ohne
 *    Zwischenspeicher holte die Erfassung dieselbe Antwort für jede
 *    Größe erneut.
 * 3. **Sie ist nicht immer erreichbar.** Ein Fehler bleibt ein Fehler und
 *    wird gemeldet, nicht durch einen alten Wert überdeckt: Der
 *    Zwischenspeicher hat eine kurze Frist und wird bei einem Fehlschlag
 *    nicht befüllt.
 *
 * Der eigentliche `fetch` kommt immer von außen — im Connector aus dem
 * Kontext, in der Erfassung über denselben SSRF-Schutz (`http.ts`).
 * Dieses Modul öffnet nie selbst eine Verbindung.
 */

import type { RawPoint } from '../../observations/resample';
import {
    extractSeries,
    requestUrls,
    type RestSourceMapping,
} from './mapping';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface CacheEntry {
    body: string;
    at: number;
}

/**
 * Prozessweiter Zwischenspeicher, bewusst nicht pro Client-Instanz: Die
 * Erfassung baut je Größe einen neuen Client, und genau dort soll die
 * zweite Anfrage entfallen. Die Frist steht in der Abbildung der Quelle.
 */
const cache = new Map<string, CacheEntry>();
const lastRequestAt = new Map<string, number>();

/** Obergrenze des Zwischenspeichers — er ist eine Abkürzung, kein Archiv. */
const MAX_CACHE_ENTRIES = 64;

/** Für Tests und für den Fall, dass jemand eine Quelle neu einrichtet. */
export function resetRestTimeseriesCache(): void {
    cache.clear();
    lastRequestAt.clear();
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

async function delay(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>(resolve => { setTimeout(resolve, ms); });
}

export interface RestClientOptions {
    fetchImpl: FetchLike;
    signal?: AbortSignal;
    now?: () => number;
}

export interface WindowResult {
    /** Rohpunkte je Reihenschlüssel. */
    series: Map<string, RawPoint[]>;
    /** Datensätze ohne brauchbaren Zeitstempel oder Wert. */
    unusable: number;
    /** Antworten, die insgesamt nicht auswertbar waren (mit Begründung). */
    problems: string[];
    /** Wie viele Anfragen wirklich hinausgingen (ohne Zwischenspeicher). */
    requests: number;
}

export class RestTimeseriesClient {
    constructor(
        private readonly mapping: RestSourceMapping,
        private readonly options: RestClientOptions,
    ) {}

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    /** Eine Antwort, aus dem Zwischenspeicher oder frisch. */
    async load(url: string): Promise<{ body: string; cached: boolean }> {
        const cached = cache.get(url);
        if (cached && this.now() - cached.at < this.mapping.cacheTtlMs) {
            return { body: cached.body, cached: true };
        }

        const host = hostOf(url);
        const previous = lastRequestAt.get(host);
        if (previous !== undefined) {
            await delay(this.mapping.minRequestIntervalMs - (this.now() - previous));
        }
        lastRequestAt.set(host, this.now());

        const response = await this.options.fetchImpl(url, {
            headers: { accept: this.mapping.format === 'json' ? 'application/json' : 'text/csv, text/plain' },
            ...(this.options.signal ? { signal: this.options.signal } : {}),
        });
        if (!response.ok) {
            throw new Error(`Die Quelle antwortete mit ${response.status} ${response.statusText} (${url}).`);
        }
        const body = await response.text();
        if (cache.size >= MAX_CACHE_ENTRIES) {
            const oldest = cache.keys().next();
            if (!oldest.done) cache.delete(oldest.value);
        }
        cache.set(url, { body, at: this.now() });
        return { body, cached: false };
    }

    /**
     * Holt ein Zeitfenster und gibt die Rohpunkte aller Reihen zurück.
     * Fehlerhafte Einzelantworten beenden den Abruf nicht — was ankommt,
     * wird ausgewertet, der Rest steht als Begründung im Ergebnis. Das ist
     * dieselbe Fehlertoleranz, die auch der Connector-Runner hat: Die
     * Qualität der Quelle bricht keinen Lauf ab.
     */
    async window(fromMs: number, toMs: number): Promise<WindowResult> {
        const merged = new Map<string, RawPoint[]>();
        for (const entry of this.mapping.series) merged.set(entry.key, []);
        const problems: string[] = [];
        let unusable = 0;
        let requests = 0;

        for (const url of requestUrls(this.mapping, fromMs, toMs)) {
            if (this.options.signal?.aborted) break;
            let body: string;
            try {
                const loaded = await this.load(url);
                if (!loaded.cached) requests += 1;
                body = loaded.body;
            } catch (error) {
                problems.push(error instanceof Error ? error.message : String(error));
                continue;
            }
            const extracted = extractSeries(this.mapping, body, { from: fromMs, through: toMs });
            unusable += extracted.unusable;
            if (extracted.problem) problems.push(`${extracted.problem} (${url})`);
            for (const [key, points] of extracted.series) {
                const target = merged.get(key);
                if (target) target.push(...points);
            }
        }

        for (const points of merged.values()) points.sort((a, b) => a.t - b.t);
        return { series: merged, unusable, problems, requests };
    }
}
