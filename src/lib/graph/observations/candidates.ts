/**
 * Kandidaten für die Erfassung: Messquellen, die im Graphen stehen, aber
 * noch keine Beobachtungsgröße tragen.
 *
 * Die Liste kommt aus dem Graphen und nicht aus einem zweiten Abruf bei
 * Home Assistant — der `home-assistant`-Connector hat die Struktur bereits
 * materialisiert, und ein zweiter Weg zu denselben Daten wäre eine zweite
 * Wahrheit. Damit ist die Auswahl auch dann bedienbar, wenn Home Assistant
 * gerade nicht erreichbar ist.
 *
 * Die Reihenfolge ist Absicht: Aktoren zuerst. Sie tragen in einem
 * Kausalmodell die Treatment-Seite — und sie sind genau das, was Home
 * Assistant nach `purge_keep_days` restlos verwirft, während numerische
 * Sensoren in den Long-Term-Statistics überleben. Wer nur die Sensoren
 * erfasst, hat später Outcomes ohne Ursachen.
 */

import { describeGraph } from '../iri';
import { namedNode } from '../rdf';
import { resolveDataset } from '../sparql/protocol';
import { SPARQL_PREFIXES } from '../vocab';
import { listConnectors } from '../connectors/registry';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import type { ObservationKind } from './types';

export interface CaptureCandidate {
    /** IRI des sosa:Sensor/Actuator-Knotens. */
    iri: string;
    /** Quellschlüssel (HA entity_id bzw. `<quelle>#<reihe>`). */
    source: string;
    name: string;
    /** HA-Domain (sensor, switch, light, …) bzw. `open-data`. */
    domain: string;
    kind: ObservationKind;
    unit?: string;
    placeIri?: string;
    placeName?: string;
    /** true, wenn es geschaltet werden kann — Treatment-Kandidat. */
    actuator: boolean;
    /**
     * Art der Quelle, aus dem Import-Graphen abgeleitet (C5): Der Sensor
     * liegt im Graphen genau des Connectors, der ihn materialisiert hat.
     * Eine zweite Angabe am Knoten wäre eine zweite Wahrheit — und sie
     * wäre irgendwann falsch.
     */
    sourceKind: string;
    /** Instanz-ID des Connectors, aus dem der Knoten stammt. */
    connectorId?: string;
    /** Ein Satz zur Rolle im Kausalmodell, falls die Quelle ihn mitgibt. */
    note?: string;
    /** ID der bereits erfassenden Variablen, falls vorhanden. */
    variableId?: string;
}

const CANDIDATE_QUERY = `${SPARQL_PREFIXES}
SELECT ?node ?source ?name ?domain ?kind ?unit ?place ?placeName ?actuator ?note ?g WHERE {
  GRAPH ?g {
    { ?node a sosa:Sensor . BIND(false AS ?actuator) }
    UNION
    { ?node a sosa:Actuator . BIND(true AS ?actuator) }
    ?node dcterms:identifier ?source ;
          schema:name ?name ;
          schema:category ?domain ;
          ow:observationKind ?kind .
    OPTIONAL { ?node schema:unitText ?unit }
    OPTIONAL { ?node schema:description ?note }
    OPTIONAL { ?node schema:location ?place }
  }
  OPTIONAL { GRAPH ?gp { ?place schema:name ?placeName } }
}`;

const KINDS: ReadonlySet<string> = new Set(['numeric', 'binary', 'categorical']);

/** `graph/u/<u>/import/<id>` → `<id>`; alles andere ist kein Import-Graph. */
function connectorIdOf(iri: IriFactory, graph: string | undefined): string | null {
    if (!graph) return null;
    const descriptor = describeGraph(iri.instanceBase, graph);
    if (!descriptor || descriptor.kind !== 'user' || !descriptor.scope.startsWith('import/')) return null;
    const id = descriptor.scope.slice('import/'.length);
    return id === '' ? null : id;
}

/**
 * Liest die Messquellen des erlaubten Datasets. `variableId` wird vom
 * Aufrufer nachgetragen, damit diese Funktion keine zweite Meta-Abfrage
 * braucht.
 */
export async function listCaptureCandidates(
    store: GraphStore,
    iri: IriFactory,
    options: { allowedGraphs?: ReadonlyArray<string> } = {},
): Promise<CaptureCandidate[]> {
    const dataset = await resolveDataset(store, iri, undefined, {
        ...(options.allowedGraphs ? { allowedGraphs: [...options.allowedGraphs] } : {}),
    });
    const result = await store.query(CANDIDATE_QUERY, {
        defaultGraphs: dataset.defaultGraphs,
        namedGraphs: dataset.namedGraphs,
        timeoutMs: 15_000,
        readOnly: true,
    });
    if (result.type !== 'bindings') return [];

    // Graph → Connector → Quellart. Der Import-Graph eines Connectors
    // heißt nach seiner Instanz (`graph/u/<u>/import/<id>`), und die
    // Registry weiß, welcher Art diese Instanz ist.
    const kindByConnector = new Map<string, string>();
    for (const connector of await listConnectors({ store, iri })) {
        kindByConnector.set(connector.id, connector.kind);
    }

    const candidates: CaptureCandidate[] = [];
    for await (const row of result.bindings) {
        const node = row.node?.value;
        const source = row.source?.value;
        if (!node || !source) continue;
        const kindRaw = row.kind?.value ?? 'numeric';
        const connectorId = connectorIdOf(iri, row.g?.value);
        const sourceKind = connectorId ? kindByConnector.get(connectorId) : undefined;
        candidates.push({
            iri: node,
            source,
            name: row.name?.value ?? source,
            domain: row.domain?.value ?? source.split('.')[0],
            kind: (KINDS.has(kindRaw) ? kindRaw : 'numeric') as ObservationKind,
            ...(row.unit?.value ? { unit: row.unit.value } : {}),
            ...(row.place?.value ? { placeIri: row.place.value } : {}),
            ...(row.placeName?.value ? { placeName: row.placeName.value } : {}),
            actuator: row.actuator?.value === 'true',
            // Ohne auflösbaren Connector bleibt die Art unbekannt statt
            // geraten — die Erfassung sagt dann ehrlich, dass sie diese
            // Quelle nicht bedienen kann.
            sourceKind: sourceKind ?? 'unbekannt',
            ...(connectorId ? { connectorId } : {}),
            ...(row.note?.value ? { note: row.note.value } : {}),
        });
    }

    // Aktoren zuerst, dann alphabetisch — siehe Kopfkommentar.
    return candidates.sort((a, b) => {
        if (a.actuator !== b.actuator) return a.actuator ? -1 : 1;
        return a.name.localeCompare(b.name, 'de');
    });
}

/** Prüft, ob eine Quelle im Graphen bekannt ist (vor dem Anlegen). */
export async function findCandidate(
    store: GraphStore,
    iri: IriFactory,
    source: string,
    options: { allowedGraphs?: ReadonlyArray<string> } = {},
): Promise<CaptureCandidate | null> {
    const candidates = await listCaptureCandidates(store, iri, options);
    return candidates.find(candidate => candidate.source === source) ?? null;
}

/** Erzwingt, dass ein IRI-String im Dataset dieser Installation liegt. */
export function isInstanceIri(iri: IriFactory, value: string): boolean {
    return value.startsWith(iri.instanceBase) && namedNode(value).value === value;
}
