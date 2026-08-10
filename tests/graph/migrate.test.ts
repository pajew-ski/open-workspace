// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildWorkspaceQuads, slugifyTitle } from '../../src/lib/graph/migrate/from-files';
import type { WorkspaceSnapshotInput } from '../../src/lib/graph/migrate/from-files';
import { generateSlug } from '../../src/lib/storage/docs';
import { createIriFactory, urnInstanceBase } from '../../src/lib/graph/iri';
import { OxigraphStore } from '../../src/lib/graph/store/oxigraph';
import { buildLegacyGraphView } from '../../src/lib/graph/projection/schema-org';
import { canonicalNQuads } from '../../src/lib/graph/serialize/canonical';
import { namedNode } from '../../src/lib/graph/rdf';
import { OW, SKOS } from '../../src/lib/graph/vocab';

const iri = createIriFactory(urnInstanceBase('00000000-0000-4000-8000-000000000000'));

const fixture = (): WorkspaceSnapshotInput => ({
    docs: [
        {
            id: 'doc-1', slug: 'erster-eintrag', title: 'Erster Eintrag',
            content: 'Verweist auf [[Zweiter Eintrag]] und [[Fehlt Noch]].',
            tags: ['wissen', 'wissen/rdf'], type: 'TechArticle', author: 'michael-pajewski',
            inLanguage: 'de', createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-02T10:00:00.000Z',
        },
        {
            id: 'doc-2', slug: 'zweiter-eintrag', title: 'Zweiter Eintrag', content: 'Inhalt.',
            tags: [], type: 'BlogPosting',
            createdAt: '2026-01-03T10:00:00.000Z', updatedAt: '2026-01-03T10:00:00.000Z',
        },
    ],
    tasks: [
        {
            id: 'task-1', title: 'Blockierte Aufgabe', status: 'todo', priority: 'high', type: 'task',
            projectId: 'proj-1', tags: ['wissen'],
            dependencies: [{ id: 'task-2', type: 'FS' }],
            createdAt: '2026-01-04T10:00:00.000Z', updatedAt: '2026-01-04T10:00:00.000Z',
            dueDate: '2026-02-01T00:00:00.000Z',
        },
        {
            id: 'task-2', title: 'Fertige Aufgabe', status: 'done', priority: 'low', type: 'task',
            tags: [], dependencies: [],
            createdAt: '2026-01-05T10:00:00.000Z', updatedAt: '2026-01-06T10:00:00.000Z',
        },
    ],
    projects: [
        {
            id: 'proj-1', title: 'Graph Core', prefix: 'GC', status: 'active', color: '#00674F',
            createdAt: '2026-01-01T09:00:00.000Z', updatedAt: '2026-01-01T09:00:00.000Z',
        },
    ],
    canvases: [
        {
            id: 'canvas-1', name: 'Planung', description: 'Testcanvas',
            cards: [
                {
                    id: 'card-a', type: 'note', title: 'Karte A', content: 'Notiz',
                    x: 10, y: 20, width: 200, height: 100, color: '#ff0000',
                    createdAt: '2026-01-07T10:00:00.000Z', updatedAt: '2026-01-07T10:00:00.000Z',
                },
                {
                    id: 'card-b', type: 'note', title: 'Karte B',
                    x: 300, y: 20, width: 200, height: 100,
                    createdAt: '2026-01-07T10:00:00.000Z', updatedAt: '2026-01-07T10:00:00.000Z',
                },
            ],
            connections: [{ id: 'conn-1', fromId: 'card-a', toId: 'card-b', type: 'directional' }],
            viewport: { x: 0, y: 0, zoom: 1 },
            createdAt: '2026-01-07T09:00:00.000Z', updatedAt: '2026-01-07T11:00:00.000Z',
        },
    ],
    calendars: [
        {
            id: 'cal-1', name: 'Tango', url: 'https://example.org/kalender.ics',
            color: '#be185d', enabled: true, lastSync: '2026-01-08T10:00:00.000Z',
        },
    ],
    events: [
        {
            id: 'evt-1', providerId: 'cal-1', title: 'Milonga', location: 'Alte Mälzerei',
            startDate: '2026-01-09T18:30:00.000Z', endDate: '2026-01-09T22:30:00.000Z', allDay: false,
        },
    ],
    conversations: [
        {
            id: 'conv-1', title: 'Erste Frage',
            messages: [
                { id: 'msg-1', role: 'user', content: 'Was steht an?', timestamp: '2026-01-10T10:00:00.000Z' },
                {
                    id: 'msg-2', role: 'assistant', content: 'Zwei Aufgaben.',
                    timestamp: '2026-01-10T10:00:01.000Z', uiComponents: [{ type: 'list' }],
                },
            ],
            createdAt: '2026-01-10T09:59:00.000Z', updatedAt: '2026-01-10T10:00:01.000Z',
        },
    ],
    activeConversationId: 'conv-1',
});

