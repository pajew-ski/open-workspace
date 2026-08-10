// @vitest-environment node
/**
 * Abnahme Abschluss SPEC §12.4 („M1-Rest: Schreibpfade umstellen"):
 *
 *  1. Der Store trägt das Domänenmodell verlustfrei — Round-Trip
 *     Domänenmodell → Store → Domänenmodell ist identisch (inkl. exakter
 *     Task-Zustände, Prioritäten, Aufwände, Abhängigkeits-Typen als
 *     RDF-1.2-Annotation, Projekt-Farbe in der Präsentationsschicht,
 *     nativer Kartentypen und Gruppen-Karten).
 *  2. Der zweite Round-Trip ist ein Fixpunkt (Normalisierungen greifen
 *     genau einmal) — analog zur M4-Abnahme des Obsidian-Connectors.
 *  3. CRUD läuft Store-first: Mutationen landen im Store, die Dateien
 *     sind Projektion; ein externer Datei-Edit ändert die Wahrheit NICHT.
 *  4. Die `// MIGRATION:`-Marker sind aufgelöst (SPEC §12.4 beendet).
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWorkspaceQuads, type WorkspaceSnapshotInput } from '../../src/lib/graph/migrate/from-files';
import { isoFromStoreValue, workspaceFromStore } from '../../src/lib/graph/workspace/read';
import * as crud from '../../src/lib/graph/workspace/crud';
import { writeWorkspaceToStore } from '../../src/lib/graph/workspace/crud';
import { defaultWorkspaceFilePaths, docFromMarkdown, parseFrontmatter, readWorkspaceFiles } from '../../src/lib/graph/workspace/files';
import { createIriFactory, urnInstanceBase } from '../../src/lib/graph/iri';
import { OxigraphStore } from '../../src/lib/graph/store/oxigraph';
import { OW, SCHEMA } from '../../src/lib/graph/vocab';
import { namedNode } from '../../src/lib/graph/rdf';

const iri = createIriFactory(urnInstanceBase('00000000-0000-4000-8000-00000000abcd'));

/**
 * Bereits normalisiertes Fixture (sortierte Tags/Abhängigkeiten, Entitäten
 * in createdAt-Reihenfolge, keine leeren optionalen Strings) — der erste
 * Round-Trip muss es EXAKT reproduzieren.
 */
