/**
 * Die Quelle als Struktur im Graphen — rein, ohne Netz und ohne Store
 * (CAUSAL_LAYER_SPEC §10, Meilenstein C5).
 *
 * **Was ein Open-Data-Connector materialisiert, ist NICHT die Zeitreihe.**
 * Das ist keine Einschränkung, sondern dieselbe Trennung wie bei Home
 * Assistant (C3): Messwerte gehören in den Beobachtungs-Speicher, nie in
 * den Store (Invariante C3). Ein Jahr Stundenwerte wären 8.760 Tripel je
 * Größe, auf denen nie eine Graph-Query läuft.
 *
 * Materialisiert wird die **Angebotsseite**: welche Größen diese Quelle
 * liefert, in welcher Einheit, an welchem Ort, mit welchem Skalenniveau.
 * Genau das braucht die Erfassung, um daraus eine `ow:Variable` zu machen
 * — und genau darüber taucht eine Störgröße aus Open Data in derselben
 * Kandidatenliste auf wie ein Sensor aus dem Haus. Es gibt keine zweite
 * Liste und keinen zweiten Weg.
 *
 * Vokabular wie in `home-assistant/structure.ts`: SOSA für die Sensorik,
 * schema.org für Ort, Benennung und Herkunft (Invariante 8).
 *
 *   Quelle       → sosa:Platform (schema:url, schema:creditText)
 *   Ort          → schema:Place mit schema:latitude/longitude
 *   Reihe        → sosa:Sensor, sosa:isHostedBy → Quelle
 *   Messgröße    → sosa:ObservableProperty, sosa:observes → Größe
 */

import type { Quad } from '@rdfjs/types';
import type { IriFactory } from '../../iri';
import { factory, literal, namedNode, typedLiteral } from '../../rdf';
import { DCTERMS, OW, RDF, SCHEMA, SOSA } from '../../vocab';
import { slugify } from '../../observations/naming';
import type { RestSourceMapping } from './mapping';

/**
 * Der Quellschlüssel einer Reihe: Connector-Instanz und Reihenschlüssel.
 * Er steht als `dcterms:identifier` an der Reihe und später als
 * `ow:observationSource` an der Variablen — die Erfassung findet darüber
 * zurück zur Quelle, ohne dass irgendwo eine zweite Zuordnungstabelle
 * entsteht.
 */
export function restSourceKey(connectorId: string, seriesKey: string): string {
    return `${connectorId}#${seriesKey}`;
}

/** Zerlegt einen Quellschlüssel wieder; `null`, wenn er keiner ist. */
export function parseRestSourceKey(source: string): { connectorId: string; seriesKey: string } | null {
    const separator = source.indexOf('#');
    if (separator <= 0 || separator === source.length - 1) return null;
    return {
        connectorId: source.slice(0, separator),
        seriesKey: source.slice(separator + 1),
    };
}

/** Kategorie aller Open-Data-Reihen — das Gegenstück zur HA-Domain. */
export const REST_CATEGORY = 'open-data';

export interface RestStructureResult {
    quads: Quad[];
    counts: { series: number; observables: number };
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
): RestStructureResult {
    const quads: Quad[] = [];
    const push = (s: string, p: string, o: Quad['object']) =>
        quads.push(factory.quad(namedNode(s), namedNode(p), o));

    const platformIri = iri.entity('device', `open-data-${slugify(connectorId)}`);
    push(platformIri, RDF.type, namedNode(SOSA.Platform));
    push(platformIri, SCHEMA.name, literal(mapping.label));
    push(platformIri, DCTERMS.identifier, literal(connectorId));
    push(platformIri, SCHEMA.url, literal(mapping.url));
    // Die Quellenangabe steht wörtlich im Graphen: Wer eine Zahl aus einer
    // Studie zitiert, zitiert am Ende diese Quelle mit.
    push(platformIri, SCHEMA.creditText, literal(mapping.attribution));

    let placeIri: string | undefined;
    if (mapping.place) {
        placeIri = iri.entity('place', `open-data-${slugify(connectorId)}`);
        push(placeIri, RDF.type, namedNode(SCHEMA.Place));
        push(placeIri, SCHEMA.name, literal(mapping.place.name));
        if (mapping.place.latitude !== undefined) {
            push(placeIri, SCHEMA.latitude, typedLiteral.decimal(mapping.place.latitude));
        }
        if (mapping.place.longitude !== undefined) {
            push(placeIri, SCHEMA.longitude, typedLiteral.decimal(mapping.place.longitude));
        }
        push(platformIri, SCHEMA.location, namedNode(placeIri));
    }

    const seenObservables = new Set<string>();
    let series = 0;
    for (const entry of mapping.series) {
        if (!availableKeys.includes(entry.key)) continue;
        series += 1;
        const source = restSourceKey(connectorId, entry.key);
        const sensorIri = iri.entity('sensor', source);
        // Immer sosa:Sensor, nie sosa:Actuator: Eine offene Quelle wird
        // beobachtet und nicht geschaltet. Damit steht sie in der
        // Kandidatenliste auf der Outcome-/Störgrößen-Seite — und das ist
        // genau ihre Rolle im Kausalmodell.
        push(sensorIri, RDF.type, namedNode(SOSA.Sensor));
        push(sensorIri, SCHEMA.name, literal(entry.name));
        push(sensorIri, DCTERMS.identifier, literal(source));
        push(sensorIri, SCHEMA.category, literal(REST_CATEGORY));
        push(sensorIri, OW.observationKind, literal(entry.kind));
        if (entry.unit) push(sensorIri, SCHEMA.unitText, literal(entry.unit));
        if (entry.role) push(sensorIri, SCHEMA.description, literal(entry.role, 'de'));
        if (placeIri) push(sensorIri, SCHEMA.location, namedNode(placeIri));
        push(sensorIri, SOSA.isHostedBy, namedNode(platformIri));
        push(platformIri, SOSA.hosts, namedNode(sensorIri));

        // Dieselbe beobachtete Größe wie bei Home Assistant: „Temperatur"
        // ist Temperatur, egal ob sie ein Zigbee-Sensor oder der DWD
        // meldet. Erst dadurch lässt sich eine Frage stellen, die beide
        // Quellen umfasst.
        if (entry.observable) {
            const observableIri = iri.entity('observable', slugify(entry.observable));
            if (!seenObservables.has(observableIri)) {
                seenObservables.add(observableIri);
                push(observableIri, RDF.type, namedNode(SOSA.ObservableProperty));
                push(observableIri, SCHEMA.name, literal(entry.observable));
            }
            push(sensorIri, SOSA.observes, namedNode(observableIri));
        }
    }

    return { quads, counts: { series, observables: seenObservables.size } };
}