describe('Migrator (SPEC §12.2)', () => {
    it('Zähl-Assertions: kein Bestand geht verloren (M1-Abnahme)', () => {
        const input = fixture();
        const { counts } = buildWorkspaceQuads(input, iri);
        expect(counts.docs).toBe(input.docs.length);
        expect(counts.tasks).toBe(input.tasks.length);
        expect(counts.projects).toBe(input.projects.length);
        expect(counts.canvases).toBe(input.canvases.length);
        expect(counts.cards).toBe(2);
        expect(counts.tags).toBe(2); // 'wissen', 'wissen/rdf'
        expect(counts.links).toBe(2 + 1 + 1); // 2 Wikilinks, 1 blockedBy, 1 Canvas-Kante
    });

    it('ist idempotent: zweimal bauen ergibt kanonisch identische Quads', async () => {
        const a = buildWorkspaceQuads(fixture(), iri).quads;
        const b = buildWorkspaceQuads(fixture(), iri).quads;
        expect(await canonicalNQuads(a)).toBe(await canonicalNQuads(b));
    });

    it('Slug-Logik stimmt mit storage/docs.generateSlug überein', () => {
        for (const title of ['Zweiter Eintrag', 'Über Ökologie & Straße', 'HowTo: Open Workspace nutzen!']) {
            expect(slugifyTitle(title)).toBe(generateSlug(title));
        }
    });

    it('modelliert Wikilinks als ow:linksTo, Abhängigkeiten als ow:blockedBy', () => {
        const { quads } = buildWorkspaceQuads(fixture(), iri);
        const linksTo = quads.filter(q => q.predicate.value === OW.linksTo);
        expect(linksTo.some(q =>
            q.subject.value === iri.entity('doc', 'doc-1') &&
            q.object.value === iri.entity('doc', 'doc-2'),
        )).toBe(true);
        const blocked = quads.filter(q => q.predicate.value === OW.blockedBy);
        expect(blocked).toHaveLength(1);
        expect(blocked[0].subject.value).toBe(iri.entity('task', 'task-1'));
        expect(blocked[0].object.value).toBe(iri.entity('task', 'task-2'));
    });

    it('löst Wikilinks auch über den Titel auf, wenn der Slug abweicht', () => {
        // Der Realfall aus data/docs: Der Slug stammt aus dem Anlege-
        // Zeitpunkt (`module-tasks`), der Wikilink nennt den heutigen
        // Titel („Modul: Aufgaben & Projekte"). Beides muss auf dasselbe
        // Dokument zeigen — sonst hängt die Kante ins Leere und die
        // schema.org-Projektion wirft sie still weg.
        const input: WorkspaceSnapshotInput = {
            ...fixture(),
            docs: [
                {
                    id: 'sys-doc-001', slug: 'how-to-open-workspace', title: 'HowTo: Open Workspace nutzen',
                    content: 'Siehe [[Modul: Aufgaben & Projekte]] und [[Gibt Es Nicht]].',
                    tags: [], type: 'HowTo',
                    createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z',
                },
                {
                    id: 'sys-doc-002', slug: 'module-tasks', title: 'Modul: Aufgaben & Projekte',
                    content: 'Inhalt.', tags: [], type: 'TechArticle',
                    createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z',
                },
            ],
        };
        const linksTo = buildWorkspaceQuads(input, iri).quads
            .filter(q => q.predicate.value === OW.linksTo && q.subject.value === iri.entity('doc', 'sys-doc-001'));
        expect(linksTo.map(q => q.object.value)).toEqual([
            iri.entity('doc', 'sys-doc-002'),
            // Unauflösbares bleibt unauflösbar — behauptet, aber ohne Knoten.
            iri.entity('doc', 'gibt-es-nicht'),
        ]);
    });

    it('verschachtelte Tags erhalten skos:broader', () => {
        const { quads } = buildWorkspaceQuads(fixture(), iri);
        const broader = quads.filter(q => q.predicate.value === SKOS.broader);
        expect(broader).toHaveLength(1);
        expect(broader[0].subject.value).toBe(iri.entity('tag', 'wissen/rdf'));
        expect(broader[0].object.value).toBe(iri.entity('tag', 'wissen'));
    });

    it('Wissen/Präsentation-Trennung: keine Layout-Werte im Workspace-Graphen', () => {
        const { quads } = buildWorkspaceQuads(fixture(), iri);
        // Blacklist von Präsentationsbegriffen — darf in keiner Prädikat-IRI
        // des semantischen Graphen vorkommen (M5-Abnahme, hier vorgezogen).
        const blacklist = ['color', 'position', '/x', '/y', 'width', 'height', 'viewport', 'zoom', '/val'];
        for (const q of quads) {
            const predicate = q.predicate.value.toLowerCase();
            for (const banned of blacklist) {
                expect(predicate.includes(banned), `${q.predicate.value} enthält "${banned}"`).toBe(false);
            }
        }
        // Und keine Literalwerte der Canvas-Koordinaten.
        expect(quads.some(q => q.object.termType === 'Literal' && q.object.value === '#ff0000')).toBe(false);
    });
});