const fixture = (): WorkspaceSnapshotInput => ({
    docs: [
        {
            id: 'doc-1', slug: 'erster-eintrag', title: 'Erster Eintrag',
            content: 'Verweist auf [[Zweiter Eintrag]].',
            category: 'Wissen', tags: ['rdf', 'wissen'], type: 'CreativeWork',
            author: 'michael-pajewski', inLanguage: 'de',
            createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-02T10:00:00.000Z',
        },
        {
            id: 'doc-2', slug: 'zweiter-eintrag', title: 'Zweiter Eintrag', content: 'Inhalt.',
            tags: [], type: 'TechArticle', inLanguage: 'de',
            createdAt: '2026-01-03T10:00:00.000Z', updatedAt: '2026-01-03T10:00:00.123Z',
        },
    ],
    tasks: [
        {
            id: 'task-1', projectId: 'proj-1', title: 'Review-Aufgabe',
            description: 'Mit allen Feldern.',
            status: 'review', priority: 'urgent', type: 'bug',
            startDate: '2026-01-04T08:00:00.000Z', dueDate: '2026-02-01T00:00:00.000Z',
            deferredUntil: '2026-01-20T00:00:00.000Z',
            estimatedEffort: 2.5, actualEffort: 4,
            dependencies: [{ id: 'task-2', type: 'SS' }, { id: 'task-3', type: 'FS' }],
            tags: ['wissen'],
            createdAt: '2026-01-04T10:00:00.000Z', updatedAt: '2026-01-04T11:00:00.000Z',
        },
        {
            id: 'task-2', title: 'Erledigt', status: 'done', priority: 'low', type: 'milestone',
            tags: [], dependencies: [],
            createdAt: '2026-01-05T10:00:00.000Z', updatedAt: '2026-01-06T10:00:00.000Z',
            completedAt: '2026-01-06T10:00:00.000Z',
        },
        {
            id: 'task-3', title: 'Zurückgestellt', status: 'on-hold', priority: 'medium', type: 'feature',
            tags: [], dependencies: [],
            createdAt: '2026-01-06T10:00:00.000Z', updatedAt: '2026-01-06T10:00:00.000Z',
        },
    ],
    projects: [
        {
            id: 'proj-1', title: 'Graph Core', description: 'Vollausbau', prefix: 'GC',
            status: 'archived', color: '#aa5500',
            createdAt: '2026-01-01T09:00:00.000Z', updatedAt: '2026-01-01T09:30:00.000Z',
        },
    ],
    canvases: [
        {
            id: 'canvas-1', name: 'Planung', description: 'Testcanvas',
            cards: [
                {
                    id: 'card-a', type: 'note', title: 'Notiz', content: 'Text',
                    x: 10, y: 20, width: 200, height: 100, color: '#ff0000',
                    createdAt: '2026-01-07T10:00:00.000Z', updatedAt: '2026-01-07T10:00:00.000Z',
                },
                {
                    id: 'card-b', type: 'task', title: 'Aufgaben-Karte', content: 'Todo',
                    x: 300, y: 20, width: 200, height: 100,
                    createdAt: '2026-01-07T10:01:00.000Z', updatedAt: '2026-01-07T10:01:00.000Z',
                },
                {
                    id: 'card-c', type: 'link', title: 'Link-Karte', content: 'https://example.org/seite',
                    x: 10, y: 200, width: 200, height: 100,
                    createdAt: '2026-01-07T10:02:00.000Z', updatedAt: '2026-01-07T10:02:00.000Z',
                },
                {
                    id: 'card-d', type: 'image', title: 'Bild', content: 'bilder/foto.png',
                    x: 300, y: 200, width: 200, height: 100,
                    createdAt: '2026-01-07T10:03:00.000Z', updatedAt: '2026-01-07T10:03:00.000Z',
                },
                {
                    id: 'card-e', type: 'file', title: 'Datei', content: 'notizen/plan.md#Abschnitt',
                    x: 500, y: 200, width: 200, height: 100,
                    createdAt: '2026-01-07T10:04:00.000Z', updatedAt: '2026-01-07T10:04:00.000Z',
                },
                {
                    id: 'card-f', type: 'group', title: 'Rahmen',
                    x: 0, y: 0, width: 800, height: 400, color: '#00aaff',
                    createdAt: '2026-01-07T10:05:00.000Z', updatedAt: '2026-01-07T10:06:00.000Z',
                },
            ],
            connections: [
                { id: 'conn-1', fromId: 'card-a', toId: 'card-b', type: 'directional' },
                { id: 'conn-2', fromId: 'card-b', toId: 'card-c', type: 'simple', label: 'führt zu' },
                { id: 'conn-3', fromId: 'card-c', toId: 'card-d', type: 'bidirectional' },
            ],
            viewport: { x: -12.5, y: 40, zoom: 1.25 },
            createdAt: '2026-01-07T09:00:00.000Z', updatedAt: '2026-01-07T11:00:00.000Z',
        },
    ],
    calendars: [
        {
            id: 'cal-1', name: 'Tango Regensburg', url: 'https://example.org/kalender.ics',
            color: '#be185d', enabled: true, lastSync: '2026-01-08T10:00:00.000Z',
        },
        {
            id: 'cal-2', name: 'Abgeschaltet', url: 'https://example.org/aus.ics',
            color: '#00674F', enabled: false, lastSync: null,
        },
    ],
    events: [
        {
            id: 'evt-1', providerId: 'cal-1', title: 'Milonga del Sol',
            description: 'Mit Live-Musik.', location: 'Alte Mälzerei',
            startDate: '2026-01-09T18:30:00.000Z', endDate: '2026-01-09T22:30:00.000Z', allDay: false,
        },
        {
            id: 'evt-2', providerId: 'cal-1', title: 'Ganztägiger Workshop',
            startDate: '2026-01-10T00:00:00.000Z', endDate: '2026-01-11T00:00:00.000Z', allDay: true,
        },
    ],
    conversations: [
        {
            id: 'conv-1', title: 'Aufgaben-Frage',
            messages: [
                { id: 'msg-1', role: 'user', content: 'Welche Aufgaben stehen an?', timestamp: '2026-01-11T10:00:00.000Z' },
                {
                    id: 'msg-2', role: 'assistant', content: 'Zwei offene Aufgaben.',
                    timestamp: '2026-01-11T10:00:02.000Z',
                    uiComponents: [{ type: 'TaskList', ids: ['task-1'] }],
                },
            ],
            createdAt: '2026-01-11T09:59:00.000Z', updatedAt: '2026-01-11T10:00:02.000Z',
        },
        {
            id: 'conv-2', title: 'Leerer Chat', messages: [],
            createdAt: '2026-01-12T09:00:00.000Z', updatedAt: '2026-01-12T09:00:00.000Z',
        },
    ],
    activeConversationId: 'conv-2',
});

