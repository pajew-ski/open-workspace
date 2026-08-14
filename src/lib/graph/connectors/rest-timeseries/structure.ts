/**
 * Die REST-Quelle als Struktur im Graphen (CAUSAL_LAYER_SPEC §10, C5).
 *
 * Die eigentliche Abbildung liegt seit dem CSV- und dem
 * Sonnenstand-Connector in `observations/source-structure.ts` — sie gilt
 * für jede Messquelle, die keine Home-Assistant-Installation ist. Hier
 * bleibt nur die Übersetzung von der REST-Abbildung in den allgemeinen
 * Quellen-Steckbrief.
 *
 * **Was ein Open-Data-Connector materialisiert, ist NICHT die
 * Zeitreihe**: Messwerte gehören in den Beobachtungs-Speicher, nie in den
 * Store (Invariante C3). Materialisiert wird die Angebotsseite — welche
 * Größen die Quelle liefert, in welcher Einheit, an welchem Ort, mit
 * welchem Skalenniveau.
 */

import type { IriFactory } from '../../iri';
import {
    parseSourceKey,
    sourceKeyFor,
    sourceStructureQuads,
    OPEN_DATA_CATEGORY,
    type SourceDescriptor,
    type SourceStructureResult,
} from '../../observations/source-structure';
import type { RestSourceMapping } from './mapping';

// Der Quellschlüssel ist quellartunabhängig — die Adressen hier bleiben
// erhalten, damit kein Aufrufer wegen eines Umzugs umgebaut werden muss.
export { sourceKeyFor as restSourceKey, parseSourceKey as parseRestSourceKey };

/** Kategorie aller Open-Data-Reihen — das Gegenstück zur HA-Domain. */
export const REST_CATEGORY = OPEN_DATA_CATEGORY;

/** Die REST-Abbildung als allgemeiner Quellen-Steckbrief. */
export function descriptorForMapping(mapping: RestSourceMapping): SourceDescriptor {
    return {
        label: mapping.label,
        locator: mapping.url,
        locatorKind: 'url',
        attribution: mapping.attribution,
        ...(mapping.place ? { place: mapping.place } : {}),
        series: mapping.series.map(entry => ({
            key: entry.key,
            name: entry.name,
            kind: entry.kind,
            ...(entry.unit ? { unit: entry.unit } : {}),
            ...(entry.observable ? { observable: entry.observable } : {}),
            ...(entry.role ? { role: entry.role } : {}),
        })),
    };
}

/**
 * Bildet die Quelle auf Quads ab (ohne Graph-Komponente — den
 * Ziel-Graphen erzwingt der Runner). `availableKeys` sind die Reihen, die
 * die Quelle wirklich geliefert hat; eine Reihe, die es beim Anbieter
 * nicht gibt, wird nicht behauptet (Invariante 10).
 */
export function sourceQuads(
    iri: IriFactory,
    connectorId: string,
    mapping: RestSourceMapping,
    availableKeys: ReadonlyArray<string>,
): SourceStructureResult {
    return sourceStructureQuads(iri, connectorId, descriptorForMapping(mapping), availableKeys);
}
