/**
 * Beobachtungs-Speicher: die Messwerte, die NICHT im Triplestore liegen
 * (CAUSAL_LAYER_SPEC §6, Invariante C3).
 *
 * Format: eine NDJSON-Datei pro Größe und Tag, streng aufsteigend nach
 * Zeit, ausschließlich angehängt.
 *
 *   <root>/observations/<userId>/<variableId>/2026-08-13.ndjson
 *   {"t":1786000000000,"v":21.5}
 *   {"t":1786000300000,"v":21.6}
 *   {"t":1786000600000,"v":null,"q":"unavailable"}
 *
 * Warum Tagesdateien und nicht eine Datei pro Größe: `FileSystemLike`
 * kennt kein garantiertes Anhängen (OPFS braucht dafür einen Schreib-
 * Handle mit Seek). Wo `appendFile` fehlt, wird gelesen, verkettet und
 * geschrieben — bei einer Tagesdatei ist das ein begrenzter, kleiner
 * Betrag, bei einer Jahresdatei wäre es quadratisch.
 *
 * Warum kein Parquet: Es bräuchte eine Abhängigkeit, die in allen drei
 * Runtimes läuft, und würde das Anhängen verlieren. NDJSON ist
 * verlustfrei, zeilenweise streambar, mit jedem Werkzeug lesbar und im
 * Zweifel von Hand reparierbar — die richtige Wahl für einen Bestand,
 * der über Jahre wachsen und Formatwechsel überleben soll.
 *
 * Robustheit: Eine kaputte Zeile (abgebrochener Schreibvorgang, externe
 * Bearbeitung) wirft nicht — sie wird übersprungen und gezählt. Ein
 * einzelner defekter Tag darf keine Jahresreihe unlesbar machen.
 */

import type { FileSystemLike } from '@/lib/platform/runtime/types';
import type { Observation } from './types';

/** Verzeichnisname unterhalb des Datenverzeichnisses. */
export const OBSERVATIONS_DIR = 'observations';

const SEGMENT_PATTERN = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;

export interface ObservationStoreOptions {
    files: FileSystemLike;
    /** Datenwurzel der Installation (server: `<cwd>/data`). */
    root: string;
    userId: string;
}

export interface SegmentInfo {
    /** Tag im Format YYYY-MM-DD (UTC). */
    day: string;
    path: string;
}

export interface ReadRange {
    /** Untere Grenze, exklusiv (Millisekunden seit Epoch). */
    after?: number;
    /** Obere Grenze, inklusiv. */
    through?: number;
    /** Harte Kappung der zurückgegebenen Punkte (ältere zuerst). */
    limit?: number;
}

export interface ReadResult {
    observations: Observation[];
    /** Übersprungene, nicht parsebare Zeilen — ehrlich gemeldet. */
    corruptLines: number;
    /** true, wenn `limit` gegriffen hat. */
    truncated: boolean;
}

/** Pfadsicheres Segment: alles außer [a-z0-9-_] wird prozentcodiert. */
function safeSegment(value: string): string {
    return encodeURIComponent(value).replace(/\*/g, '%2A');
}

/** UTC-Tag eines Zeitstempels — die Partitionierung ist zeitzonenfrei. */
export function dayOf(timestampMs: number): string {
    return new Date(timestampMs).toISOString().slice(0, 10);
}

function parseLine(line: string): Observation | null {
    if (line === '') return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const t = record.t;
    if (typeof t !== 'number' || !Number.isFinite(t)) return null;
    const v = record.v;
    if (v !== null && typeof v !== 'number' && typeof v !== 'string') return null;
    const observation: Observation = { t, v: v ?? null };
    if (typeof record.q === 'string') observation.q = record.q;
    return observation;
}

function serialize(observation: Observation): string {
    return `${JSON.stringify(observation)}\n`;
}

/**
 * Datei-gebundener Speicher der Messreihen. Kennt keinen Store, keine
 * IRIs und keine Quelle — er hält Zahlen an Zeitstempeln, sonst nichts.
 */
export class ObservationStore {
    private readonly files: FileSystemLike;
    private readonly base: string;

    constructor(options: ObservationStoreOptions) {
        this.files = options.files;
        this.base = `${options.root}/${OBSERVATIONS_DIR}/${safeSegment(options.userId)}`;
    }

    private dirFor(variableId: string): string {
        return `${this.base}/${safeSegment(variableId)}`;
    }

    private pathFor(variableId: string, day: string): string {
        return `${this.dirFor(variableId)}/${day}.ndjson`;
    }

    /** Vorhandene Tages-Segmente einer Größe, aufsteigend nach Tag. */
    async segments(variableId: string): Promise<SegmentInfo[]> {
        const dir = this.dirFor(variableId);
        if (!(await this.files.exists(dir))) return [];
        const entries = await this.files.readdir(dir);
        return entries
            .map(entry => {
                const match = SEGMENT_PATTERN.exec(entry);
                return match ? { day: match[1], path: `${dir}/${entry}` } : null;
            })
            .filter((entry): entry is SegmentInfo => entry !== null)
            .sort((a, b) => a.day.localeCompare(b.day));
    }