async function roundTrip(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotInput> {
    const store = new OxigraphStore();
    await writeWorkspaceToStore(store, iri, input);
    return workspaceFromStore(store, iri);
}

describe('Round-Trip Domänenmodell ↔ Store (Abschluss SPEC §12.4)', () => {
    it('reproduziert ein normalisiertes Fixture exakt (inkl. aller Quelltreue-Felder)', async () => {
        const input = fixture();
        const output = await roundTrip(input);
        expect(output).toEqual(fixture());
    });

    it('ist ein Fixpunkt: zweiter Round-Trip identisch zum ersten (auch bei unnormalisiertem Input)', async () => {
        const messy = fixture();
        messy.docs[0].tags = ['wissen', 'rdf'];                      // unsortiert
        messy.tasks[0].dependencies = [
            { id: 'task-3', type: 'FS' }, { id: 'task-2', type: 'SS' }, // unsortiert
        ];
        messy.tasks[0].description = '';                              // leer → entfällt
        messy.docs[0].category = undefined;
        const first = await roundTrip(messy);
        const second = await roundTrip(first);
        expect(second).toEqual(first);
        // Normalisierungen: Tags sortiert, leere Strings entfallen.
        expect(first.docs[0].tags).toEqual(['rdf', 'wissen']);
        expect(first.tasks[0].description).toBeUndefined();
        expect(first.tasks[0].dependencies.map(d => `${d.id}:${d.type}`)).toEqual(['task-2:SS', 'task-3:FS']);
    });

    it('führt Oxigraph-normalisierte Zeitstempel-Lexik exakt zurück (Endnullen der Sekundenbruchteile)', async () => {
        // Oxigraphs kanonische xsd:dateTime-Lexik kürzt Endnullen: „.000"
        // entfällt ganz, „.090" wird „.09", „.100" wird „.1". Ohne die
        // Rückführung wäre der Round-Trip zeitabhängig flaky (trifft immer
        // dann, wenn die Millisekunden des Schreibzeitpunkts auf 0 enden).
        expect(isoFromStoreValue('2026-08-09T14:30:29.09Z')).toBe('2026-08-09T14:30:29.090Z');
        expect(isoFromStoreValue('2026-08-09T14:30:29.1Z')).toBe('2026-08-09T14:30:29.100Z');
        expect(isoFromStoreValue('2026-08-09T14:30:29Z')).toBe('2026-08-09T14:30:29.000Z');
        expect(isoFromStoreValue('2026-08-09T14:30:29.123Z')).toBe('2026-08-09T14:30:29.123Z');
        // Nicht angetastet: reine Datumsangaben und fremde Offsets.
        expect(isoFromStoreValue('2026-02-01')).toBe('2026-02-01');
        expect(isoFromStoreValue('2026-08-09T14:30:29.090+02:00')).toBe('2026-08-09T14:30:29.090+02:00');

        const input = fixture();
        input.tasks[1].completedAt = '2026-01-06T10:00:00.090Z';
        input.tasks[1].updatedAt = '2026-01-06T10:00:00.100Z';
        input.tasks[0].dueDate = '2026-02-01T00:00:00.010Z';
        input.tasks[0].deferredUntil = '2026-01-20T00:00:00.900Z';
        const output = await roundTrip(input);
        const done = output.tasks.find(t => t.id === 'task-2');
        expect(done?.completedAt).toBe('2026-01-06T10:00:00.090Z');
        expect(done?.updatedAt).toBe('2026-01-06T10:00:00.100Z');
        const review = output.tasks.find(t => t.id === 'task-1');
        expect(review?.dueDate).toBe('2026-02-01T00:00:00.010Z');
        expect(review?.deferredUntil).toBe('2026-01-20T00:00:00.900Z');
    });

    it('trennt Wissen und Präsentation: Projekt-Farbe und Kartentyp-Feinheit liegen im Presentation-Graphen', async () => {
        const store = new OxigraphStore();
        await writeWorkspaceToStore(store, iri, fixture());
        const workspace: string[] = [];
        for await (const q of store.dump(namedNode(iri.graph('workspace')))) {
            workspace.push(q.predicate.value, q.object.value);
        }
        expect(workspace).not.toContain('#aa5500');   // Projekt-Farbe
        expect(workspace).not.toContain(OW.cardKind);
        const presentation: string[] = [];
        for await (const q of store.dump(namedNode(iri.graph('presentation')))) {
            presentation.push(`${q.predicate.value}=${q.object.value}`);
        }
        expect(presentation).toContain(`${SCHEMA.color}=#aa5500`);
        expect(presentation).toContain(`${OW.cardKind}=task`);
        expect(presentation).toContain(`${OW.cardKind}=image`);
    });

    it('Zähl-Assertions: kein Bestand geht im Schreibpfad verloren', async () => {
        const input = fixture();
        const { counts } = buildWorkspaceQuads(input, iri);
        expect(counts.docs).toBe(input.docs.length);
        expect(counts.tasks).toBe(input.tasks.length);
        expect(counts.projects).toBe(input.projects.length);
        expect(counts.canvases).toBe(input.canvases.length);
        expect(counts.cards).toBe(5); // Gruppe zählt semantisch nicht (SPEC §9)
    });

    it('die MIGRATION-Marker sind aufgelöst (§12.4 beendet)', async () => {
        const roots = ['src/lib/graph', 'src/lib/storage', 'src/app/api'];
        const offenders: string[] = [];
        const walk = async (dir: string): Promise<void> => {
            for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(full);
                } else if (/\.(ts|tsx)$/.test(entry.name)) {
                    const content = await fs.readFile(full, 'utf-8');
                    if (content.includes('// MIGRATION:')) offenders.push(full);
                }
            }
        };
        for (const root of roots) {
            await walk(path.join(process.cwd(), root));
        }
        expect(offenders).toEqual([]);
    });
});