describe('schema.org-Projektion (SPEC §12.3)', () => {
    it('liefert die Legacy-Ansicht ohne color/val aus dem Store', async () => {
        const store = new OxigraphStore();
        const { quads } = buildWorkspaceQuads(fixture(), iri);
        await store.load(quads, namedNode(iri.graph('workspace')));

        const view = await buildLegacyGraphView(store, iri);
        expect(view['@context']).toBe('https://schema.org');

        const byId = new Map(view['@graph'].map(node => [node['@id'], node]));

        // Kein Knoten trägt Präsentations-Properties.
        for (const node of view['@graph']) {
            expect('color' in node).toBe(false);
            expect('val' in node).toBe(false);
        }

        const doc1 = byId.get(iri.entity('doc', 'doc-1'));
        expect(doc1).toBeDefined();
        expect(doc1?.['@type']).toBe('TechArticle');
        expect(doc1?.headline).toBe('Erster Eintrag');
        // Nur aufgelöste Wikilinks erscheinen als mentions.
        expect(doc1?.mentions).toHaveLength(1);
        expect(doc1?.mentions?.[0]['@id']).toBe(iri.entity('doc', 'doc-2'));
        expect(doc1?.about).toHaveLength(2);

        const doc2 = byId.get(iri.entity('doc', 'doc-2'));
        expect(doc2?.['@type']).toBe('BlogPosting');

        const task1 = byId.get(iri.entity('task', 'task-1'));
        expect(task1?.['@type']).toBe('Action');
        expect(task1?.agent?.['@id']).toBe(iri.entity('project', 'proj-1'));
        expect(task1?.dependencies).toHaveLength(1);
        expect(task1?.dependencies?.[0]['@id']).toBe(iri.entity('task', 'task-2'));

        const task2 = byId.get(iri.entity('task', 'task-2'));
        expect(task2?.actionStatus).toBe('CompletedActionStatus');

        const project = byId.get(iri.entity('project', 'proj-1'));
        expect(project?.['@type']).toBe('Project');
        expect(project?.name).toBe('Graph Core');

        const canvas = byId.get(iri.entity('canvas', 'canvas-1'));
        expect(canvas?.['@type']).toBe('CreativeWork');

        const tag = byId.get(iri.entity('tag', 'wissen'));
        expect(tag?.['@type']).toBe('DefinedTerm');
        expect(tag?.name).toBe('#wissen');

        // Karten erscheinen nicht in der Legacy-Ansicht (wie zuvor).
        expect(byId.has(iri.entity('card', 'canvas-1/card-a'))).toBe(false);
    });

    it('nutzt den Store als einzige Quelle (leerer Store → leere Ansicht)', async () => {
        const store = new OxigraphStore();
        const view = await buildLegacyGraphView(store, iri);
        expect(view['@graph']).toHaveLength(0);
    });
});
