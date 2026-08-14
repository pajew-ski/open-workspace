/**
 * Der Confounder-Katalog (CAUSAL_LAYER_SPEC §10, Meilenstein C5).
 *
 * **Warum ausgerechnet diese vier Quellen**: Der häufigste Grund, warum
 * eine kausale Frage nicht identifizierbar ist, ist eine fehlende
 * Störgröße — nicht ein fehlendes Verfahren. C4 macht diese Lücke
 * sichtbar („nicht identifizierbar, weil die Außentemperatur nicht
 * erfasst wird"), und in der Hausdomäne sind genau die wichtigsten
 * Störgrößen öffentlich, kostenlos und maschinenlesbar:
 *
 *  - **Wetter** ist DER Confounder. Ohne Außentemperatur ist jede
 *    Heizungsanalyse wertlos: Sie treibt gleichzeitig das Heizverhalten
 *    (Treatment) und die Innentemperatur (Outcome).
 *  - **Strompreis** ist beides — Treatment (Preissignal steuert
 *    Verbrauch) und Outcome (Kosten).
 *  - **Einstrahlung** konfundiert PV-Ertrag, Verschattung und
 *    Innentemperatur.
 *  - **Feiertage** sind der klassische Anwesenheits-Confounder: Sie
 *    ändern Verbrauch und Verhalten zugleich, und sie sind exogen — kein
 *    Zustand des Hauses beeinflusst sie zurück.
 *
 * Jede Vorlage ist nichts weiter als eine `RestSourceMapping` mit ein
 * paar Parametern davor. Es gibt keinen Sonderweg pro Quelle, und eine
 * eigene Quelle braucht keinen neuen Code — sie ist eine eigene
 * Abbildung (`custom`).
 *
 * **Zum „Sonnenstand" aus §10**: Azimut und Elevation sind eine Rechnung
 * aus Ort und Zeit, kein Abruf — für diesen Katalog gibt es sie deshalb
 * nicht. Er liefert die **Einstrahlung**, also die Größe, über die der
 * Sonnenstand kausal wirkt, und zwar ihren atmosphärischen Teil
 * (Bewölkung, Trübung). Der geometrische Teil kommt vom Connector
 * `solar-position`, der rechnet statt abzurufen — entschieden am
 * 2026-08-14: eine berechnete Größe IST eine Beobachtung
 * (docs/spec-widersprueche.md, Eintrag 4). Beide zusammen ergeben das
 * vollständige Bild.
 */

import type { RestSourceMapping } from './mapping';

export interface RestPresetParam {
    key: string;
    /** Beschriftung in der UI (deutsch). */
    label: string;
    placeholder?: string;
    required: boolean;
    default?: string;
    /** Feste Auswahl statt freier Eingabe. */
    options?: Array<{ value: string; label: string }>;
}

export interface RestPreset {
    id: string;
    label: string;
    description: string;
    /** Wozu die Quelle im Kausalmodell taugt — ein Satz. */
    causalRole: string;
    params: readonly RestPresetParam[];
    build(params: Readonly<Record<string, string>>): RestSourceMapping;
}

const MINUTE = 60_000;

function coordinate(value: string | undefined): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

