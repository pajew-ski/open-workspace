/**
 * schema.org-Projektion (SPEC §12.3): die abwärtskompatible
 * `@graph`-Ansicht für `GET /api/graph`, generiert per SPARQL aus dem
 * Store — nicht mehr ad hoc aus den Dateien.
 *
 * Bewusster Breaking Change am internen Contract: Die Präsentations-
 * Properties `color` und `val` sind aus der Antwort entfernt; die
 * Graph-UI berechnet sie clientseitig aus dem Typ (Invariante 2).
 */

import type { Term } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import type { IriFactory } from '../iri';
import { SPARQL_PREFIXES } from '../vocab';

export type LegacyNodeType =
    | 'Project'
    | 'Action'
    | 'TechArticle'
    | 'BlogPosting'
    | 'HowTo'
    | 'CreativeWork'
    | 'DefinedTerm';

export interface LegacyGraphNode {
    '@type': LegacyNodeType;
    '@id': string;
    name?: string;
    headline?: string;
    description?: string;
    identifier?: string;
    actionStatus?: string;
    mentions?: Array<{ '@type': 'TechArticle'; '@id': string }>;
    agent?: { '@id': string };
    dependencies?: Array<{ '@type': 'Action'; '@id': string; relationshipType: string }>;
    about?: Array<{ '@id': string }>;
    keywords?: string[];
}

export interface LegacyGraphView {
    '@context': 'https://schema.org';
    '@graph': LegacyGraphNode[];
}

async function rows(store: GraphStore, sparql: string): Promise<Array<Record<string, Term>>> {
    const result = await store.query(`${SPARQL_PREFIXES}\n${sparql}`);
    if (result.type !== 'bindings') return [];
    const out: Array<Record<string, Term>> = [];
    for await (const row of result.bindings) {
        out.push(row);
    }
    return out;
}

/** Stabile ID aus dem Entitäts-IRI (letztes Pfadsegment nach `<type>/`). */
function stableId(iri: string, type: string): string {
    const marker = `/${type}/`;
    const index = iri.lastIndexOf(marker);
    return index === -1 ? iri : decodeURIComponent(iri.slice(index + marker.length));
}