describe('Store-first-CRUD (Dateien sind Projektion)', () => {
    async function createTestContext(): Promise<{ ctx: crud.WorkspaceContext; baseDir: string }> {
        const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-workspace-'));
        const store = new OxigraphStore();
        let chain: Promise<unknown> = Promise.resolve();
        const ctx: crud.WorkspaceContext = {
            store,
            iri,
            paths: defaultWorkspaceFilePaths(baseDir),
            runExclusive: fn => {
                const run = chain.then(fn);
                chain = run.catch(() => undefined);
                return run;
            },
            persistSnapshot: async () => undefined,
        };
        return { ctx, baseDir };
    }

    it('createDoc schreibt Store + Datei-Projektion; Umbenennung räumt die alte Datei weg', async () => {
        const { ctx } = await createTestContext();
        const doc = await crud.createDoc(ctx, { title: 'Mein Eintrag', content: 'Hallo Welt.', tags: ['a'] });
        expect(doc.slug).toBe('mein-eintrag');

        // Store ist die Wahrheit:
        const fromStore = await crud.getDoc(ctx, doc.id);
        expect(fromStore?.title).toBe('Mein Eintrag');

        // Datei-Projektion existiert und trägt das bekannte Frontmatter-Format:
        const filePath = path.join(ctx.paths.docsDir, 'mein-eintrag.md');
        const raw = await fs.readFile(filePath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(raw);
        expect(frontmatter?.id).toBe(doc.id);
        expect(frontmatter?.title).toBe('Mein Eintrag');
        expect(body).toBe('Hallo Welt.');

        // Slug-Änderung: neue Datei da, alte weg.
        await crud.updateDoc(ctx, doc.id, { title: 'Neuer Titel', slug: 'neuer-titel' });
        expect(await fs.readFile(path.join(ctx.paths.docsDir, 'neuer-titel.md'), 'utf-8')).toContain('Neuer Titel');
        await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('Markdown ohne vollständiges Frontmatter wird begründet übergangen, nicht still verschluckt', () => {
        // Vorher fiel so eine Datei lautlos aus dem Bestand: Sie lag
        // sichtbar in data/docs, tauchte aber in keinem Graphen auf.
        const ohne = docFromMarkdown('# Nur eine Überschrift\n\nText.');
        expect(ohne).toEqual({ skipped: expect.stringContaining('kein Frontmatter') });

        const unvollstaendig = docFromMarkdown(
            '---\nslug: "ohne-id"\ntitle: "Ohne id"\ntags: []\n---\n\nText.',
        );
        expect('skipped' in unvollstaendig && unvollstaendig.skipped).toContain('id');
        expect('skipped' in unvollstaendig && unvollstaendig.skipped).toContain('createdAt');

        const vollstaendig = docFromMarkdown(
            '---\nid: "doc-1"\nslug: "gut"\ntitle: "Gut"\ntags: ["a"]\n'
            + 'createdAt: "2026-01-01T00:00:00.000Z"\nupdatedAt: "2026-01-01T00:00:00.000Z"\n---\n\nText.',
        );
        expect('doc' in vollstaendig && vollstaendig.doc).toMatchObject({
            id: 'doc-1', slug: 'gut', title: 'Gut', tags: ['a'], content: 'Text.',
        });
    });

    it('ein externer Datei-Edit ändert die Wahrheit nicht (SPEC §16: Rückfluss nur über Connectors)', async () => {
        const { ctx } = await createTestContext();
        const doc = await crud.createDoc(ctx, { title: 'Stabil', content: 'Original.' });
        const filePath = path.join(ctx.paths.docsDir, `${doc.slug}.md`);
        await fs.writeFile(filePath, '---\nid: "hacked"\nslug: "stabil"\ntitle: "Gekapert"\ntags: []\ncreatedAt: "2026-01-01T00:00:00.000Z"\nupdatedAt: "2026-01-01T00:00:00.000Z"\n---\n\nFremder Inhalt.', 'utf-8');
        const fromStore = await crud.getDoc(ctx, doc.id);
        expect(fromStore?.title).toBe('Stabil');
        expect(fromStore?.content).toBe('Original.');
        expect((await crud.listDocs(ctx)).map(d => d.title)).toEqual(['Stabil']);
    });

    it('Task-Lebenszyklus: exakter Status, completedAt-Semantik, Projektion nach tasks.json', async () => {
        const { ctx } = await createTestContext();
        const task = await crud.createTask(ctx, {
            title: 'Bug fixen', type: 'bug', priority: 'urgent', status: 'in-progress',
            estimatedEffort: 1.5, dependencies: [{ id: 'task-x', type: 'FF' }],
        });
        const inProgress = await crud.getTask(ctx, task.id);
        expect(inProgress?.status).toBe('in-progress');
        expect(inProgress?.priority).toBe('urgent');
        expect(inProgress?.type).toBe('bug');
        expect(inProgress?.estimatedEffort).toBe(1.5);
        expect(inProgress?.dependencies).toEqual([{ id: 'task-x', type: 'FF' }]);

        const done = await crud.updateTask(ctx, task.id, { status: 'done' });
        expect(done?.completedAt).toBeDefined();
        const reopened = await crud.updateTask(ctx, task.id, { status: 'todo' });
        expect(reopened?.completedAt).toBe(done?.completedAt); // bleibt erhalten (Altverhalten)

        const projected = JSON.parse(await fs.readFile(ctx.paths.tasksFile, 'utf-8')) as { tasks: Array<{ id: string; status: string }> };
        expect(projected.tasks.map(t => t.id)).toEqual([task.id]);
        expect(projected.tasks[0].status).toBe('todo');
    });

    it('Canvas-Lebenszyklus inkl. Karten, Verbindungen, Viewport und Lösch-Projektion', async () => {
        const { ctx } = await createTestContext();
        const canvas = await crud.createCanvas(ctx, 'Board', 'Testboard');
        const cardA = await crud.createCard(ctx, canvas.id, { title: 'A', x: 0, y: 0 });
        const cardB = await crud.createCard(ctx, canvas.id, { title: 'B', x: 100, y: 0, type: 'task' });
        expect(cardA && cardB).toBeTruthy();
        const conn = await crud.createConnection(ctx, canvas.id, cardA!.id, cardB!.id, 'bidirectional', 'hängt zusammen');
        expect(conn).not.toBeNull();
        await crud.updateViewport(ctx, canvas.id, { x: 5, y: 6, zoom: 2 });

        const loaded = await crud.getCanvas(ctx, canvas.id);
        expect(loaded?.cards).toHaveLength(2);
        expect(loaded?.cards.find(c => c.id === cardB!.id)?.type).toBe('task');
        expect(loaded?.connections[0]).toMatchObject({ fromId: cardA!.id, toId: cardB!.id, type: 'bidirectional', label: 'hängt zusammen' });
        expect(loaded?.viewport).toEqual({ x: 5, y: 6, zoom: 2 });

        // Datei-Projektion vorhanden, Index synchron:
        const files = await readWorkspaceFiles(ctx.paths);
        expect(files.canvases).toHaveLength(1);
        expect(files.canvases[0].cards).toHaveLength(2);

        await crud.deleteCanvas(ctx, canvas.id);
        expect(await crud.getCanvas(ctx, canvas.id)).toBeNull();
        const afterDelete = await readWorkspaceFiles(ctx.paths);
        expect(afterDelete.canvases).toHaveLength(0);
    });

    it('Projekt-Farbe überlebt den Store-Weg (Presentation-Graph, nicht Datei)', async () => {
        const { ctx } = await createTestContext();
        const project = await crud.createProject(ctx, { title: 'P', prefix: 'pp', color: '#123456' });
        expect(project.prefix).toBe('PP');
        const loaded = await crud.getProject(ctx, project.id);
        expect(loaded?.color).toBe('#123456');
        const updated = await crud.updateProject(ctx, project.id, { color: '#654321', status: 'active' });
        expect(updated?.color).toBe('#654321');
        expect((await crud.getProject(ctx, project.id))?.status).toBe('active');
    });
});