const brightSky: RestPreset = {
    id: 'brightsky-weather',
    label: 'Wetter (DWD über Bright Sky)',
    description:
        'Stündliche Messwerte des Deutschen Wetterdienstes für einen Ort: Temperatur, Wind, '
        + 'Niederschlag, Bewölkung, Luftfeuchte, Globalstrahlung und Sonnenscheindauer.',
    causalRole:
        'Die Außentemperatur ist der Confounder der Hausdomäne — sie treibt das Heizverhalten '
        + 'und die Innentemperatur zugleich.',
    params: [
        { key: 'latitude', label: 'Breitengrad', placeholder: '52.52', required: true },
        { key: 'longitude', label: 'Längengrad', placeholder: '13.40', required: true },
        { key: 'placeName', label: 'Name des Ortes', placeholder: 'Zuhause', required: false, default: 'Wetterstation' },
    ],
    build: params => ({
        label: 'Wetter (DWD über Bright Sky)',
        url: 'https://api.brightsky.dev/weather',
        format: 'json',
        shape: 'points',
        query: { lat: params.latitude ?? '', lon: params.longitude ?? '', tz: 'UTC' },
        windowMode: 'range',
        fromParam: 'date',
        toParam: 'last_date',
        windowFormat: 'date',
        windowDays: 10,
        path: 'weather',
        timeField: 'timestamp',
        timeFormat: 'iso',
        series: [
            {
                key: 'temperature', name: 'Außentemperatur', kind: 'numeric', aggregation: 'mean',
                field: 'temperature', unit: '°C', observable: 'temperature',
                role: 'Störgröße für Heizung, Lüftung und Verbrauch',
            },
            {
                key: 'wind-speed', name: 'Windgeschwindigkeit', kind: 'numeric', aggregation: 'mean',
                field: 'wind_speed', unit: 'km/h', observable: 'wind-speed',
            },
            {
                key: 'precipitation', name: 'Niederschlag', kind: 'numeric', aggregation: 'sum',
                field: 'precipitation', unit: 'mm', observable: 'precipitation',
            },
            {
                key: 'relative-humidity', name: 'Luftfeuchte (außen)', kind: 'numeric', aggregation: 'mean',
                field: 'relative_humidity', unit: '%', observable: 'humidity',
            },
            {
                key: 'cloud-cover', name: 'Bewölkung', kind: 'numeric', aggregation: 'mean',
                field: 'cloud_cover', unit: '%', observable: 'cloud-cover',
            },
            {
                key: 'solar', name: 'Globalstrahlung', kind: 'numeric', aggregation: 'sum',
                field: 'solar', unit: 'kWh/m²', observable: 'irradiance',
                role: 'Störgröße für PV-Ertrag, Verschattung und Innentemperatur',
            },
            {
                key: 'sunshine', name: 'Sonnenscheindauer', kind: 'numeric', aggregation: 'sum',
                field: 'sunshine', unit: 'min', observable: 'sunshine',
            },
            {
                key: 'pressure', name: 'Luftdruck', kind: 'numeric', aggregation: 'mean',
                field: 'pressure_msl', unit: 'hPa', observable: 'pressure',
            },
        ],
        place: {
            name: params.placeName?.trim() || 'Wetterstation',
            ...(coordinate(params.latitude) !== undefined ? { latitude: coordinate(params.latitude) as number } : {}),
            ...(coordinate(params.longitude) !== undefined ? { longitude: coordinate(params.longitude) as number } : {}),
        },
        attribution: 'Deutscher Wetterdienst (DWD) über Bright Sky (brightsky.dev), CC BY 4.0.',
        minRequestIntervalMs: 1_000,
        cacheTtlMs: 5 * MINUTE,
    }),
};

const awattar: RestPreset = {
    id: 'awattar-price',
    label: 'Strompreis (EPEX Spot Day-Ahead über aWATTar)',
    description:
        'Stündlicher Börsenstrompreis des Day-Ahead-Marktes, umgerechnet von €/MWh in ct/kWh.',
    causalRole:
        'Preissignal als Behandlung (steuert Verbrauch) und als Wirkung (Kosten) — je nach Frage beides.',
    params: [
        {
            key: 'market', label: 'Marktgebiet', required: true, default: 'de',
            options: [{ value: 'de', label: 'Deutschland' }, { value: 'at', label: 'Österreich' }],
        },
    ],
    build: params => ({
        label: `Strompreis (${(params.market ?? 'de').toUpperCase()})`,
        url: `https://api.awattar.${params.market === 'at' ? 'at' : 'de'}/v1/marketdata`,
        format: 'json',
        shape: 'points',
        query: {},
        windowMode: 'range',
        fromParam: 'start',
        toParam: 'end',
        windowFormat: 'unix-ms',
        windowDays: 30,
        path: 'data',
        timeField: 'start_timestamp',
        timeFormat: 'unix-ms',
        series: [
            {
                key: 'market-price', name: 'Börsenstrompreis', kind: 'numeric', aggregation: 'mean',
                field: 'marketprice', unit: 'ct/kWh', observable: 'electricity-price',
                // Die Quelle liefert €/MWh; 1 €/MWh sind 0,1 ct/kWh. Die
                // Umrechnung steht hier und nicht im Kopf des Lesers.
                scale: 0.1,
                role: 'Preissignal: Treatment oder Outcome, je nach Frage',
            },
        ],
        attribution: 'aWATTar GmbH, Day-Ahead-Preise der EPEX Spot.',
        minRequestIntervalMs: 1_000,
        cacheTtlMs: 15 * MINUTE,
    }),
};

