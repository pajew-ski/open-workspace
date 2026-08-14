/**
 * `csv-observations` — eigene Messungen aus einer Datei
 * (CAUSAL_LAYER_SPEC §10; die Lücke aus docs/spec-widersprueche.md,
 * Eintrag 7, geschlossen am 2026-08-14).
 *
 * **Warum das kein neuer Connector-Typ, sondern ein neuer Weg ist**: Die
 * Abbildung offener Zeitreihen (`rest-timeseries/mapping.ts`) trägt CSV
 * bereits vollständig — Kopfzeile, Trennzeichen, Zeitspalte,
 * Wertspalten. Was fehlte, war der **Datei**- statt des Netz-Wegs. Genau
 * das ist dieser Connector: dieselbe Abbildung, dieselbe Struktur,
 * dieselbe Erfassung, nur eine andere Herkunft des Textes.
 *
 * Damit ist der Fall abgedeckt, der in `local` der wichtigste ist:
 * Self-Tracking-Exporte, Messreihen aus einem anderen Werkzeug, alles,
 * was als Tabelle vorliegt und keine API hat.
 *
 * **Pfad-Politik**: dieselbe wie bei `obsidian-vault` und `json-canvas`
 * (`data/vaults/…` oder eine Wurzel aus `OW_VAULT_ROOTS`). Eine dritte
 * Politik zu erfinden hieße, drei Stellen zu haben, an denen ein
 * Serverpfad falsch freigegeben werden kann.
 *
 * **Die Werte bleiben in der Datei.** Materialisiert wird die
 * Angebotsseite: welche Spalten es gibt, in welchem Skalenniveau
 * (Invariante C3). Die Reihen liest der Erfassungslauf.
 */

import type { Quad } from '@rdfjs/types';
import { z } from 'zod';
import type { Connector, ConnectorContext, SourceRef } from '../types';
import { sha256Hex } from '../quads';
import { normalizeVaultPath, resolveVaultRoot } from '../obsidian/vault';
import { slugify } from '../../observations/naming';
import { sourceStructureQuads } from '../../observations/source-structure';
import type { ObservationKind } from '../../observations/types';
import {
    parseCsv,
    parseTimestamp,
    type RestSeries,
    type RestSourceMapping,
    type TimeFormat,
} from '../rest-timeseries/mapping';

const configSchema = z.object({
    /** Pfad der CSV-Datei unter `data/vaults/` oder einer OW_VAULT_ROOTS-Wurzel. */
    path: z.string().trim().min(1, 'Pfad der CSV-Datei ist erforderlich'),
    /** Spalte mit dem Zeitstempel. */
    timeField: z.string().trim().min(1).default('timestamp'),
    timeFormat: z.enum(['iso', 'date', 'unix-s', 'unix-ms']).default('iso'),
    delimiter: z.string().trim().max(1).default(','),
});

export type CsvObservationsConfig = z.infer<typeof configSchema>;

/** Wie viele Zeilen die Skalenniveau-Erkennung ansieht. */
const SAMPLE_ROWS = 200;

/**
 * Skalenniveau aus den Werten einer Spalte — geraten wird nichts, was die
 * Datei nicht hergibt: Nur Zahlen heißt numerisch, nur 0/1 heißt
 * zweiwertig, alles andere kategorial. Eine falsche Einstufung machte
 * jede spätere Verdichtung sinnlos (ein Mittelwert über Zustände ist eine
 * Falschaussage), deshalb entscheidet der Bestand und nicht der
 * Spaltenname.
 */
export function classifyColumn(values: readonly string[]): ObservationKind {
    const present = values.filter(value => value.trim() !== '');
    if (present.length === 0) return 'categorical';
    const numbers = present.map(value => Number(value.replace(',', '.')));
    if (!numbers.every(value => Number.isFinite(value))) return 'categorical';
    return numbers.every(value => value === 0 || value === 1) ? 'binary' : 'numeric';
}

export interface CsvInventory {
    mapping: RestSourceMapping;
    /** Zeilen, die keinen brauchbaren Zeitstempel hatten. */
    unusable: number;
    rows: number;
}

/**
 * Liest die Kopfzeile und eine Stichprobe und leitet daraus die
 * angebotenen Reihen ab. Die Kopfzeile IST die Wahrheit — eine Spalte
 * nach Position zu raten wäre die Sorte stiller Fehler, die erst in der
 * Schätzung auffällt.
 */