    /**
     * Hängt Messpunkte an. Verlangt aufsteigende Zeitstempel und
     * verwirft alles, was nicht **echt neuer** als `after` ist — damit
     * ist ein wiederholter Lauf idempotent und erzeugt nie Dubletten.
     * Gibt zurück, was tatsächlich geschrieben wurde.
     */
    async append(
        variableId: string,
        observations: ReadonlyArray<Observation>,
        options: { after?: number } = {},
    ): Promise<{ appended: number; firstAt?: number; lastAt?: number }> {
        const after = options.after ?? Number.NEGATIVE_INFINITY;
        const fresh = observations
            .filter(entry => Number.isFinite(entry.t) && entry.t > after)
            .sort((a, b) => a.t - b.t);
        if (fresh.length === 0) return { appended: 0 };

        await this.files.mkdir(this.dirFor(variableId));

        // Nach Tag gruppieren, damit jede Datei genau einmal angefasst wird.
        const byDay = new Map<string, Observation[]>();
        for (const entry of fresh) {
            const day = dayOf(entry.t);
            const list = byDay.get(day);
            if (list) list.push(entry);
            else byDay.set(day, [entry]);
        }

        for (const [day, entries] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            const path = this.pathFor(variableId, day);
            const chunk = entries.map(serialize).join('');
            if (this.files.appendFile) {
                await this.files.appendFile(path, chunk);
                continue;
            }
            // Ohne Anhänge-Fähigkeit: lesen, verketten, schreiben. Korrekt,
            // nur teurer — und durch die Tagespartition begrenzt.
            const before = (await this.files.exists(path)) ? await this.files.readFile(path) : '';
            await this.files.writeFile(path, before + chunk);
        }

        return { appended: fresh.length, firstAt: fresh[0].t, lastAt: fresh[fresh.length - 1].t };
    }

    /** Liest eine Reihe im Zeitfenster, aufsteigend. */
    async read(variableId: string, range: ReadRange = {}): Promise<ReadResult> {
        const after = range.after ?? Number.NEGATIVE_INFINITY;
        const through = range.through ?? Number.POSITIVE_INFINITY;
        const limit = range.limit ?? Number.POSITIVE_INFINITY;
        const fromDay = Number.isFinite(after) ? dayOf(after) : '';
        const toDay = Number.isFinite(through) ? dayOf(through) : '￿';

        const observations: Observation[] = [];
        let corruptLines = 0;
        let truncated = false;

        for (const segment of await this.segments(variableId)) {
            if (segment.day < fromDay || segment.day > toDay) continue;
            const content = await this.files.readFile(segment.path);
            for (const line of content.split('\n')) {
                if (line.trim() === '') continue;
                const observation = parseLine(line);
                if (!observation) {
                    corruptLines += 1;
                    continue;
                }
                if (observation.t <= after || observation.t > through) continue;
                if (observations.length >= limit) {
                    truncated = true;
                    break;
                }
                observations.push(observation);
            }
            if (truncated) break;
        }

        observations.sort((a, b) => a.t - b.t);
        return { observations, corruptLines, truncated };
    }

    /**
     * Abdeckung und Umfang einer Reihe, aus dem Bestand gelesen. Teurer
     * als der im Graphen mitgeführte Zähler — Grundlage für dessen
     * Abgleich und für ehrliche Zahlen nach externen Eingriffen.
     */
    async coverage(variableId: string): Promise<{ from?: number; through?: number; count: number }> {
        let from: number | undefined;
        let through: number | undefined;
        let count = 0;
        for (const segment of await this.segments(variableId)) {
            const content = await this.files.readFile(segment.path);
            for (const line of content.split('\n')) {
                if (line.trim() === '') continue;
                const observation = parseLine(line);
                if (!observation) continue;
                count += 1;
                if (from === undefined || observation.t < from) from = observation.t;
                if (through === undefined || observation.t > through) through = observation.t;
            }
        }
        return { from, through, count };
    }

    /**
     * Entfernt Segmente, die vollständig vor `before` liegen
     * (Aufbewahrungsfrist). Nur ganze Tage — ein teilweise abgelaufener
     * Tag bleibt, statt eine Datei umzuschreiben und dabei riskieren zu
     * müssen, den Bestand zu beschädigen.
     */
    async prune(variableId: string, before: number): Promise<{ pruned: number; removedSegments: string[] }> {
        const cutoffDay = dayOf(before);
        let pruned = 0;
        const removedSegments: string[] = [];
        for (const segment of await this.segments(variableId)) {
            if (segment.day >= cutoffDay) continue;
            const content = await this.files.readFile(segment.path);
            pruned += content.split('\n').filter(line => line.trim() !== '').length;
            await this.files.rm(segment.path);
            removedSegments.push(segment.day);
        }
        return { pruned, removedSegments };
    }

    /** Löscht den gesamten Bestand einer Größe (beim Entfernen der Variablen). */
    async drop(variableId: string): Promise<number> {
        const segments = await this.segments(variableId);
        for (const segment of segments) {
            await this.files.rm(segment.path);
        }
        const dir = this.dirFor(variableId);
        if (await this.files.exists(dir)) {
            await this.files.rm(dir);
        }
        return segments.length;
    }
}
