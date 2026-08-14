/**
 * Abbildung des Home-Assistant-Inventars auf RDF — rein, ohne Netz und
 * ohne Store, damit die Abnahme das Mapping direkt prüfen kann.
 *
 * Vokabular: SOSA für die Sensorik, schema.org für Ort und Benennung.
 * Kein eigener Geräte-Term (Invariante 8) — SOSA ist der W3C/OGC-Standard
 * für genau diese Frage:
 *
 *   Etage/Bereich  → schema:Place (Etage über schema:containedInPlace)
 *   Gerät          → sosa:Platform, schema:location → Bereich
 *   Entität        → sosa:Sensor bzw. sosa:Actuator, sosa:isHostedBy → Gerät
 *   Messgröße      → sosa:ObservableProperty, sosa:observes → Größe
 *
 * **Warum diese Struktur der eigentliche Gewinn ist**: Sie sagt, welcher
 * Sensor welchen Raum misst und welches Gerät in welchem Raum steht. Das
 * ist die strukturelle Vorannahme eines Kausalmodells — bekannte
 * Topologie, nicht geraten. Ein Heizkörper in Raum A kann die Temperatur
 * in Raum B nicht direkt beeinflussen; wer das im Graphen stehen hat,
 * kann Kandidatenkanten prüfen, statt sie zu glauben.
 */

import type { Quad } from '@rdfjs/types';
import type { IriFactory } from '../../iri';
import { factory, literal, namedNode } from '../../rdf';
import { DCTERMS, OW, RDF, SCHEMA, SOSA } from '../../vocab';
import type { ObservationKind } from '../../observations/types';
import { slugify } from '../../observations/naming';
import type { HaEntityRecord } from './api';

/**
 * Domains, deren Zustand geschaltet wird. Sie werden zu sosa:Actuator —
 * und sind damit die Kandidaten für Treatments in einem Kausalmodell,
 * während Sensoren die Outcomes tragen.
 */
export const ACTUATOR_DOMAINS: ReadonlySet<string> = new Set([
    'switch', 'light', 'climate', 'fan', 'cover', 'lock', 'media_player',
    'humidifier', 'valve', 'water_heater', 'siren', 'vacuum', 'number',
    'select', 'button', 'scene', 'script', 'automation', 'input_boolean',
    'input_number', 'input_select', 'remote',
]);

/** Domains mit zweiwertigem Zustand (an/aus, offen/zu, erkannt/nicht). */
const BINARY_DOMAINS: ReadonlySet<string> = new Set([
    'binary_sensor', 'switch', 'light', 'input_boolean', 'lock', 'automation',
    'script', 'fan', 'siren', 'valve', 'cover', 'person', 'device_tracker',
    'schedule', 'update',
]);

/** Domains mit durchgehend numerischem Zustand, auch ohne Einheit. */
const NUMERIC_DOMAINS: ReadonlySet<string> = new Set(['number', 'input_number', 'counter']);

/**
 * Skalenniveau einer Entität. Die Reihenfolge ist Absicht: Ein Licht mit
 * Helligkeitsattribut ist im ZUSTAND trotzdem zweiwertig — erfasst wird
 * der Zustand, nicht das Attribut, und eine falsche Einstufung machte
 * jede spätere Verdichtung sinnlos.
 */
export function classifyEntity(entity: HaEntityRecord): ObservationKind {
    if (BINARY_DOMAINS.has(entity.domain)) return 'binary';
    if (NUMERIC_DOMAINS.has(entity.domain)) return 'numeric';
    if (entity.stateClass || entity.unit) return 'numeric';
    return 'categorical';
}

const TRUE_STATES: ReadonlySet<string> = new Set([
    'on', 'open', 'opening', 'home', 'unlocked', 'detected', 'true', 'active', 'above_horizon',
]);
const FALSE_STATES: ReadonlySet<string> = new Set([
    'off', 'closed', 'closing', 'not_home', 'locked', 'false', 'idle', 'below_horizon',
]);
/** Zustände, die Home Assistant für „kein Wert" führt. */
export const GAP_STATES: ReadonlySet<string> = new Set(['unavailable', 'unknown', '', 'none']);

export interface ParsedState {
    value: number | string | null;
    /** Grund einer Lücke, quelltreu — null heißt: echter Wert. */
    gap?: string;
}

/**
 * Übersetzt einen HA-Zustandstext in einen Messwert. Lücken werden
 * ERFASST, nicht übersprungen: Ein ausgefallener Sensor ist eine
 * Information, und stillschweigend weggelassene Zeiträume verzerren jede
 * spätere Schätzung, ohne sichtbar zu sein.
 */
export function parseState(raw: string, kind: ObservationKind): ParsedState {
    const state = raw.trim();
    const lower = state.toLowerCase();
    if (GAP_STATES.has(lower)) return { value: null, gap: lower === '' ? 'empty' : lower };
    if (kind === 'numeric') {
        const value = Number(state);
        return Number.isFinite(value) ? { value } : { value: null, gap: `nicht numerisch: ${state}` };
    }
    if (kind === 'binary') {
        if (TRUE_STATES.has(lower)) return { value: 1 };
        if (FALSE_STATES.has(lower)) return { value: 0 };
        const value = Number(state);
        if (Number.isFinite(value)) return { value: value === 0 ? 0 : 1 };
        return { value: null, gap: `nicht zweiwertig: ${state}` };
    }
    return { value: state };
}

