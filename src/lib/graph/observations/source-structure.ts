/**
 * Die Angebotsseite einer Messquelle als Graph — rein, ohne Netz, ohne
 * Store, ohne Dateien (CAUSAL_LAYER_SPEC §5/§10).
 *
 * **Wozu eine gemeinsame Abbildung**: Seit C5 gibt es mehr als eine Art
 * von Messquelle — Home Assistant, offene REST-Zeitreihen, CSV-Dateien
 * und gerechnete Größen. Sie unterscheiden sich darin, WO die Werte
 * herkommen, und in nichts sonst: Alle vier bieten Reihen an, alle vier
 * müssen in derselben Kandidatenliste erscheinen, alle vier tragen
 * dasselbe SOSA-Vokabular. Vier Abbildungen wären vier Gelegenheiten,
 * dass sie auseinanderlaufen.
 *
 * **Was hier nie entsteht: ein Messwert.** Materialisiert wird das
 * Angebot, nicht die Reihe (Invariante C3). Die Werte holt der
 * Erfassungslauf und legt sie neben den Store.
 *
 *   Quelle       → sosa:Platform (schema:url bzw. dcterms:source, schema:creditText)
 *   Verfahren    → sosa:Procedure, ssn:implements (nur bei gerechneten Quellen)
 *   Ort          → schema:Place mit schema:latitude/longitude
 *   Reihe        → sosa:Sensor, sosa:isHostedBy → Quelle
 *   Messgröße    → sosa:ObservableProperty, sosa:observes → Größe
 */

import type { Quad } from '@rdfjs/types';
import type { IriFactory } from '../iri';
import { factory, literal, namedNode, typedLiteral } from '../rdf';
import { DCTERMS, OW, RDF, SCHEMA, SOSA, SSN } from '../vocab';
import { slugify } from './naming';
import type { ObservationKind } from './types';

/** Kategorie aller Reihen einer Nicht-HA-Quelle — Gegenstück zur HA-Domain. */
export const OPEN_DATA_CATEGORY = 'open-data';

/** Eine angebotene Reihe, unabhängig davon, wie sie später geholt wird. */
export interface SourceSeriesDescriptor {
    key: string;
    name: string;
    kind: ObservationKind;
    unit?: string;
    /** Schlüssel der beobachteten Größe (sosa:ObservableProperty). */
    observable?: string;
    /** Ein Satz zur Rolle im Kausalmodell (UI, nicht Semantik). */
    role?: string;
}

export interface SourceDescriptor {
    /** Anzeigename der Quelle (deutsch). */
    label: string;
    /** Wo sie liegt: URL, Dateipfad — oder nichts, wenn sie gerechnet wird. */
    locator?: string;
    locatorKind: 'url' | 'path';
    /** Quellen- und Lizenzhinweis, wörtlich in den Graphen. */
    attribution: string;
    place?: { name: string; latitude?: number; longitude?: number };
    /**
     * Das Rechenverfahren, wenn die Quelle **rechnet statt misst**. Es
     * steht als `sosa:Procedure` im Graphen, nicht als Fußnote in der UI:
     * Wer eine Reihe adjustiert, muss sehen können, dass sie aus Ort und
     * Zeit entstanden ist und nicht aus einem Gerät. SOSA lässt das
     * ausdrücklich zu — ein Sensor ist dort alles, was eine Beobachtung
     * ausführt, auch ein Verfahren.
     */
    procedure?: { id: string; name: string; description: string };
    series: readonly SourceSeriesDescriptor[];
}

export interface SourceStructureResult {
    quads: Quad[];
    counts: { series: number; observables: number };
}

/**
 * Bildet die Quelle auf Quads ab (ohne Graph-Komponente — den
 * Ziel-Graphen erzwingt der Runner). `availableKeys` sind die Reihen, die
 * die Quelle wirklich anbietet; eine Reihe, die es dort nicht gibt, wird
 * nicht behauptet (Invariante 10).
 */
