/**
 * Verdichtung roher Zustandswechsel auf ein festes Zeitraster.
 *
 * Home Assistant liefert **ereignisbasiert**: ein Eintrag je Änderung,
 * unregelmäßig, mal im Sekundentakt, mal stundenlang gar nichts. Für eine
 * kausale Auswertung braucht es das Gegenteil — ein reguläres Panel, in
 * dem mehrere Größen dieselben Zeitpunkte tragen. Diese Datei macht aus
 * dem einen das andere, und zwar deterministisch: gleiche Eingabe,
 * gleiches Raster, gleiches Ergebnis (Invariante C7).
 *
 * Zwei Entscheidungen, die inhaltlich zählen:
 *
 * 1. **Zustände halten an.** Ein Schalter, der um 8:00 eingeschaltet
 *    wird, ist um 9:00 immer noch an, auch ohne neuen Eintrag. Deshalb
 *    wird der letzte bekannte Wert über leere Intervalle fortgeschrieben
 *    (Last-Observation-Carried-Forward). Ohne das entstünde in jedem
 *    ruhigen Intervall eine Lücke, und ausgerechnet die ruhigen
 *    Intervalle sind die häufigsten.
 *
 * 2. **Eine Lücke bleibt eine Lücke.** Meldet die Quelle
 *    `unavailable`/`unknown`, wird NICHT der letzte Wert fortgeschrieben
 *    — der Sensor sagt gerade nichts, und das ist eine andere Aussage als
 *    „unverändert". Fehlende Werte sind selten zufällig fehlend; wer sie
 *    glättet, verzerrt jede spätere Schätzung unsichtbar.
 */

import type { Observation, Aggregation, ObservationKind } from './types';

export interface RawPoint {
    t: number;
    value: number | string | null;
    gap?: string;
}

export interface ResampleOptions {
    intervalSeconds: number;
    aggregation: Aggregation;
    kind: ObservationKind;
    /** Rasteranfang, exklusiv — nur Intervalle danach werden erzeugt. */
    after?: number;
    /** Rasterende, inklusiv. */
    through: number;
    /**
     * Letzter bekannter Wert vor `after` (aus dem vorherigen Lauf), damit
     * das erste Intervall nicht künstlich leer beginnt.
     */
    carry?: number | string | null;
}

/** Rasterpunkt, auf den ein Zeitstempel fällt (Vielfaches der Schrittweite). */
export function bucketOf(timestampMs: number, intervalSeconds: number): number {
    const step = intervalSeconds * 1000;
    return Math.floor(timestampMs / step) * step;
}

function aggregate(values: number[], aggregation: Aggregation): number {
    switch (aggregation) {
        case 'mean':
            return values.reduce((sum, value) => sum + value, 0) / values.length;
        case 'min':
            return Math.min(...values);
        case 'max':
            return Math.max(...values);
        case 'sum':
            return values.reduce((sum, value) => sum + value, 0);
        case 'last':
        default:
            return values[values.length - 1];
    }
}

/**
 * Verdichtet rohe Punkte auf das Raster. Ergebnis ist aufsteigend, ohne
 * Dubletten, und trägt für jedes Intervall entweder einen Wert oder eine
 * ausgewiesene Lücke.
 */
export function resample(points: ReadonlyArray<RawPoint>, options: ResampleOptions): Observation[] {
    const { intervalSeconds, aggregation, kind, through } = options;
    const step = intervalSeconds * 1000;
    const after = options.after ?? Number.NEGATIVE_INFINITY;
    const sorted = [...points].sort((a, b) => a.t - b.t);

    // Rohpunkte nach Rasterpunkt gruppieren.
    const buckets = new Map<number, RawPoint[]>();
    for (const point of sorted) {
        const bucket = bucketOf(point.t, intervalSeconds);
        const list = buckets.get(bucket);
        if (list) list.push(point);
        else buckets.set(bucket, [point]);
    }
    if (buckets.size === 0) return [];

    const firstBucket = Math.min(...buckets.keys());
    // Bis ans Fensterende, nicht bis zum letzten Rohwert: Ein Schalter, der
    // seit Stunden unverändert an ist, hat gerade DESHALB keine neuen
    // Einträge — sein Zustand gilt trotzdem weiter (siehe Kopfkommentar).
    const lastBucket = bucketOf(through, intervalSeconds);

    const result: Observation[] = [];
    // Fortgeschriebener Zustand: Wert des letzten Intervalls mit Inhalt.
    let carry: number | string | null | undefined = options.carry;
    // Lücken werden nicht fortgeschrieben — sie beenden den Carry.
    let carryIsGap = false;

    // Notbremse gegen ein pathologisches Fenster (Sekundenraster über
    // Monate). Sie greift nie im gedachten Betrieb — und wenn doch, ist
    // ein gekapptes Ergebnis besser als eine hängende Schleife.
    const maxBuckets = 1_000_000;
    let emitted = 0;

    for (let bucket = firstBucket; bucket <= lastBucket && emitted < maxBuckets; bucket += step, emitted += 1) {
        const entries = buckets.get(bucket);
        if (entries && entries.length > 0) {
            const usable = entries.filter(entry => entry.value !== null);
            if (usable.length === 0) {
                // Nur Lücken in diesem Intervall.
                const gap = entries[entries.length - 1].gap ?? 'unavailable';
                carry = null;
                carryIsGap = true;
                if (bucket > after) result.push({ t: bucket, v: null, q: gap });
                continue;
            }
            carryIsGap = false;
            if (kind === 'categorical' || aggregation === 'last') {
                carry = usable[usable.length - 1].value;
            } else {
                const numbers = usable
                    .map(entry => (typeof entry.value === 'number' ? entry.value : Number(entry.value)))
                    .filter(value => Number.isFinite(value));
                carry = numbers.length > 0 ? aggregate(numbers, aggregation) : usable[usable.length - 1].value;
            }
            if (bucket > after) result.push({ t: bucket, v: carry });
            continue;
        }

        // Leeres Intervall: Zustand hält an — außer die Quelle hatte
        // zuletzt eine Lücke gemeldet.
        if (carryIsGap) {
            if (bucket > after) result.push({ t: bucket, v: null, q: 'unavailable' });
            continue;
        }
        if (carry === undefined) continue;
        // Summen fortzuschreiben wäre eine Erfindung: eine Summe gilt für
        // ihr Intervall, nicht für das nächste.
        if (aggregation === 'sum') {
            if (bucket > after) result.push({ t: bucket, v: 0 });
            continue;
        }
        if (bucket > after) result.push({ t: bucket, v: carry });
    }

    return result;
}