export async function buildLegacyGraphView(store: GraphStore, iri: IriFactory): Promise<LegacyGraphView> {
    const ws = `<${iri.graph('workspace')}>`;
    const nodes = new Map<string, LegacyGraphNode>();

    // Projekte
    for (const row of await rows(store, `
        SELECT ?s ?name WHERE { GRAPH ${ws} { ?s a ow:Project ; schema:name ?name } }`)) {
        nodes.set(row.s.value, {
            '@type': 'Project',
            '@id': row.s.value,
            name: row.name.value,
            identifier: `proj-${stableId(row.s.value, 'project')}`,
        });
    }

    // Aufgaben (inkl. Projektzuordnung als legacy `agent`)
    for (const row of await rows(store, `
        SELECT ?s ?name ?status ?project WHERE { GRAPH ${ws} {
            ?s a ow:Task ; schema:name ?name ; schema:actionStatus ?status .
            OPTIONAL { ?s ow:inProject ?project }
        } }`)) {
        const node: LegacyGraphNode = {
            '@type': 'Action',
            '@id': row.s.value,
            name: row.name.value,
            identifier: `task-${stableId(row.s.value, 'task')}`,
            actionStatus: row.status.value.split('/').pop(),
        };
        if (row.project) {
            node.agent = { '@id': row.project.value };
        }
        nodes.set(row.s.value, node);
    }

    // Task-Abhängigkeiten (ow:blockedBy → legacy `dependencies`)
    for (const row of await rows(store, `
        SELECT ?s ?dep WHERE { GRAPH ${ws} { ?s a ow:Task ; ow:blockedBy ?dep } }`)) {
        const node = nodes.get(row.s.value);
        if (!node) continue;
        node.dependencies = node.dependencies ?? [];
        node.dependencies.push({ '@type': 'Action', '@id': row.dep.value, relationshipType: 'depends_on' });
    }

    // Dokumente — polymorpher Typ; DefinedTerm-Dokumente erscheinen in der
    // Ansicht als TechArticle, damit `DefinedTerm` den Tags vorbehalten bleibt.
    for (const row of await rows(store, `
        SELECT ?s ?name ?slug
               (EXISTS { GRAPH ${ws} { ?s a schema:BlogPosting } } AS ?isBlog)
               (EXISTS { GRAPH ${ws} { ?s a schema:HowTo } } AS ?isHowTo)
        WHERE { GRAPH ${ws} { ?s a ow:Document ; schema:name ?name ; dcterms:identifier ?slug } }`)) {
        const type: LegacyNodeType =
            row.isBlog?.value === 'true' ? 'BlogPosting' :
            row.isHowTo?.value === 'true' ? 'HowTo' : 'TechArticle';
        nodes.set(row.s.value, {
            '@type': type,
            '@id': row.s.value,
            headline: row.name.value,
            identifier: `doc-${stableId(row.s.value, 'doc')}`,
        });
    }

    // Wikilinks zwischen Dokumenten → legacy `mentions`. Nur aufgelöste
    // Ziele (beide Enden sind ow:Document) — nicht auflösbare Behauptungen
    // bleiben im Graphen, aber nicht in dieser Ansicht.
    for (const row of await rows(store, `
        SELECT ?s ?t WHERE { GRAPH ${ws} { ?s a ow:Document ; ow:linksTo ?t . ?t a ow:Document } }`)) {
        const node = nodes.get(row.s.value);
        if (!node) continue;
        node.mentions = node.mentions ?? [];
        node.mentions.push({ '@type': 'TechArticle', '@id': row.t.value });
    }

    // Tags (skos:Concept → legacy DefinedTerm) und Dokument-Verschlagwortung
    for (const row of await rows(store, `
        SELECT ?tag ?label WHERE { GRAPH ${ws} { ?tag a skos:Concept ; skos:prefLabel ?label } }`)) {
        nodes.set(row.tag.value, {
            '@type': 'DefinedTerm',
            '@id': row.tag.value,
            name: `#${row.label.value}`,
            identifier: `tag-${row.label.value}`,
        });
    }
    for (const row of await rows(store, `
        SELECT ?s ?tag ?label WHERE { GRAPH ${ws} {
            ?s a ow:Document ; schema:about ?tag . ?tag skos:prefLabel ?label
        } }`)) {
        const node = nodes.get(row.s.value);
        if (!node) continue;
        node.about = node.about ?? [];
        node.about.push({ '@id': row.tag.value });
        node.keywords = node.keywords ?? [];
        node.keywords.push(row.label.value);
    }

    // Canvases
    for (const row of await rows(store, `
        SELECT ?s ?name ?description WHERE { GRAPH ${ws} {
            ?s a ow:Canvas ; schema:name ?name . OPTIONAL { ?s schema:description ?description }
        } }`)) {
        nodes.set(row.s.value, {
            '@type': 'CreativeWork',
            '@id': row.s.value,
            name: row.name.value,
            description: row.description?.value,
            identifier: `canvas-${stableId(row.s.value, 'canvas')}`,
        });
    }

    // Deterministische Reihenfolge: Typgruppe wie die Altfassung
    // (Projekte, Aufgaben, Dokumente/Tags, Canvases), innerhalb per IRI.
    const order: Record<LegacyNodeType, number> = {
        Project: 0, Action: 1, TechArticle: 2, BlogPosting: 2, HowTo: 2, DefinedTerm: 3, CreativeWork: 4,
    };
    const graph = [...nodes.values()].sort((a, b) => {
        const byType = order[a['@type']] - order[b['@type']];
        return byType !== 0 ? byType : a['@id'] < b['@id'] ? -1 : 1;
    });

    return { '@context': 'https://schema.org', '@graph': graph };
}