export function sourceStructureQuads(
    iri: IriFactory,
    connectorId: string,
    source: SourceDescriptor,
    availableKeys: ReadonlyArray<string>,
): SourceStructureResult {
    const quads: Quad[] = [];
    const push = (s: string, p: string, o: Quad['object']) =>
        quads.push(factory.quad(namedNode(s), namedNode(p), o));

    const platformIri = iri.entity('device', `open-data-${slugify(connectorId)}`);
    push(platformIri, RDF.type, namedNode(SOSA.Platform));
    push(platformIri, SCHEMA.name, literal(source.label));
    push(platformIri, DCTERMS.identifier, literal(connectorId));
    if (source.locator) {
        // Eine URL ist eine URL, ein Pfad ist es nicht. `schema:url` für
        // einen Dateipfad wäre eine Zusage, die beim Dereferenzieren
        // bricht.
        push(
            platformIri,
            source.locatorKind === 'url' ? SCHEMA.url : DCTERMS.source,
            literal(source.locator),
        );
    }
    // Die Quellenangabe steht wörtlich im Graphen: Wer eine Zahl aus einer
    // Studie zitiert, zitiert am Ende diese Quelle mit.
    push(platformIri, SCHEMA.creditText, literal(source.attribution));

    if (source.procedure) {
        const procedureIri = iri.entity('procedure', source.procedure.id);
        push(procedureIri, RDF.type, namedNode(SOSA.Procedure));
        push(procedureIri, SCHEMA.name, literal(source.procedure.name));
        push(procedureIri, SCHEMA.description, literal(source.procedure.description, 'de'));
        push(platformIri, SSN.implements, namedNode(procedureIri));
    }

    let placeIri: string | undefined;
    if (source.place) {
        placeIri = iri.entity('place', `open-data-${slugify(connectorId)}`);
        push(placeIri, RDF.type, namedNode(SCHEMA.Place));
        push(placeIri, SCHEMA.name, literal(source.place.name));
        if (source.place.latitude !== undefined) {
            push(placeIri, SCHEMA.latitude, typedLiteral.decimal(source.place.latitude));
        }
        if (source.place.longitude !== undefined) {
            push(placeIri, SCHEMA.longitude, typedLiteral.decimal(source.place.longitude));
        }
        push(platformIri, SCHEMA.location, namedNode(placeIri));
    }

    const seenObservables = new Set<string>();
    let series = 0;
    for (const entry of source.series) {
        if (!availableKeys.includes(entry.key)) continue;
        series += 1;
        const key = sourceKeyFor(connectorId, entry.key);
        const sensorIri = iri.entity('sensor', key);
        // Immer sosa:Sensor, nie sosa:Actuator: Diese Quellen werden
        // beobachtet und nicht geschaltet. Damit stehen sie in der
        // Kandidatenliste auf der Outcome-/Störgrößen-Seite — und das ist
        // genau ihre Rolle im Kausalmodell.
        push(sensorIri, RDF.type, namedNode(SOSA.Sensor));
        push(sensorIri, SCHEMA.name, literal(entry.name));
        push(sensorIri, DCTERMS.identifier, literal(key));
        push(sensorIri, SCHEMA.category, literal(OPEN_DATA_CATEGORY));
        push(sensorIri, OW.observationKind, literal(entry.kind));
        if (entry.unit) push(sensorIri, SCHEMA.unitText, literal(entry.unit));
        if (entry.role) push(sensorIri, SCHEMA.description, literal(entry.role, 'de'));
        if (placeIri) push(sensorIri, SCHEMA.location, namedNode(placeIri));
        push(sensorIri, SOSA.isHostedBy, namedNode(platformIri));
        push(platformIri, SOSA.hosts, namedNode(sensorIri));
        if (source.procedure) {
            push(sensorIri, SSN.implements, namedNode(iri.entity('procedure', source.procedure.id)));
        }

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

/**
 * Der Quellschlüssel einer Reihe: Connector-Instanz und Reihenschlüssel.
 * Er steht als `dcterms:identifier` an der Reihe und später als
 * `ow:observationSource` an der Variablen — die Erfassung findet darüber
 * zurück zur Quelle, ohne dass irgendwo eine zweite Zuordnungstabelle
 * entsteht.
 */
export function sourceKeyFor(connectorId: string, seriesKey: string): string {
    return `${connectorId}#${seriesKey}`;
}

/** Zerlegt einen Quellschlüssel wieder; `null`, wenn er keiner ist. */
export function parseSourceKey(source: string): { connectorId: string; seriesKey: string } | null {
    const separator = source.indexOf('#');
    if (separator <= 0 || separator === source.length - 1) return null;
    return {
        connectorId: source.slice(0, separator),
        seriesKey: source.slice(separator + 1),
    };
}
