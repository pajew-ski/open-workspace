/**
 * Lesemodell des Selbstmodells (SPEC §18, M14) — per SPARQL aus
 * `graph/meta`, nicht aus dem Code, aus dem es erzeugt wurde.
 *
 * Das ist der Punkt des Abschnitts: Der Assistent (und jeder andere
 * Leser, auch ein externer Agent über den MCP-Server) beantwortet „was
 * kann dieses System" durch eine Abfrage auf dem Graphen. Ein Modul, das
 * sich im Selbstmodell registriert, ist damit automatisch bekannt — es
 * gibt keine zweite, gepflegte Liste mehr.
 *
 * Das Dataset kommt wie überall vom Resolver (§17.3): Wer `graph/meta`
 * nicht lesen darf, sieht ein leeres Selbstmodell statt einer Umgehung.
 */

import type { NamedNode, Term } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { SPARQL_PREFIXES } from '../vocab';
import { resolveDataset, type DatasetAuthz } from '../sparql/protocol';
import type { SelfModelApp, SelfModelModule, SelfModelView } from './self-model-view';

export type { SelfModelApp, SelfModelModule, SelfModelView } from './self-model-view';

interface Dataset {
    defaultGraphs: NamedNode[];
    namedGraphs: NamedNode[];
}

async function rows(
    store: GraphStore,
    dataset: Dataset,
    sparql: string,
): Promise<Array<Record<string, Term>>> {
    const result = await store.query(`${SPARQL_PREFIXES}\n${sparql}`, {
        defaultGraphs: dataset.defaultGraphs,
        namedGraphs: dataset.namedGraphs,
    });
    if (result.type !== 'bindings') return [];
    const out: Array<Record<string, Term>> = [];
    for await (const row of result.bindings) out.push(row);
    return out;
}

/** Selbstmodell dieser Installation, so weit der Aufrufer es sehen darf. */
export async function readSelfModel(
    store: GraphStore,
    iri: IriFactory,
    authz: DatasetAuthz = {},
): Promise<SelfModelView> {
    const dataset = await resolveDataset(store, iri, undefined, authz);
    const meta = `<${iri.sharedGraph('meta')}>`;

    const appRows = await rows(store, dataset, `
        SELECT ?app ?name ?description ?version ?schemaVersion ?runtime WHERE { GRAPH ${meta} {
            ?app a schema:SoftwareApplication ; ow:runtime ?runtime ; schema:name ?name .
            OPTIONAL { ?app schema:description ?description }
            OPTIONAL { ?app schema:softwareVersion ?version }
            OPTIONAL { ?app schema:schemaVersion ?schemaVersion }
        } } ORDER BY ?app LIMIT 1`);

    let app: SelfModelApp | null = null;
    if (appRows.length > 0) {
        const row = appRows[0];
        const values = async (predicate: string): Promise<string[]> => {
            const found = await rows(store, dataset, `
                SELECT ?value WHERE { GRAPH ${meta} { <${row.app.value}> ${predicate} ?value } } ORDER BY ?value`);
            return found.map(entry => entry.value.value);
        };
        app = {
            iri: row.app.value,
            name: row.name.value,
            description: row.description?.value ?? '',
            version: row.version?.value ?? '',
            schemaVersion: row.schemaVersion?.value ?? '',
            runtime: row.runtime.value,
            capabilities: await values('ow:capability'),
            connectorKinds: await values('ow:availableConnectorKind'),
        };
    }

    const moduleRows = await rows(store, dataset, `
        SELECT ?module ?id ?label ?description ?route ?partOf WHERE { GRAPH ${meta} {
            ?module a ow:Module ; dcterms:identifier ?id ; schema:name ?label ; ow:route ?route .
            OPTIONAL { ?module schema:description ?description }
            OPTIONAL { ?module schema:isPartOf ?partOf }
        } } ORDER BY ?route`);

    const modules: SelfModelModule[] = [];
    for (const row of moduleRows) {
        const types = await rows(store, dataset, `
            SELECT ?type WHERE { GRAPH ${meta} { <${row.module.value}> ow:entityType ?type } } ORDER BY ?type`);
        modules.push({
            iri: row.module.value,
            id: row.id.value,
            label: row.label.value,
            description: row.description?.value ?? '',
            route: row.route.value,
            entityTypes: types.map(entry => entry.type.value),
            partOf: row.partOf?.value ?? null,
        });
    }
    return { app, modules };
}
