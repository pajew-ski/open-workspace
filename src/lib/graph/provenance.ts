/**
 * Herkunft der Aussagen eines Nutzers (GRAPH_CORE_SPEC §11/§18, M14).
 *
 * Drei Herkünfte, drei Graphen — das ist keine Anzeige-Konvention,
 * sondern die Datenhaltung: Was der Nutzer selbst behauptet, steht in
 * seinen eigenen Graphen; was eine Quelle behauptet, im Import-Graphen
 * ihres Connectors (§6.2); was der Reasoner schließt, in
 * `inferred/<scope>` und nirgendwo sonst (§7.3, Invariante 3). Diese
 * Zählung macht den Unterschied sichtbar, ohne ihn zu erfinden.
 *
 * Präsentation (Layout) zählt nicht mit: Sie ist kein Wissen
 * (Invariante 2).
 */

import type { Term } from '@rdfjs/types';
import { describeGraph, type IriFactory } from './iri';
import type { GraphStore } from './store/types';
import { SPARQL_PREFIXES } from './vocab';
import { resolveDataset, type DatasetAuthz } from './sparql/protocol';

export interface ProvenanceBucket {
    /** Named Graph, dessen Aussagen gezählt wurden. */
    graph: string;
    /** Lesbarer Name (`workspace`, `import/prima-materia`, …). */
    scope: string;
    statements: number;
}

export interface ProvenanceSummary {
    native: ProvenanceBucket[];
    imported: ProvenanceBucket[];
    inferred: ProvenanceBucket[];
}

/** Zählt die Aussagen der Nutzergraphen je Herkunft. */
export async function provenanceSummary(
    handle: { store: GraphStore; iri: IriFactory },
    authz: DatasetAuthz = {},
): Promise<ProvenanceSummary> {
    const mine = new Map<string, string>();
    for (const node of await handle.store.graphs()) {
        const graph = node.value;
        const described = describeGraph(handle.iri.instanceBase, graph);
        if (!described || described.kind !== 'user' || described.userId !== handle.iri.userId) continue;
        if (described.scope === 'presentation') continue;
        mine.set(graph, described.scope);
    }
    const summary: ProvenanceSummary = { native: [], imported: [], inferred: [] };
    if (mine.size === 0) return summary;

    // Auch diese Zählung holt ihr Dataset beim Resolver (§17.3): Ein
    // Graph, den der Anfragende nicht lesen darf, wird nicht gezählt —
    // sonst verriete die bloße Zahl seine Existenz.
    const dataset = await resolveDataset(handle.store, handle.iri, { namedGraphUris: [...mine.keys()] }, authz);
    const result = await handle.store.query(`${SPARQL_PREFIXES}
        SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g ORDER BY ?g`, {
        defaultGraphs: dataset.defaultGraphs,
        namedGraphs: dataset.namedGraphs,
    });
    if (result.type !== 'bindings') return summary;
    for await (const row of result.bindings as AsyncIterable<Record<string, Term>>) {
        const graph = row.g.value;
        const scope = mine.get(graph);
        if (!scope) continue;
        const bucket: ProvenanceBucket = { graph, scope, statements: Number(row.n.value) };
        if (scope.startsWith('import/')) summary.imported.push(bucket);
        else if (scope.startsWith('inferred/')) summary.inferred.push(bucket);
        else summary.native.push(bucket);
    }
    return summary;
}