// Slug und Vorschlags-ID gelten für jede Quelle, nicht nur für Home
// Assistant — sie liegen seit C5 in `observations/naming.ts`. Hier bleibt
// die Adresse erhalten, damit kein Aufrufer wegen eines Umzugs umgebaut
// werden muss.
export { slugify, variableIdFor } from '../../observations/naming';

export interface StructureMappingResult {
    quads: Quad[];
    /** Anzahl abgebildeter Entitäten, Geräte, Bereiche und Etagen. */
    counts: { entities: number; devices: number; areas: number; floors: number };
}

/**
 * Bildet das Inventar auf Quads ab (ohne Graph-Komponente — den
 * Ziel-Graphen erzwingt der Runner).
 */
export function inventoryQuads(iri: IriFactory, entities: ReadonlyArray<HaEntityRecord>): StructureMappingResult {
    const quads: Quad[] = [];
    const seenAreas = new Set<string>();
    const seenFloors = new Set<string>();
    const seenDevices = new Set<string>();
    const seenObservables = new Set<string>();

    const push = (s: string, p: string, o: Quad['object']) =>
        quads.push(factory.quad(namedNode(s), namedNode(p), o));

    for (const entity of entities) {
        // Etage
        let floorIri: string | undefined;
        if (entity.floorName) {
            floorIri = iri.entity('place', `floor-${slugify(entity.floorName)}`);
            if (!seenFloors.has(floorIri)) {
                seenFloors.add(floorIri);
                push(floorIri, RDF.type, namedNode(SCHEMA.Place));
                push(floorIri, SCHEMA.name, literal(entity.floorName));
            }
        }

        // Bereich
        let areaIri: string | undefined;
        if (entity.areaId) {
            areaIri = iri.entity('place', `area-${slugify(entity.areaId)}`);
            if (!seenAreas.has(areaIri)) {
                seenAreas.add(areaIri);
                push(areaIri, RDF.type, namedNode(SCHEMA.Place));
                push(areaIri, SCHEMA.name, literal(entity.areaName ?? entity.areaId));
                push(areaIri, DCTERMS.identifier, literal(entity.areaId));
                if (floorIri) push(areaIri, SCHEMA.containedInPlace, namedNode(floorIri));
            }
        }

        // Gerät
        let deviceIri: string | undefined;
        if (entity.deviceId) {
            deviceIri = iri.entity('device', entity.deviceId);
            if (!seenDevices.has(deviceIri)) {
                seenDevices.add(deviceIri);
                push(deviceIri, RDF.type, namedNode(SOSA.Platform));
                push(deviceIri, SCHEMA.name, literal(entity.deviceName ?? entity.deviceId));
                push(deviceIri, DCTERMS.identifier, literal(entity.deviceId));
                if (areaIri) push(deviceIri, SCHEMA.location, namedNode(areaIri));
            }
        }

        // Entität
        const kind = classifyEntity(entity);
        const sensorIri = iri.entity('sensor', entity.entityId);
        const sensorType = ACTUATOR_DOMAINS.has(entity.domain) ? SOSA.Actuator : SOSA.Sensor;
        push(sensorIri, RDF.type, namedNode(sensorType));
        push(sensorIri, SCHEMA.name, literal(entity.name));
        push(sensorIri, DCTERMS.identifier, literal(entity.entityId));
        push(sensorIri, SCHEMA.category, literal(entity.domain));
        push(sensorIri, OW.observationKind, literal(kind));
        if (entity.unit) push(sensorIri, SCHEMA.unitText, literal(entity.unit));
        if (areaIri) push(sensorIri, SCHEMA.location, namedNode(areaIri));
        if (deviceIri) {
            push(sensorIri, SOSA.isHostedBy, namedNode(deviceIri));
            push(deviceIri, SOSA.hosts, namedNode(sensorIri));
        }

        // Beobachtete Größe: die device_class ist der einzige Schlüssel, unter
        // dem gleichartige Sensoren verschiedener Hersteller vergleichbar
        // werden ("alle Temperaturen") — ohne sie bliebe jede Entität ein
        // Einzelfall.
        const observableKey = entity.deviceClass ?? (entity.unit ? slugify(entity.unit) : undefined);
        if (observableKey) {
            const observableIri = iri.entity('observable', slugify(observableKey));
            if (!seenObservables.has(observableIri)) {
                seenObservables.add(observableIri);
                push(observableIri, RDF.type, namedNode(SOSA.ObservableProperty));
                push(observableIri, SCHEMA.name, literal(observableKey));
            }
            push(sensorIri, SOSA.observes, namedNode(observableIri));
        }
    }

    return {
        quads,
        counts: {
            entities: entities.length,
            devices: seenDevices.size,
            areas: seenAreas.size,
            floors: seenFloors.size,
        },
    };
}
