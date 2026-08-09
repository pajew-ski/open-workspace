// @vitest-environment node
/**
 * M8-Abnahme Suche (GRAPH_CORE_SPEC §7.7):
 *
 *  1. Volltext: invertierter Index über ALLE Literale, deterministisch
 *     (gleiche Quads in beliebiger Reihenfolge ⇒ identische Treffer),
 *     nach Graphen filterbar (§17.4), Label-Treffer gewichtet.
 *  2. Fuzzy-Verhalten des Global Finders bleibt erhalten (Tippfehler über
 *     Levenshtein, Präfix-Ranking) — jetzt aus dem Graphen gespeist.
 *  3. Vektorindex: separat vom Triplestore, jeder Vektor trägt die
 *     Subjekt-IRI; ohne Provider existiert er nicht (keine Attrappe).
 *  4. `workspace_finder`-Kern: Dokumente/Aufgaben/Projekte kommen aus dem
 *     Index, Verhalten (matchScore, @projekt-Sonderfall) unverändert.
 */

import { describe, expect, it } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { factory, literal, namedNode, typedLiteral } from '@/lib/graph/rdf';
import { createIriFactory } from '@/lib/graph/iri';
import { DCTERMS, OW, RDF, SCHEMA, SKOS } from '@/lib/graph/vocab';
import { FulltextIndex, levenshtein, tokenize } from '@/lib/graph/search/fulltext';
import { buildVectorIndex, cosineSimilarity, embeddingTextForNode, VectorIndex, type EmbeddingProvider } from '@/lib/graph/search/vector';
import { parseEntityIri, searchWorkspaceGraph } from '@/lib/graph/search/finder';
import { buildWorkspaceQuads, type WorkspaceSnapshotInput } from '@/lib/graph/migrate/from-files';
import type { Task } from '@/lib/storage/tasks';
import type { Project } from '@/lib/storage/projects';
import type { Doc } from '@/types/doc';

const INSTANCE_BASE = 'urn:ow:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee:';
const iri = createIriFactory(INSTANCE_BASE);
const workspaceGraph = namedNode(iri.graph('workspace'));

const nn = namedNode;

function q(s: string, p: string, o: Parameters<typeof factory.quad>[2], graph = workspaceGraph): Quad {
    return factory.quad(nn(s), nn(p), o, graph);
}

describe('Tokenisierung und Levenshtein', () => {
    it('behält Umlaute und ß, normalisiert und filtert Kurz-Tokens', () => {
        expect(tokenize('Größere Änderung: RDF-1.2 läuft!')).toEqual(['größere', 'änderung', 'rdf', 'läuft']);
    });

    it('levenshtein mit frühem Abbruch', () => {
        expect(levenshtein('migration', 'migratoin', 2)).toBe(2);
        expect(levenshtein('haus', 'maus', 1)).toBe(1);
        expect(levenshtein('kurz', 'komplett-anders', 2)).toBe(3); // max+1 = Abbruch
    });
});

describe('Volltext-Index (§7.7)', () => {
    const docA = `${INSTANCE_BASE}u/default/doc/architektur`;
    const docB = `${INSTANCE_BASE}u/default/doc/notizen`;
    const tag = `${INSTANCE_BASE}u/default/tag/graphen`;
    const otherGraph = namedNode(iri.graph('public'));

    const quads: Quad[] = [
        q(docA, SCHEMA.name, literal('Architektur des Graphen')),
        q(docA, SCHEMA.text, literal('Der Store ist die Wahrheit. Oxigraph speichert Quads.')),
        q(docB, SCHEMA.name, literal('Notizen')),
        q(docB, SCHEMA.text, literal('Beim Thema Architektur hilft ein Blick in die Spec.')),
        q(tag, SKOS.prefLabel, literal('graphen')),
        factory.quad(nn(docB), nn(SCHEMA.description), literal('Öffentliche Beschreibung'), otherGraph),
    ];

    it('indexiert alle Literale und gewichtet Label-Treffer höher', () => {
        const index = FulltextIndex.fromQuads(quads);
        expect(index.size).toBe(6);
        const hits = index.search('Architektur');
        expect(hits.map(h => h.iri)).toEqual([docA, docB]);
        expect(hits[0].labelMatch).toBe('prefix');
        expect(hits[1].labelMatch).toBe('none');
        expect(hits[0].matches[0].snippet).toContain('Architektur');
    });

    it('ist deterministisch: umgekehrte Quad-Reihenfolge ⇒ identisches Ergebnis', () => {
        const forward = FulltextIndex.fromQuads(quads);
        const backward = FulltextIndex.fromQuads([...quads].reverse());
        expect(JSON.stringify(forward.search('graphen store'))).toBe(JSON.stringify(backward.search('graphen store')));
    });

    it('filtert nach Graphen (§17.4: kein Treffer außerhalb des Datasets)', () => {
        const index = FulltextIndex.fromQuads(quads);
        const restricted = index.search('Beschreibung', { graphs: [workspaceGraph.value] });
        expect(restricted).toHaveLength(0);
        const open = index.search('Beschreibung', { graphs: [otherGraph.value] });
        expect(open.map(h => h.iri)).toEqual([docB]);
    });

    it('toleriert Tippfehler (Fuzzy) und Präfixe wie der bisherige Finder', () => {
        const index = FulltextIndex.fromQuads(quads);
        expect(index.search('Architektru').map(h => h.iri)).toContain(docA); // Buchstabendreher
        expect(index.search('Archi').map(h => h.iri)).toContain(docA);       // Präfix
    });

    it('Mehr-Wort-Query: alle Tokens müssen am Subjekt treffen', () => {
        const index = FulltextIndex.fromQuads(quads);
        expect(index.search('Architektur Oxigraph').map(h => h.iri)).toEqual([docA]);
    });
});

