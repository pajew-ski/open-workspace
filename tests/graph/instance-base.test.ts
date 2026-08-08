// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '../../src/lib/graph/store/oxigraph';
import { migrateInstanceBase } from '../../src/lib/graph/migrate/instance-base';
import { createIriFactory, urnInstanceBase } from '../../src/lib/graph/iri';
import { namedNode, literal, quad } from '../../src/lib/graph/rdf';
import { OWL } from '../../src/lib/graph/vocab';
import type { Quad } from '@rdfjs/types';

const OLD_BASE = urnInstanceBase('00000000-0000-4000-8000-000000000000');
const NEW_BASE = 'https://ws.example.org/id/';
const oldIri = createIriFactory(OLD_BASE);
const newIri = createIriFactory(NEW_BASE);

async function collect(iterable: AsyncIterable<Quad>): Promise<Quad[]> {
    const out: Quad[] = [];
    for await (const q of iterable) out.push(q);
    return out;
}

describe('migrateInstanceBase (SPEC §3.2)', () => {
    it('schreibt IRIs um, brückt per owl:sameAs und protokolliert die Aktivität', async () => {
        const store = new OxigraphStore();
        const docA = oldIri.entity('doc', 'a');
        const docB = oldIri.entity('doc', 'b');
        await store.load([
            quad(namedNode(docA), namedNode('urn:ex:linksTo'), namedNode(docB)),
            quad(namedNode(docA), namedNode('urn:ex:name'), literal('Alpha', 'de')),
            // Fremde IRI bleibt unangetastet:
            quad(namedNode(docA), namedNode('urn:ex:seeAlso'), namedNode('https://schema.org/Thing')),
        ], namedNode(oldIri.graph('workspace')));

        const report = await migrateInstanceBase(store, OLD_BASE, NEW_BASE, {
            timestamp: '2026-08-08T12:00:00.000Z',
        });

        expect(report.bridges).toBe(2);
        expect(report.graphs).toContain(newIri.graph('workspace'));
        expect(report.graphs).not.toContain(oldIri.graph('workspace'));

        const all = await collect(store.dump());
        // Keine alte Base mehr — außer als owl:sameAs-Objekt der Brücken.
        for (const q of all) {
            if (q.subject.value.startsWith(OLD_BASE)) {
                throw new Error(`Altes Subjekt übrig: ${q.subject.value}`);
            }
            if (q.object.termType === 'NamedNode' && q.object.value.startsWith(OLD_BASE)) {
                expect(q.predicate.value).toBe(OWL.sameAs);
            }
            if (q.graph.value.startsWith(OLD_BASE)) {
                throw new Error(`Alter Graph übrig: ${q.graph.value}`);
            }
        }

        // Brücke neu→alt existiert und Kanten sind umgeschrieben.
        const bridge = await store.query(
            `ASK { GRAPH <${newIri.graph('workspace')}> { <${newIri.entity('doc', 'a')}> <${OWL.sameAs}> <${docA}> } }`,
        );
        expect(bridge.type === 'boolean' && bridge.value).toBe(true);
        const edge = await store.query(
            `ASK { GRAPH <${newIri.graph('workspace')}> { <${newIri.entity('doc', 'a')}> <urn:ex:linksTo> <${newIri.entity('doc', 'b')}> } }`,
        );
        expect(edge.type === 'boolean' && edge.value).toBe(true);

        // prov:Activity im Meta-Graphen.
        const activity = await store.query(
            `ASK { GRAPH <${newIri.sharedGraph('meta')}> { <${report.activityIri}> a <http://www.w3.org/ns/prov#Activity> } }`,
        );
        expect(activity.type === 'boolean' && activity.value).toBe(true);
    });

    it('lehnt identische oder ungültige Basen ab', async () => {
        const store = new OxigraphStore();
        await expect(migrateInstanceBase(store, OLD_BASE, OLD_BASE)).rejects.toThrow(/identisch/);
        await expect(migrateInstanceBase(store, 'kaputt', NEW_BASE)).rejects.toThrow(/gültig/);
    });
});
