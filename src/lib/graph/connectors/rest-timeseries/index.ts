/**
 * `rest-timeseries` — der Open-Data-Connector (CAUSAL_LAYER_SPEC §10/§11,
 * Meilenstein C5).
 *
 * **Wozu er da ist**: C4 macht sichtbar, dass die häufigste Ursache für
 * „nicht identifizierbar" keine fehlende Methode ist, sondern eine
 * fehlende Störgröße. In der Hausdomäne sind genau diese Störgrößen
 * öffentlich — Wetter, Strompreis, Einstrahlung, Feiertage. Dieser
 * Connector holt sie, und zwar über den EINEN Vertrag (Invariante 5):
 * kein zweiter Import-Pfad, kein Sonderweg, dieselbe Quarantäne, dieselbe
 * Revisionslogik, dieselbe PROV-Buchführung.
 *
 * **Was er materialisiert, ist die Struktur, nicht die Reihe.** Genau wie
 * beim `home-assistant`-Connector (C3) haben Struktur und Werte
 * verschiedene Takte: Welche Größen eine Quelle anbietet, ändert sich
 * fast nie; die Werte kommen laufend nach. Und Werte gehören nie in den
 * Store (Invariante C3). Die Reihen holt deshalb die Erfassung
 * (`observations/capture.ts`), die diesen Connector als Zugangs- und
 * Strukturquelle nutzt.
 *
 * **Vorlage oder eigene Abbildung**: Die vier Vorlagen in `presets.ts`
 * sind der Katalog aus §10. `custom` nimmt dieselbe Abbildung direkt als
 * JSON entgegen — eine eigene Quelle braucht damit keinen neuen Code.
 */

import type { Quad } from '@rdfjs/types';
import { z } from 'zod';
import type { Connector, ConnectorContext, SourceRef } from '../types';
import { sha256Hex } from '../quads';
import { RestTimeseriesClient } from './client';
import {
    availableSeriesKeys,
    requestUrls,
    structuralFingerprint,
    type RestSourceMapping,
} from './mapping';
import { getRestPreset, REST_PRESETS } from './presets';
import { sourceQuads } from './structure';

const seriesSchema = z.object({
    key: z.string().trim().min(1),
    name: z.string().trim().min(1),
    kind: z.enum(['numeric', 'binary', 'categorical']),
    aggregation: z.enum(['last', 'mean', 'min', 'max', 'sum']),
    field: z.string().default(''),
    unit: z.string().optional(),
    observable: z.string().optional(),
    scale: z.number().optional(),
    offset: z.number().optional(),
    constantValue: z.number().optional(),
    defaultValue: z.number().optional(),
    filter: z.object({
        field: z.string().min(1),
        includes: z.string().optional(),
        whenAbsent: z.enum(['include', 'exclude']),
    }).optional(),
    role: z.string().optional(),
});

const mappingSchema = z.object({
    label: z.string().trim().min(1),
    url: z.string().trim().url(),
    format: z.enum(['json', 'csv']).default('json'),
    shape: z.enum(['points', 'columns', 'intervals']).default('points'),
    query: z.record(z.string(), z.string()).default({}),
    windowMode: z.enum(['range', 'yearly']).default('range'),
    fromParam: z.string().optional(),
    toParam: z.string().optional(),
    windowFormat: z.enum(['iso', 'date', 'unix-s', 'unix-ms']).default('iso'),
    windowDays: z.number().int().min(1).max(3660).default(7),
    path: z.string().optional(),
    timeField: z.string().min(1),
    endField: z.string().optional(),
    durationDays: z.number().int().min(1).optional(),
    timeFormat: z.enum(['iso', 'date', 'unix-s', 'unix-ms']).default('iso'),
    delimiter: z.string().optional(),
    series: z.array(seriesSchema).min(1).max(64),
    place: z.object({
        name: z.string().min(1),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
    }).optional(),
    attribution: z.string().default(''),
    minRequestIntervalMs: z.number().int().min(0).max(60_000).default(1_000),
    cacheTtlMs: z.number().int().min(0).max(86_400_000).default(300_000),
});