export function inventoryFromCsv(config: CsvObservationsConfig, body: string): CsvInventory {
    const delimiter = config.delimiter === '' ? ',' : config.delimiter;
    const records = parseCsv(body, delimiter);
    if (records.length === 0) {
        throw new Error('Die Datei hat keine Kopfzeile mit mindestens einer Datenzeile.');
    }
    const columns = Object.keys(records[0]);
    if (!columns.includes(config.timeField)) {
        throw new Error(
            `Die Zeitspalte "${config.timeField}" gibt es nicht. Vorhanden: ${columns.join(', ')}.`,
        );
    }
    const sample = records.slice(0, SAMPLE_ROWS);
    const unusable = sample.filter(record =>
        parseTimestamp(record[config.timeField], config.timeFormat as TimeFormat) === null).length;
    if (unusable === sample.length) {
        throw new Error(
            `Keine Zeile der Stichprobe hat in "${config.timeField}" einen Zeitstempel im Format `
            + `"${config.timeFormat}".`,
        );
    }

    const series: RestSeries[] = columns
        .filter(column => column !== config.timeField && column.trim() !== '')
        .map(column => {
            const kind = classifyColumn(sample.map(record => String(record[column] ?? '')));
            return {
                key: slugify(column),
                name: column,
                kind,
                // Eine Datei sagt nicht, ob eine Spalte ein Zustand oder ein
                // Fluss ist. Der Mittelwert ist für Zahlen die harmloseste
                // Annahme, `last` für alles andere die einzig zulässige.
                aggregation: kind === 'numeric' ? 'mean' as const : 'last' as const,
                field: column,
            };
        });
    if (series.length === 0) {
        throw new Error('Außer der Zeitspalte enthält die Datei keine Spalte.');
    }

    return {
        rows: records.length,
        unusable,
        mapping: {
            label: `CSV: ${config.path.split('/').pop() ?? config.path}`,
            url: config.path,
            format: 'csv',
            shape: 'points',
            query: {},
            windowMode: 'range',
            windowFormat: 'iso',
            // Eine Datei wird ganz gelesen; ein Zeitfenster in der Anfrage
            // gibt es nicht, gefiltert wird nach dem Parsen.
            windowDays: 3660,
            timeField: config.timeField,
            timeFormat: config.timeFormat as TimeFormat,
            delimiter,
            series,
            attribution: `Eigene Messreihe aus ${config.path}.`,
            minRequestIntervalMs: 0,
            cacheTtlMs: 0,
        },
    };
}

/** Liest die Datei über den Dateizugriff der Runtime. */
export async function readCsvFile(ctx: Pick<ConnectorContext, 'files'>, path: string): Promise<string> {
    if (!ctx.files) {
        throw new Error('Diese Runtime stellt keinen Dateizugriff bereit — CSV-Import nicht möglich.');
    }
    const absolute = resolveVaultRoot(path);
    return ctx.files.readFile(absolute);
}

export const csvObservationsConnector: Connector<CsvObservationsConfig> = {
    kind: 'csv-observations',
    mode: 'materialize',
    capabilities: { read: true, write: false, watch: false, lossyExport: false },
    label: 'Eigene Messreihen (CSV)',
    description:
        'Messreihen aus einer CSV-Datei: Zeitspalte plus beliebig viele Wertspalten. '
        + 'Skalenniveau wird aus dem Bestand erkannt, nicht aus dem Spaltennamen. Importiert wird '
        + 'die Struktur; die Werte liest die Erfassung unter Graph → Beobachtungen.',

    configSchema: () => z.toJSONSchema(configSchema) as Record<string, unknown>,
    parseConfig: input => {
        const config = configSchema.parse(input);
        normalizeVaultPath(config.path);
        return config;
    },

    locatorFor: config =>
        `${normalizeVaultPath(config.path)}|${config.timeField}|${config.timeFormat}|${config.delimiter}`,
    configFromLocator: locator => {
        const parts = locator.split('|');
        return configSchema.parse({
            path: parts[0] ?? '',
            ...(parts[1] ? { timeField: parts[1] } : {}),
            ...(parts[2] ? { timeFormat: parts[2] } : {}),
            // Ein leeres Trennzeichen ist eine Angabe („Voreinstellung"),
            // kein fehlender Teil — deshalb nur setzen, wenn es eines gibt.
            ...(parts[3] ? { delimiter: parts[3] } : {}),
        });
    },

    async probe(config, ctx): Promise<SourceRef> {
        const body = await readCsvFile(ctx, config.path);
        // Lesbarkeit wird hier geprüft und nicht erst beim Import: Eine
        // Datei ohne Zeitspalte ist kein leerer Lauf, sondern ein Fehler.
        inventoryFromCsv(config, body);
        // Revision ist der Inhalts-Hash: Eine unveränderte Datei ist ein
        // No-Op, eine angehängte Zeile ein neuer Lauf. Anders als bei einer
        // API ändert sich hier die Struktur mit den Daten — die Spalten
        // stehen in derselben Datei.
        return {
            id: '',
            kind: this.kind,
            locator: this.locatorFor(config),
            revision: `sha256:${await sha256Hex(body)}`,
            fetchedAt: new Date().toISOString(),
        };
    },

    async *pull(ref: SourceRef, ctx: ConnectorContext): AsyncIterable<Quad> {
        const config = this.configFromLocator(ref.locator);
        const body = await readCsvFile(ctx, config.path);
        const inventory = inventoryFromCsv(config, body);
        if (inventory.unusable > 0) {
            ctx.quarantine({
                source: config.path,
                reason: `${inventory.unusable} von ${Math.min(inventory.rows, SAMPLE_ROWS)} `
                    + `Stichprobenzeilen haben in "${config.timeField}" keinen lesbaren Zeitstempel.`,
            });
        }
        const { quads, counts } = sourceStructureQuads(
            ctx.iri,
            ref.id,
            {
                label: inventory.mapping.label,
                locator: config.path,
                locatorKind: 'path',
                attribution: inventory.mapping.attribution,
                series: inventory.mapping.series.map(entry => ({
                    key: entry.key,
                    name: entry.name,
                    kind: entry.kind,
                    ...(entry.unit ? { unit: entry.unit } : {}),
                })),
            },
            inventory.mapping.series.map(entry => entry.key),
        );
        ctx.report({
            done: 1,
            total: 1,
            note: `${counts.series} Spalten aus ${inventory.rows} Zeilen. `
                + 'Die Werte liest die Erfassung unter Graph → Beobachtungen.',
        });
        yield* quads;
    },
};
