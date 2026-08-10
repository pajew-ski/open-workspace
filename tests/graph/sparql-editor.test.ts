// @vitest-environment node
/**
 * Abnahme M2-Rest (SPARQL-Editor, SPEC §7.1):
 *  - Query-Klassifikation (Weichenstellung Tabelle/Graph/Update) über
 *    Prolog und Kommentare hinweg.
 *  - Ergebnis-als-Graph-Auflösung eines Query-Texts ohne gespeicherte
 *    View (Editor-Vorschau) mit demselben erlaubten Dataset wie Views.
 *  - Gespeicherte Queries (ow:QueryView) tragen auch SELECT/ASK — die
 *    Entität ist dieselbe wie bei Graph-Views (M5), unterschieden am
 *    Query-Text.
 */
import { describe, it, expect } from 'vitest';
import { classifySparql, isGraphQuery, isReadQuery } from '../../src/lib/graph/sparql/classify';
import { createQueryView, listQueryViews, resolveQueryTextAsGraph } from '../../src/lib/graph/views/registry';
import { buildWorkspaceQuads } from '../../src/lib/graph/migrate/from-files';
import { createIriFactory, urnInstanceBase } from '../../src/lib/graph/iri';
import { OxigraphStore } from '../../src/lib/graph/store/oxigraph';
import { namedNode } from '../../src/lib/graph/rdf';
import { OW_VOCAB_BASE } from '../../src/lib/graph/vocab';

const iri = createIriFactory(urnInstanceBase('00000000-0000-4000-8000-0000000000ff'));

describe('SPARQL-Klassifikation (Editor-Weichenstellung)', () => {
    it('erkennt die Operationsform hinter Prolog und Kommentaren', () => {
        expect(classifySparql('SELECT * WHERE { ?s ?p ?o }')).toBe('select');
        expect(classifySparql('# Kommentar\nPREFIX ow: <x:#>\nASK { ?s ?p ?o }')).toBe('ask');
        expect(classifySparql('PREFIX a: <urn:a#>\nPREFIX b: <urn:b#>\nCONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }')).toBe('construct');
        expect(classifySparql('BASE <urn:base>\nDESCRIBE <urn:x>')).toBe('describe');
        expect(classifySparql('INSERT DATA { GRAPH <urn:g> { <urn:s> <urn:p> 1 } }')).toBe('update');
        expect(classifySparql('DELETE WHERE { ?s ?p ?o }')).toBe('update');
        expect(classifySparql('')).toBe('unknown');
    });

    it('trennt Graph-Views von Editor-Queries und sperrt Updates fürs Speichern', () => {
        expect(isGraphQuery('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }')).toBe(true);
        expect(isGraphQuery('SELECT * WHERE { ?s ?p ?o }')).toBe(false);
        expect(isReadQuery('SELECT * WHERE { ?s ?p ?o }')).toBe(true);
        expect(isReadQuery('DROP GRAPH <urn:g>')).toBe(false);
    });
});

describe('Editor-Vorschau: Query-Text als Graph (SPEC §7.1)', () => {
    async function seededHandle() {
        const store = new OxigraphStore();
        const { quads } = buildWorkspaceQuads({
            docs: [
                {
                    id: 'doc-1', slug: 'a', title: 'A', content: 'Siehe [[B]].', tags: [],
                    inLanguage: 'de', createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z',
                },
                {
                    id: 'b', slug: 'b', title: 'B', content: '', tags: [],
                    inLanguage: 'de', createdAt: '2026-01-02T10:00:00.000Z', updatedAt: '2026-01-02T10:00:00.000Z',
                },
            ],
            tasks: [], projects: [], canvases: [],
            calendars: [], events: [], conversations: [],
        }, iri);
        await store.load(quads, namedNode(iri.graph('workspace')));
        return { store, iri };
    }

    it('löst CONSTRUCT als Knoten/Kanten-Struktur auf', async () => {
        const handle = await seededHandle();
        const resolved = await resolveQueryTextAsGraph(handle, `
            PREFIX ow: <${OW_VOCAB_BASE}>
            CONSTRUCT { ?a ?p ?b } WHERE { ?a ?p ?b . FILTER(?p = ow:linksTo) }
        `);
        expect(resolved.nodes.length).toBe(2);
        expect(resolved.links).toHaveLength(1);
        expect(resolved.links[0].type).toBe('linksTo');
        expect(resolved.truncated).toBe(false);
    });

    it('lehnt SELECT als Graph-Ansicht mit klarer Meldung ab', async () => {
        const handle = await seededHandle();
        await expect(resolveQueryTextAsGraph(handle, 'SELECT * WHERE { ?s ?p ?o }'))
            .rejects.toThrow(/CONSTRUCT oder DESCRIBE/);
    });

    it('speichert SELECT-Queries als ow:QueryView neben Graph-Views (eine Entität)', async () => {
        const handle = await seededHandle();
        await createQueryView(handle, {
            id: 'editor-query',
            name: 'Offene Fragen',
            queryText: 'SELECT ?s WHERE { ?s ?p ?o }',
            layoutMethod: 'force-directed',
        });
        await createQueryView(handle, {
            id: 'graph-view',
            name: 'Netz',
            queryText: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
            layoutMethod: 'radial',
        });
        const views = await listQueryViews(handle);
        expect(views.map(v => v.id).sort()).toEqual(['editor-query', 'graph-view']);
        expect(isGraphQuery(views.find(v => v.id === 'editor-query')!.queryText)).toBe(false);
        expect(isGraphQuery(views.find(v => v.id === 'graph-view')!.queryText)).toBe(true);
    });
});