const configSchema = z.object({
    /** ID einer Vorlage aus `presets.ts` oder `custom`. */
    preset: z.string().trim().min(1).default(REST_PRESETS[0].id),
    /** Parameter der Vorlage (Ort, Marktgebiet, Land …). */
    params: z.record(z.string(), z.string()).default({}),
    /** `preset: 'custom'`: die vollständige Abbildung als JSON. */
    mapping: z.string().trim().default(''),
});

export type RestTimeseriesConfig = z.infer<typeof configSchema>;

export const REST_CUSTOM_PRESET = 'custom';

/**
 * Die Abbildung zu einer Konfiguration. Wirft mit einer deutschen
 * Begründung, statt eine halbe Quelle zurückzugeben — eine Konfiguration,
 * aus der keine Abbildung wird, darf gar nicht erst als Connector
 * entstehen.
 */
export function mappingForConfig(config: RestTimeseriesConfig): RestSourceMapping {
    if (config.preset === REST_CUSTOM_PRESET) {
        if (config.mapping === '') {
            throw new Error('Für eine eigene Quelle fehlt die Abbildung (JSON).');
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(config.mapping);
        } catch (error) {
            throw new Error(
                `Die Abbildung ist kein gültiges JSON: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        const result = mappingSchema.safeParse(parsed);
        if (!result.success) {
            const issues = result.error.issues
                .map(issue => `${issue.path.join('.') || 'mapping'}: ${issue.message}`)
                .join('; ');
            throw new Error(`Die Abbildung ist unvollständig — ${issues}`);
        }
        return result.data;
    }

    const preset = getRestPreset(config.preset);
    if (!preset) {
        throw new Error(
            `Unbekannte Vorlage "${config.preset}". Verfügbar: `
            + `${REST_PRESETS.map(entry => entry.id).join(', ')} oder "${REST_CUSTOM_PRESET}".`,
        );
    }
    const missing = preset.params
        .filter(param => param.required && (config.params[param.key] ?? param.default ?? '').trim() === '')
        .map(param => param.label);
    if (missing.length > 0) {
        throw new Error(`Der Vorlage „${preset.label}" fehlen Angaben: ${missing.join(', ')}.`);
    }
    const params: Record<string, string> = {};
    for (const param of preset.params) {
        params[param.key] = config.params[param.key] ?? param.default ?? '';
    }
    return preset.build(params);
}

/** Sortierte Parameter — damit derselbe Zustand denselben Locator ergibt. */
function encodeParams(params: Record<string, string>): string {
    const sorted: Record<string, string> = {};
    for (const key of Object.keys(params).sort()) sorted[key] = params[key];
    return JSON.stringify(sorted);
}

/**
 * Das Probe-Fenster: kurz und am aktuellen Rand. Es dient der
 * Erreichbarkeit und der Frage, welche Größen die Quelle anbietet — nicht
 * dem Sammeln von Werten. Die holt die Erfassung.
 *
 * Das Fenster wird auf die volle Stunde abgerundet. Ohne das erzeugten
 * `probe` und `pull` desselben Laufs zwei URLs, die sich um Millisekunden
 * unterscheiden — und die Quelle bekäme zwei identische Anfragen, weil der
 * Zwischenspeicher nach URL greift.
 */
function probeWindow(mapping: RestSourceMapping, now: number): { from: number; through: number } {
    const days = mapping.windowMode === 'yearly' ? 1 : Math.min(mapping.windowDays, 2);
    const through = Math.floor(now / 3_600_000) * 3_600_000;
    return { from: through - days * 86_400_000, through };
}

export const restTimeseriesConnector: Connector<RestTimeseriesConfig> = {
    kind: 'rest-timeseries',
    mode: 'materialize',
    capabilities: { read: true, write: false, watch: false, lossyExport: false },
    label: 'Offene Zeitreihen (REST)',
    description:
        'Störgrößen aus offenen Quellen: Wetter (DWD/Bright Sky), Strompreis (EPEX Spot), '
        + 'Einstrahlung (Open-Meteo) und Feiertage — oder eine eigene JSON-/CSV-API. Importiert '
        + 'wird die Struktur; die Messwerte holt die Erfassung unter Graph → Beobachtungen.',

    configSchema: () => z.toJSONSchema(configSchema) as Record<string, unknown>,
    parseConfig: input => {
        const config = configSchema.parse(input);
        // Früh scheitern: Eine Konfiguration ohne gültige Abbildung wäre
        // ein Connector, der beim ersten Lauf stirbt.
        mappingForConfig(config);
        return config;
    },

    // Locator: `<preset>|<parameter-json>` bzw. `custom|<abbildung-json>`.
    // Lesbar genug für die UI und verlustfrei in beide Richtungen.
    locatorFor: config => `${config.preset}|${
        config.preset === REST_CUSTOM_PRESET ? config.mapping : encodeParams(config.params)
    }`,
    configFromLocator: locator => {
        const separator = locator.indexOf('|');
        const preset = separator < 0 ? locator : locator.slice(0, separator);
        const rest = separator < 0 ? '' : locator.slice(separator + 1);
        if (preset === REST_CUSTOM_PRESET) {
            return configSchema.parse({ preset, mapping: rest });
        }
        let params: Record<string, string> = {};
        if (rest !== '') {
            const parsed: unknown = JSON.parse(rest);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                params = Object.fromEntries(
                    Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
                );
            }
        }
        return configSchema.parse({ preset, params });
    },

    async probe(config, ctx): Promise<SourceRef> {
        const mapping = mappingForConfig(config);
        const client = new RestTimeseriesClient(mapping, {
            fetchImpl: ctx.fetch,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const window = probeWindow(mapping, Date.now());
        const urls = requestUrls(mapping, window.from, window.through);
        if (urls.length === 0) {
            throw new Error('Aus dieser Abbildung entsteht keine Anfrage — Zeitfenster oder URL prüfen.');
        }
        const { body } = await client.load(urls[0]);
        const available = availableSeriesKeys(mapping, body);
        if (available.length === 0) {
            throw new Error(
                `Die Quelle antwortet, liefert aber keine der beschriebenen Größen `
                + `(${mapping.series.map(entry => entry.field || entry.key).join(', ')}). Abbildung prüfen.`,
            );
        }
        return {
            id: '',
            kind: this.kind,
            locator: this.locatorFor(config),
            revision: `sha256:${await sha256Hex(structuralFingerprint(mapping, available))}`,
            fetchedAt: new Date().toISOString(),
        };
    },

    async *pull(ref: SourceRef, ctx: ConnectorContext): AsyncIterable<Quad> {
        const config = this.configFromLocator(ref.locator);
        const mapping = mappingForConfig(config);
        ctx.report({ done: 0, total: 1, note: `Frage ${mapping.label} nach ihrem Angebot…` });

        const client = new RestTimeseriesClient(mapping, {
            fetchImpl: ctx.fetch,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const window = probeWindow(mapping, Date.now());
        const urls = requestUrls(mapping, window.from, window.through);
        const { body } = await client.load(urls[0]);
        const available = availableSeriesKeys(mapping, body);

        // Eine beschriebene, aber nicht gelieferte Größe ist kein Grund
        // zum Abbruch (M3-Fehlertoleranz) — sie wird gemeldet und nicht
        // behauptet.
        for (const entry of mapping.series) {
            if (available.includes(entry.key)) continue;
            ctx.quarantine({
                source: `${mapping.url}#${entry.key}`,
                reason: `Die Quelle liefert das Feld "${entry.field || entry.key}" nicht — Größe ausgelassen.`,
            });
        }

        const { quads, counts } = sourceQuads(ctx.iri, ref.id, mapping, available);
        ctx.report({
            done: 1,
            total: 1,
            note: `${counts.series} Reihen, ${counts.observables} Messgrößen. `
                + 'Messwerte holt die Erfassung unter Graph → Beobachtungen.',
        });
        yield* quads;
    },
};