const openMeteo: RestPreset = {
    id: 'open-meteo-radiation',
    label: 'Einstrahlung und Temperatur (Open-Meteo Archiv)',
    description:
        'Stündliche Reanalyse-Werte für jeden Ort in Europa: Globalstrahlung, Direktstrahlung und '
        + 'Lufttemperatur. Die Alternative zu Bright Sky außerhalb Deutschlands.',
    causalRole:
        'Einstrahlung ist die Größe, über die der Sonnenstand kausal wirkt — Störgröße für '
        + 'PV-Ertrag, Verschattung und Innentemperatur.',
    params: [
        { key: 'latitude', label: 'Breitengrad', placeholder: '52.52', required: true },
        { key: 'longitude', label: 'Längengrad', placeholder: '13.40', required: true },
        { key: 'placeName', label: 'Name des Ortes', placeholder: 'Zuhause', required: false, default: 'Standort' },
    ],
    build: params => ({
        label: 'Einstrahlung (Open-Meteo)',
        url: 'https://archive-api.open-meteo.com/v1/archive',
        format: 'json',
        shape: 'columns',
        query: {
            latitude: params.latitude ?? '',
            longitude: params.longitude ?? '',
            hourly: 'shortwave_radiation,direct_radiation,temperature_2m',
            timezone: 'UTC',
            // Unix-Zeit statt lokaler Schreibweise: „2026-08-01T00:00"
            // ohne Zeitzone läse jede Laufzeitumgebung als Ortszeit, und
            // dieselbe Reihe hätte auf zwei Rechnern andere Zeitstempel.
            timeformat: 'unixtime',
        },
        windowMode: 'range',
        fromParam: 'start_date',
        toParam: 'end_date',
        windowFormat: 'date',
        windowDays: 60,
        path: 'hourly',
        timeField: 'time',
        timeFormat: 'unix-s',
        series: [
            {
                key: 'shortwave-radiation', name: 'Globalstrahlung', kind: 'numeric', aggregation: 'mean',
                field: 'shortwave_radiation', unit: 'W/m²', observable: 'irradiance',
                role: 'Störgröße für PV-Ertrag und Innentemperatur',
            },
            {
                key: 'direct-radiation', name: 'Direktstrahlung', kind: 'numeric', aggregation: 'mean',
                field: 'direct_radiation', unit: 'W/m²', observable: 'irradiance',
            },
            {
                key: 'air-temperature', name: 'Außentemperatur', kind: 'numeric', aggregation: 'mean',
                field: 'temperature_2m', unit: '°C', observable: 'temperature',
            },
        ],
        place: {
            name: params.placeName?.trim() || 'Standort',
            ...(coordinate(params.latitude) !== undefined ? { latitude: coordinate(params.latitude) as number } : {}),
            ...(coordinate(params.longitude) !== undefined ? { longitude: coordinate(params.longitude) as number } : {}),
        },
        attribution: 'Open-Meteo (open-meteo.com), CC BY 4.0; Reanalyse-Daten von ECMWF und DWD.',
        minRequestIntervalMs: 1_000,
        cacheTtlMs: 30 * MINUTE,
    }),
};

const holidays: RestPreset = {
    id: 'nager-holidays',
    label: 'Feiertage (Nager.Date)',
    description:
        'Gesetzliche Feiertage eines Landes als zweiwertige Reihe: 1 an Feiertagen, 0 sonst. '
        + 'Mit Bundesland gelten zusätzlich die regionalen Feiertage.',
    causalRole:
        'Anwesenheitsmuster: der klassische Confounder für Verbrauch — und exogen, weil kein '
        + 'Zustand des Hauses auf den Kalender zurückwirkt.',
    params: [
        { key: 'country', label: 'Land (ISO-3166-1 alpha-2)', placeholder: 'DE', required: true, default: 'DE' },
        {
            key: 'subdivision', label: 'Bundesland (ISO-3166-2, leer = nur bundesweite)',
            placeholder: 'DE-BY', required: false,
        },
    ],
    build: params => {
        const country = (params.country ?? 'DE').trim().toUpperCase() || 'DE';
        const subdivision = (params.subdivision ?? '').trim().toUpperCase();
        return {
            label: `Feiertage ${country}${subdivision ? ` (${subdivision})` : ''}`,
            url: `https://date.nager.at/api/v3/PublicHolidays/{year}/${encodeURIComponent(country)}`,
            format: 'json',
            shape: 'intervals',
            query: {},
            windowMode: 'yearly',
            windowFormat: 'date',
            windowDays: 366,
            timeField: 'date',
            durationDays: 1,
            timeFormat: 'date',
            series: [
                {
                    key: 'public-holiday',
                    name: `Feiertag ${country}${subdivision ? ` (${subdivision})` : ''}`,
                    kind: 'binary',
                    // Ein Tag ist ein Feiertag, sobald er einer ist — der
                    // Maximalwert des Intervalls ist die richtige
                    // Verdichtung, ein Mittelwert wäre ein halber Feiertag.
                    aggregation: 'max',
                    field: '',
                    constantValue: 1,
                    defaultValue: 0,
                    observable: 'public-holiday',
                    role: 'Anwesenheits-Confounder',
                    // Ohne Bundesland zählen nur bundesweite Feiertage:
                    // Die Quelle führt regionale mit ihrer Region am
                    // Eintrag, bundesweite ohne Angabe.
                    filter: {
                        field: 'counties',
                        ...(subdivision ? { includes: subdivision } : {}),
                        whenAbsent: 'include' as const,
                    },
                },
            ],
            attribution: 'Nager.Date (date.nager.at), Public Domain.',
            minRequestIntervalMs: 1_000,
            cacheTtlMs: 24 * 60 * MINUTE,
        };
    },
};

export const REST_PRESETS: readonly RestPreset[] = [brightSky, awattar, openMeteo, holidays];

export function getRestPreset(id: string): RestPreset | null {
    return REST_PRESETS.find(preset => preset.id === id) ?? null;
}