describe('Vektorindex (§7.7, optional)', () => {
    it('cosineSimilarity: identisch = 1, orthogonal = 0', () => {
        expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
        expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
        expect(cosineSimilarity([], [])).toBe(0);
    });

    it('Suche liefert deterministische Reihenfolge, filterbar nach Graph', () => {
        const index = new VectorIndex();
        index.add('urn:n:1', 'urn:g:a', [1, 0]);
        index.add('urn:n:2', 'urn:g:b', [0.9, 0.1]);
        index.add('urn:n:3', 'urn:g:a', [0, 1]);
        index.finalize();
        const hits = index.search([1, 0], { limit: 3 });
        expect(hits.map(h => h.iri)).toEqual(['urn:n:1', 'urn:n:2', 'urn:n:3']);
        const filtered = index.search([1, 0], { graphs: ['urn:g:a'] });
        expect(filtered.map(h => h.iri)).toEqual(['urn:n:1', 'urn:n:3']);
    });

    it('buildVectorIndex: jeder Vektor trägt die Subjekt-IRI; Cache verhindert Doppel-Embedding', async () => {
        const calls: string[][] = [];
        const provider: EmbeddingProvider = {
            id: 'test',
            model: 'fake-1',
            async embed(texts) {
                calls.push(texts);
                return texts.map(text => [text.length, 1]);
            },
        };
        const cache = new Map<string, number[]>();
        const nodes = [
            { iri: 'urn:n:1', graph: 'urn:g', text: 'kurz' },
            { iri: 'urn:n:2', graph: 'urn:g', text: 'ein längerer text' },
        ];
        const first = await buildVectorIndex(nodes, provider, cache);
        expect(first.size).toBe(2);
        expect(calls.flat()).toHaveLength(2);
        const second = await buildVectorIndex(nodes, provider, cache);
        expect(second.size).toBe(2);
        expect(calls.flat()).toHaveLength(2); // Cache: kein weiterer Aufruf
    });

    it('embeddingTextForNode dedupliziert und kappt', () => {
        const text = embeddingTextForNode({ label: 'Titel', texts: ['Titel', 'Inhalt', 'x'.repeat(3000)] });
        expect(text.startsWith('Titel\nInhalt')).toBe(true);
        expect(text.length).toBeLessThanOrEqual(2000);
    });
});

