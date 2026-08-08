/**
 * Migration der Instanz-Base (SPEC §3.2): lokale PWA wird auf einen
 * Server gehoben o. ä. Kein Suchen-und-Ersetzen ohne Spur, sondern:
 *
 *  1. Alle IRIs unter der alten Base werden auf die neue umgeschrieben
 *     (Subjekte, Prädikate, Objekte, Graph-Namen, auch in Triple Terms).
 *  2. Für jede umgeschriebene Entitäts-IRI entsteht ein Brückentripel
 *     `neu owl:sameAs alt` im Workspace-Graphen des jeweiligen Nutzers —
 *     externe Referenzen auf die alten IRIs bleiben auswertbar.
 *  3. Die Migration wird als prov:Activity in graph/meta protokolliert.
 */

import type { Quad, Quad_Graph, Quad_Object, Quad_Subject, Term } from '@rdfjs/types';
import type { GraphStore } from '../store/types';
import { factory, namedNode, typedLiteral } from '../rdf';
import { createIriFactory, DEFAULT_USER_ID, isValidInstanceBase, migrateInstanceIri } from '../iri';
import { OWL, PROV, RDF } from '../vocab';

export interface InstanceBaseMigrationReport {
    /** Anzahl umgeschriebener IRI-Vorkommen (alle Positionen). */
    rewrittenIriOccurrences: number;
    /** Anzahl erzeugter owl:sameAs-Brücken (eine je Entität). */
    bridges: number;
    /** Neue Graph-IRIs nach der Migration. */
    graphs: string[];
    activityIri: string;
}

function rewriteTerm(term: Term, oldBase: string, newBase: string, hit: () => void): Term {
    switch (term.termType) {
        case 'NamedNode': {
            const rewritten = migrateInstanceIri(term.value, oldBase, newBase);
            if (rewritten === null) return term;
            hit();
            return namedNode(rewritten);
        }
        case 'Quad': {
            const q = term as Quad;
            return factory.quad(
                rewriteTerm(q.subject, oldBase, newBase, hit) as Quad_Subject,
                rewriteTerm(q.predicate, oldBase, newBase, hit) as Quad['predicate'],
                rewriteTerm(q.object, oldBase, newBase, hit) as Quad_Object,
                q.graph,
            );
        }
        default:
            return term;
    }
}

/** Nutzer-ID aus einer Entitäts-IRI (`<base>u/<userId>/…`), sonst Default. */
function userIdFromEntityIri(iri: string, base: string): string {
    const match = iri.slice(base.length).match(/^u\/([^/]+)\//);
    return match ? decodeURIComponent(match[1]) : DEFAULT_USER_ID;
}

function isGraphIri(iri: string, base: string): boolean {
    return iri.startsWith(`${base}graph/`);
}

export async function migrateInstanceBase(
    store: GraphStore,
    oldBase: string,
    newBase: string,
    opts?: { timestamp?: string },
): Promise<InstanceBaseMigrationReport> {
    if (!isValidInstanceBase(oldBase) || !isValidInstanceBase(newBase)) {
        throw new Error('migrateInstanceBase: alte und neue Instanz-Base müssen gültig sein.');
    }
    if (oldBase === newBase) {
        throw new Error('migrateInstanceBase: alte und neue Base sind identisch.');
    }

    const timestamp = opts?.timestamp ?? new Date().toISOString();
    let occurrences = 0;
    const hit = () => {
        occurrences += 1;
    };
    const movedEntities = new Map<string, string>(); // alt → neu (nur Entitäten, keine Graphen)

    // 1. Vollständigen Bestand lesen und umschreiben.
    const rewrittenByGraph = new Map<string, Quad[]>();
    const oldGraphs: string[] = [];
    for await (const q of store.dump()) {
        const collect = (term: Term) => {
            if (term.termType === 'NamedNode' && term.value.startsWith(oldBase) && !isGraphIri(term.value, oldBase)) {
                movedEntities.set(term.value, migrateInstanceIri(term.value, oldBase, newBase) as string);
            } else if (term.termType === 'Quad') {
                const inner = term as Quad;
                collect(inner.subject);
                collect(inner.object);
            }
        };
        collect(q.subject);
        collect(q.object);

        const graphValue = q.graph.termType === 'NamedNode' ? q.graph.value : '';
        const newGraphValue = migrateInstanceIri(graphValue, oldBase, newBase) ?? graphValue;
        if (newGraphValue !== graphValue) hit();
        const rewritten = factory.quad(
            rewriteTerm(q.subject, oldBase, newBase, hit) as Quad_Subject,
            rewriteTerm(q.predicate, oldBase, newBase, hit) as Quad['predicate'],
            rewriteTerm(q.object, oldBase, newBase, hit) as Quad_Object,
            namedNode(newGraphValue) as Quad_Graph,
        );
        const bucket = rewrittenByGraph.get(newGraphValue) ?? [];
        bucket.push(rewritten);
        rewrittenByGraph.set(newGraphValue, bucket);
        if (graphValue && !oldGraphs.includes(graphValue)) oldGraphs.push(graphValue);
    }

    const newIriFactory = createIriFactory(newBase);
    const activityIri = newIriFactory.entity('activity', `instance-base-migration-${timestamp.replace(/[:.]/g, '-')}`);

    await store.transaction(async tx => {
        // Alte Graphen leeren (Replace mit leerer Menge).
        for (const graph of oldGraphs) {
            await tx.load([], namedNode(graph), { replace: true });
        }
        // Umgeschriebene Quads in die neuen Graphen laden.
        for (const [graph, quads] of rewrittenByGraph) {
            await tx.load(quads, namedNode(graph), { replace: true });
        }
        // 2. Brückentripel je Nutzer-Workspace.
        const bridgesByGraph = new Map<string, Quad[]>();
        for (const [oldIri, newIri] of movedEntities) {
            const userId = userIdFromEntityIri(newIri, newBase);
            const workspace = createIriFactory(newBase, userId).graph('workspace');
            const bucket = bridgesByGraph.get(workspace) ?? [];
            bucket.push(factory.quad(namedNode(newIri), namedNode(OWL.sameAs), namedNode(oldIri)));
            bridgesByGraph.set(workspace, bucket);
        }
        for (const [graph, quads] of bridgesByGraph) {
            await tx.load(quads, namedNode(graph));
        }
        // 3. prov:Activity in graph/meta.
        await tx.load([
            factory.quad(namedNode(activityIri), namedNode(RDF.type), namedNode(PROV.Activity)),
            factory.quad(namedNode(activityIri), namedNode(PROV.generatedAtTime), typedLiteral.dateTime(timestamp)),
        ], namedNode(newIriFactory.sharedGraph('meta')));
    });

    return {
        rewrittenIriOccurrences: occurrences,
        bridges: movedEntities.size,
        graphs: (await store.graphs()).map(g => g.value),
        activityIri,
    };
}