describe('workspace_finder-Kern auf dem Graphen (§7.7: umgestellt, nicht ersetzt)', () => {
    const now = '2026-08-01T10:00:00.000Z';
    const doc = (id: string, title: string, content: string, tags: string[] = []): Doc => ({
        id, slug: id, title, content, tags, createdAt: now, updatedAt: now,
    });
    const task = (id: string, title: string, projectId?: string): Task => ({
        id, title, status: 'todo', priority: 'medium', type: 'task',
        dependencies: [], tags: [], createdAt: now, updatedAt: now,
        ...(projectId ? { projectId } : {}),
    });
    const project = (id: string, title: string): Project => ({
        id, title, prefix: 'T', status: 'active', color: '#00674F', createdAt: now, updatedAt: now,
    });

    const workspace: WorkspaceSnapshotInput = {
        docs: [
            doc('doc-migration', 'Migration des Graphen', 'Inhalt über Oxigraph und Serialisierung.'),
            doc('doc-rezepte', 'Rezepte', 'Der Begriff Migration taucht nur im Fließtext auf.'),
        ],
        tasks: [
            task('task-1', 'Migration vorbereiten', 'proj-1'),
            task('task-2', 'Freie Aufgabe ohne Projekt'),
        ],
        projects: [project('proj-1', 'Graph Core')],
        canvases: [],
    };
    const { quads } = buildWorkspaceQuads(workspace, iri);
    const index = FulltextIndex.fromQuads(quads);

    it('parseEntityIri kehrt IriFactory.entity um', () => {
        expect(parseEntityIri(iri, iri.entity('doc', 'doc-migration'))).toEqual({ kind: 'doc', id: 'doc-migration' });
        expect(parseEntityIri(iri, iri.entity('tag', 'x'))).toBeNull();
    });

    it('Titel-Präfix schlägt Titel-Treffer schlägt Inhalts-Treffer (matchScore 3/2/1)', () => {
        const hits = searchWorkspaceGraph(index, iri, workspace, 'Migration');
        const byId = new Map(hits.map(h => [h.id, h]));
        expect(byId.get('doc-migration')?.matchScore).toBe(3);
        expect(byId.get('task-1')?.matchScore).toBe(3);
        expect(byId.get('doc-rezepte')?.matchScore).toBe(1);
        expect(hits[0].matchScore).toBeGreaterThanOrEqual(hits[hits.length - 1].matchScore);
    });

    it('findet Tippfehler-Queries über den Index (Fuzzy bleibt erhalten)', () => {
        const hits = searchWorkspaceGraph(index, iri, workspace, 'Migratoin');
        expect(hits.map(h => h.id)).toContain('doc-migration');
    });

    it('Typ-Filter doc liefert keine Aufgaben; Subtitle trägt Projekt-Titel', () => {
        const docsOnly = searchWorkspaceGraph(index, iri, workspace, 'Migration', 'doc');
        expect(docsOnly.every(h => h.type === 'doc')).toBe(true);
        const tasks = searchWorkspaceGraph(index, iri, workspace, 'Migration', 'task');
        expect(tasks[0].subtitle).toContain('Graph Core');
    });

    it('@projekt findet auch Aufgaben ohne Projektzuordnung (AGENTS.md)', () => {
        const hits = searchWorkspaceGraph(index, iri, workspace, 'Freie Aufgabe', 'project');
        expect(hits.map(h => h.id)).toContain('task-2');
        expect(hits.find(h => h.id === 'task-2')?.subtitle).toBe('Aufgabe (Kein Projekt)');
    });

    it('Tag-Konzepte sind im Volltext-Index sichtbar (skos:prefLabel ist ein Literal)', () => {
        // Der Finder führt nur doc/task/project als Ergebnis-Typen; das
        // Tag-KONZEPT selbst ist über /api/graph/search und als
        // Retrieval-Seed erreichbar — von dort führt die Expansion zu den
        // Dokumenten (tests/graph/retrieval.test.ts).
        const tagged: WorkspaceSnapshotInput = {
            ...workspace,
            docs: [doc('doc-tagged', 'Unauffälliger Titel', 'Unauffälliger Inhalt.', ['ontologie/skos'])],
        };
        const taggedIndex = FulltextIndex.fromQuads(buildWorkspaceQuads(tagged, iri).quads);
        const conceptHits = taggedIndex.search('skos');
        expect(conceptHits.map(h => h.iri)).toContain(iri.entity('tag', 'ontologie/skos'));
        expect(searchWorkspaceGraph(taggedIndex, iri, tagged, 'skos', 'doc')).toHaveLength(0);
    });
});

describe('ow:weight-Vorbereitung (Kantengewicht als Literal)', () => {
    it('OW.weight ist Teil des Vokabulars und als Reifier-Annotation modellierbar', () => {
        const s = nn('urn:a');
        const p = nn(OW.linksTo);
        const o = nn('urn:b');
        const reifier = nn('urn:r');
        const edge = factory.quad(s, p, o, workspaceGraph);
        const reify = factory.quad(reifier, nn(RDF.reifies), factory.quad(s, p, o), workspaceGraph);
        const weight = factory.quad(reifier, nn(OW.weight), typedLiteral.decimal(2), workspaceGraph);
        expect([edge, reify, weight].every(x => x.termType === 'Quad')).toBe(true);
        expect(OW.weight.endsWith('#weight')).toBe(true);
        expect(DCTERMS.created).toBeDefined();
    });
});
