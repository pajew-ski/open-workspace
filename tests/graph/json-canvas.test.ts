/**
 * M5-Abnahme (GRAPH_CORE_SPEC §13) als Tests:
 *
 *  1. „Ein in Obsidian erstelltes `.canvas` öffnet im Workspace und
 *     umgekehrt": Obsidian-Fixture → native Pinnwand (alle Knotenarten
 *     kommen an) → Export ist gültiges JSON Canvas 1.0; der zweite
 *     Round-Trip (Export → Import → Export) ist byte-identisch.
 *  2. „Kein Layout-Wert im semantischen Graphen": die Blacklist aus
 *     tests/graph/migrate.test.ts gilt auch für den Import-Graphen des
 *     json-canvas-Connectors — Layout liegt ausschließlich in
 *     graph/<u>/presentation und ist aus dem SPARQL-Default-Dataset
 *     ausgeschlossen.
 *  3. Connector-Regeln (SPEC §6.2): Revision-No-Op, Replace bei
 *     Änderung, Push-Konfliktregel, Fehlertoleranz (kaputte Einträge
 *     quarantänieren, der Import läuft weiter), Aufräumen der
 *     Layout-Gruppe beim Löschen.
 *  4. Generierte Query-Views (SPEC §9): gespeicherte CONSTRUCT-Query
 *     mit Layout-Verfahren, aufgelöst über das erlaubte Dataset.
 */

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { namedNode, literal, factory } from '@/lib/graph/rdf';
import { OW, RDF, SCHEMA } from '@/lib/graph/vocab';
import { createMemoryFileSystem } from '@/lib/platform/runtime/memfs';
import { createConnector, deleteConnector, type GraphHandle } from '@/lib/graph/connectors/registry';
import { pushConnector, syncConnector } from '@/lib/graph/connectors/sync';
import {
    parseJsonCanvas,
    serializeJsonCanvas,
    type JsonCanvas,
    type JsonCanvasEdge,
    type JsonCanvasNode,
} from '@/lib/graph/connectors/json-canvas/format';
import { jsonCanvasToNative, nativeCanvasToJsonCanvas } from '@/lib/graph/connectors/json-canvas/native';
import { buildJsonCanvasQuads } from '@/lib/graph/connectors/json-canvas/map';
import { projectCanvasToJsonCanvas } from '@/lib/graph/projection/json-canvas';
import {
    buildNativeCanvasLayout,
    pruneOrphanCanvasLayouts,
    replaceCanvasLayouts,
} from '@/lib/graph/presentation/layout';
import { buildWorkspaceQuads } from '@/lib/graph/migrate/from-files';
import type { CanvasData } from '@/lib/storage/canvas';
import {
    createQueryView,
    deleteQueryView,
    getQueryView,
    listQueryViews,
    resolveQueryView,
} from '@/lib/graph/views/registry';

const INSTANCE_BASE = 'urn:ow:12345678-1234-1234-1234-123456789abc:';
const CANVAS_PATH = '/vaults/zettelkasten/plan.canvas';

/** Blacklist der Präsentationsbegriffe — wie in tests/graph/migrate.test.ts. */
const LAYOUT_BLACKLIST = ['color', 'position', '/x', '/y', 'width', 'height', 'viewport', 'zoom', '/val'];

/** Realistische Obsidian-Datei: alle vier Knotenarten, Kanten mit Ankern/Labels. */
const OBSIDIAN_FIXTURE = `{
  "nodes": [
    {"id": "a1b2c3", "type": "text", "text": "# Idee\\n\\nGraph als Wahrheit", "x": -160, "y": -80, "width": 320, "height": 160, "color": "3"},
    {"id": "d4e5f6", "type": "file", "file": "begriffe/ontologie.md", "x": 240, "y": -80, "width": 320, "height": 200},
    {"id": "aaaa11", "type": "file", "file": "notizen/plan.md", "subpath": "#Ziele", "x": 240, "y": 180, "width": 320, "height": 200},
    {"id": "bbbb22", "type": "link", "url": "https://jsoncanvas.org/", "x": -160, "y": 160, "width": 320, "height": 120},
    {"id": "cccc33", "type": "group", "label": "Kernbereich", "x": -200, "y": -140, "width": 420, "height": 480}
  ],
  "edges": [
    {"id": "e1", "fromNode": "a1b2c3", "fromSide": "right", "toNode": "d4e5f6", "toSide": "left", "label": "beschreibt"},
    {"id": "e2", "fromNode": "a1b2c3", "toNode": "bbbb22", "toEnd": "none", "color": "#ff0000"},
    {"id": "e3", "fromNode": "cccc33", "toNode": "aaaa11"}
  ]
}
`;

const byId = <T extends { id: string }>(items: T[]): T[] => [...items].sort((a, b) => a.id.localeCompare(b.id));

async function dumpGraph(handle: GraphHandle, graphIri: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of handle.store.dump(namedNode(graphIri))) {
        quads.push(q);
    }
    return quads;
}

function expectNoLayoutPredicates(quads: Quad[], where: string): void {
    for (const q of quads) {
        const predicate = q.predicate.value.toLowerCase();
        for (const banned of LAYOUT_BLACKLIST) {
            expect(
                predicate.includes(banned),
                `${where}: ${q.predicate.value} enthält "${banned}" — Layout gehört nach graph/presentation`,
            ).toBe(false);
        }
    }
}

function fixedClock(): () => Date {
    let tick = 0;
    return () => new Date(Date.UTC(2026, 7, 9, 12, 0, tick += 1));
}

const originalVaultRoots = process.env.OW_VAULT_ROOTS;
afterAll(() => {
    if (originalVaultRoots === undefined) delete process.env.OW_VAULT_ROOTS;
    else process.env.OW_VAULT_ROOTS = originalVaultRoots;
});

// ---------------------------------------------------------------------------
describe('JSON Canvas 1.0: Parsen und Serialisieren', () => {
    it('parst die Obsidian-Fixture vollständig und ohne Issues', () => {
        const { canvas, issues } = parseJsonCanvas(OBSIDIAN_FIXTURE, 'plan.canvas');
        expect(issues).toEqual([]);
        expect(canvas.nodes).toHaveLength(5);
        expect(canvas.edges).toHaveLength(3);
        const file = canvas.nodes.find(node => node.id === 'aaaa11');
        expect(file).toMatchObject({ type: 'file', file: 'notizen/plan.md', subpath: '#Ziele' });
    });

    it('ist fehlertolerant: ungültige Einträge werden übersprungen und begründet', () => {
        const broken = JSON.stringify({
            nodes: [
                { id: 'ok', type: 'text', text: 'gültig', x: 0, y: 0, width: 100, height: 50 },
                { id: 'kaputt', type: 'text', x: 0, y: 0, width: 100, height: 50 },
                { id: 'ok', type: 'text', text: 'doppelt', x: 0, y: 0, width: 100, height: 50 },
                { id: 'seltsam', type: 'video', x: 0, y: 0, width: 100, height: 50 },
            ],
            edges: [
                { id: 'e-ok', fromNode: 'ok', toNode: 'ok' },
                { id: 'e-dangling', fromNode: 'ok', toNode: 'fehlt' },
            ],
        });
        const { canvas, issues } = parseJsonCanvas(broken, 'kaputt.canvas');
        expect(canvas.nodes.map(node => node.id)).toEqual(['ok']);
        expect(canvas.edges.map(edge => edge.id)).toEqual(['e-ok']);
        // Kaputter Text-Knoten, doppelte ID, unbekannter Typ, verwaiste Kante.
        expect(issues.map(issue => issue.source)).toEqual(['nodes[1]', 'nodes[2]', 'nodes[3]', 'edges[1]']);
    });

    it('unlesbares JSON ergibt eine leere Canvas mit Datei-Issue statt eines Absturzes', () => {
        const { canvas, issues } = parseJsonCanvas('kein json', 'defekt.canvas');
        expect(canvas.nodes).toEqual([]);
        expect(issues).toHaveLength(1);
        expect(issues[0].source).toBe('defekt.canvas');
    });

    it('serialisiert deterministisch: Parse → Serialize ist ein Fixpunkt', () => {
        const first = serializeJsonCanvas(parseJsonCanvas(OBSIDIAN_FIXTURE).canvas);
        const second = serializeJsonCanvas(parseJsonCanvas(first).canvas);
        expect(second).toBe(first);
    });
});

// ---------------------------------------------------------------------------
describe('M5-Abnahme: .canvas öffnet im Workspace und umgekehrt (nativer Pfad)', () => {
    it('übernimmt alle Knotenarten in die Pinnwand', () => {
        const { canvas } = parseJsonCanvas(OBSIDIAN_FIXTURE);
        const native = jsonCanvasToNative(canvas);

        expect(native.cards).toHaveLength(5);
        const types = new Map(native.cards.map(card => [card.id, card.type]));
        expect(types.get('a1b2c3')).toBe('note');
        expect(types.get('d4e5f6')).toBe('file');
        expect(types.get('bbbb22')).toBe('link');
        expect(types.get('cccc33')).toBe('group');

        const note = native.cards.find(card => card.id === 'a1b2c3');
        expect(note).toMatchObject({ title: 'Idee', content: 'Graph als Wahrheit', color: '3' });
        const file = native.cards.find(card => card.id === 'aaaa11');
        expect(file?.content).toBe('notizen/plan.md#Ziele');
        const group = native.cards.find(card => card.id === 'cccc33');
        expect(group?.title).toBe('Kernbereich');

        // Kantensemantik: toEnd 'none' → einfach, Defaults → gerichtet.
        const connectionTypes = new Map(native.connections.map(conn => [conn.id, conn.type]));
        expect(connectionTypes.get('e1')).toBe('directional');
        expect(connectionTypes.get('e2')).toBe('simple');
        expect(native.connections.find(conn => conn.id === 'e1')?.label).toBe('beschreibt');
    });

    it('Export ist gültiges JSON Canvas 1.0; Inhalte überleben, Anker/Kantenfarbe sind dokumentierte Verluste', () => {
        const original = parseJsonCanvas(OBSIDIAN_FIXTURE).canvas;
        const exported = parseJsonCanvas(serializeJsonCanvas(nativeCanvasToJsonCanvas(jsonCanvasToNative(original))));
        expect(exported.issues).toEqual([]);

        const strippedNodes = (canvas: JsonCanvas): JsonCanvasNode[] => byId(canvas.nodes);
        expect(strippedNodes(exported.canvas)).toEqual(strippedNodes(original));

        const strip = (edge: JsonCanvasEdge) => {
            const { fromSide, toSide, color, ...rest } = edge;
            void fromSide; void toSide; void color;
            return rest;
        };
        expect(byId(exported.canvas.edges).map(strip)).toEqual(byId(original.edges).map(strip));
        // Verlustpositionen (docs/obsidian-kompatibilitaet.md): Anker-Seiten
        // und Kantenfarben kennt das native Modell nicht.
        expect(exported.canvas.edges.every(edge => edge.fromSide === undefined && edge.color === undefined)).toBe(true);
    });

    it('der zweite Round-Trip (Export → Import → Export) ist byte-identisch', () => {
        const firstExport = serializeJsonCanvas(
            nativeCanvasToJsonCanvas(jsonCanvasToNative(parseJsonCanvas(OBSIDIAN_FIXTURE).canvas)),
        );
        const secondExport = serializeJsonCanvas(
            nativeCanvasToJsonCanvas(jsonCanvasToNative(parseJsonCanvas(firstExport).canvas)),
        );
        expect(secondExport).toBe(firstExport);
    });

    it('eine im Workspace erstellte Pinnwand überlebt Export → Import (Titel, Typen, Verbindungen)', () => {
        const workspaceCanvas = {
            cards: [
                { id: 'card-a', type: 'note' as const, title: 'Karte A', content: 'Notiz mit **Markdown**', x: 10.4, y: 20, width: 240, height: 180, color: '#00674F' },
                { id: 'card-b', type: 'note' as const, title: '', content: 'Ohne Titel', x: 300, y: 20, width: 240, height: 180 },
            ],
            connections: [
                { id: 'conn-1', fromId: 'card-a', toId: 'card-b', type: 'bidirectional' as const, label: 'gehört zu' },
            ],
        };
        const exported = serializeJsonCanvas(nativeCanvasToJsonCanvas(workspaceCanvas));
        const reimported = jsonCanvasToNative(parseJsonCanvas(exported).canvas);

        expect(reimported.cards.find(card => card.id === 'card-a')).toMatchObject({
            type: 'note', title: 'Karte A', content: 'Notiz mit **Markdown**', x: 10, color: '#00674F',
        });
        expect(reimported.cards.find(card => card.id === 'card-b')).toMatchObject({ title: '', content: 'Ohne Titel' });
        expect(reimported.connections[0]).toMatchObject({ type: 'bidirectional', label: 'gehört zu' });
    });
});

// ---------------------------------------------------------------------------
describe('json-canvas-Connector: M5-Abnahme (Graph-Pfad)', () => {
    let handle: GraphHandle;
    let files: ReturnType<typeof createMemoryFileSystem>;

    beforeEach(async () => {
        process.env.OW_VAULT_ROOTS = '/vaults';
        handle = { store: new OxigraphStore(), iri: createIriFactory(INSTANCE_BASE) };
        files = createMemoryFileSystem();
        files.files.set(CANVAS_PATH, OBSIDIAN_FIXTURE);
        await createConnector(handle, { id: 'plan', name: 'Plan-Canvas', kind: 'json-canvas', locator: CANVAS_PATH });
    });

    const sync = () => syncConnector(handle, 'plan', { files, now: fixedClock() });
    const push = () => pushConnector(handle, 'plan', { files, now: fixedClock() });
    const importGraph = () => dumpGraph(handle, handle.iri.importGraph('plan'));
    const presentationGraph = () => dumpGraph(handle, handle.iri.graph('presentation'));

    it('Wissen in den Import-Graphen, Layout NUR nach graph/presentation (Invariante 2)', async () => {
        const result = await sync();
        expect(result.status).toBe('imported');
        expect(result.quarantined).toEqual([]);

        const semantic = await importGraph();
        const layout = await presentationGraph();
        const canvasIri = handle.iri.entity('canvas', 'plan');

        // Semantik: Canvas-Knoten + Gegenstücke + untypisierte Kante.
        expect(semantic.some(q => q.subject.value === canvasIri && q.predicate.value === RDF.type && q.object.value === OW.Canvas)).toBe(true);
        const textCounterpart = handle.iri.entity('card', 'plan/a1b2c3');
        expect(semantic.some(q => q.subject.value === textCounterpart && q.predicate.value === SCHEMA.text && q.object.value === '# Idee\n\nGraph als Wahrheit')).toBe(true);
        expect(semantic.some(q => q.subject.value === textCounterpart && q.predicate.value === OW.linksTo && q.object.value === handle.iri.entity('card', 'plan/d4e5f6'))).toBe(true);
        // Gruppen: kein semantisches Gegenstück, Gruppen-Kante keine Wissens-Kante.
        expect(semantic.some(q => q.subject.value === handle.iri.entity('card', 'plan/cccc33'))).toBe(false);
        expect(semantic.some(q => q.predicate.value === OW.linksTo && q.object.value === handle.iri.entity('card', 'plan/aaaa11'))).toBe(false);

        // Kein Layout-Wert im semantischen Graphen — Blacklist wie M1/M5.
        expectNoLayoutPredicates(semantic, 'Import-Graph');

        // Layout vollständig in graph/presentation, gruppiert unter dem Canvas.
        const layoutNode = handle.iri.entity('canvas-node', 'plan/a1b2c3');
        expect(layout.some(q => q.subject.value === layoutNode && q.predicate.value === OW.xPosition && q.object.value === '-160')).toBe(true);
        expect(layout.some(q => q.subject.value === layoutNode && q.predicate.value === SCHEMA.isPartOf && q.object.value === canvasIri)).toBe(true);
        expect(layout.some(q => q.subject.value === layoutNode && q.predicate.value === OW.rendersNode && q.object.value === textCounterpart)).toBe(true);
        const edgeNode = handle.iri.entity('canvas-edge', 'plan/e1');
        expect(layout.some(q => q.subject.value === edgeNode && q.predicate.value === OW.fromSide && q.object.value === 'right')).toBe(true);
    });

    it('PROV liegt am Import-Graphen, Revision-No-Op greift, Änderung ersetzt sauber', async () => {
        const first = await sync();
        expect(first.status).toBe('imported');
        const provSubject = handle.iri.importGraph('plan');
        expect((await importGraph()).some(q => q.subject.value === provSubject && q.predicate.value === OW.revision)).toBe(true);

        const second = await sync();
        expect(second.status).toBe('noop');

        // Externe Änderung: ein Knoten verschwindet → Replace, kein Rest.
        const edited = parseJsonCanvas(OBSIDIAN_FIXTURE).canvas;
        edited.nodes = edited.nodes.filter(node => node.id !== 'bbbb22');
        edited.edges = edited.edges.filter(edge => edge.toNode !== 'bbbb22');
        files.files.set(CANVAS_PATH, serializeJsonCanvas(edited));
        const third = await sync();
        expect(third.status).toBe('imported');
        expect((await importGraph()).some(q => q.subject.value === handle.iri.entity('card', 'plan/bbbb22'))).toBe(false);
        expect((await presentationGraph()).some(q => q.subject.value === handle.iri.entity('canvas-node', 'plan/bbbb22'))).toBe(false);
    });

    it('Round-Trip über push: Datei → Graph → Datei ist inhaltsgleich, der zweite Push byte-identisch', async () => {
        await sync();
        const pushResult = await push();
        expect(pushResult.status).toBe('pushed');

        const written = files.files.get(CANVAS_PATH) as string;
        const reparsed = parseJsonCanvas(written);
        expect(reparsed.issues).toEqual([]);
        expect(byId(reparsed.canvas.nodes)).toEqual(byId(parseJsonCanvas(OBSIDIAN_FIXTURE).canvas.nodes));
        expect(byId(reparsed.canvas.edges)).toEqual(byId(parseJsonCanvas(OBSIDIAN_FIXTURE).canvas.edges));

        // Zweiter Lauf: Sync sieht die normalisierte Datei, Push ändert nichts mehr.
        const resync = await sync();
        expect(resync.status).toBe('noop');
        const secondPush = await push();
        expect(secondPush.status).toBe('pushed');
        expect(files.files.get(CANVAS_PATH)).toBe(written);
    });

    it('Push-Konfliktregel (SPEC §6.2): externe Änderung blockiert den Export dateigenau', async () => {
        await sync();
        files.files.set(CANVAS_PATH, `${OBSIDIAN_FIXTURE.trimEnd()}\n \n`);
        const result = await push();
        expect(result.status).toBe('conflict');
        expect(result.conflicts[0].path).toBe(CANVAS_PATH);
    });

    it('Fehlertoleranz: kaputte Einträge quarantänieren, der Rest wird importiert', async () => {
        files.files.set(CANVAS_PATH, JSON.stringify({
            nodes: [
                { id: 'ok', type: 'text', text: 'bleibt', x: 0, y: 0, width: 100, height: 50 },
                { id: 'defekt', type: 'text', x: 0, y: 0, width: 100, height: 50 },
            ],
        }));
        const result = await sync();
        expect(result.status).toBe('imported');
        expect(result.quarantined).toHaveLength(1);
        expect((await importGraph()).some(q => q.subject.value === handle.iri.entity('card', 'plan/ok'))).toBe(true);
    });

    it('Löschen des Connectors räumt Import-Graph UND Layout-Gruppe aus', async () => {
        await sync();
        expect((await presentationGraph()).length).toBeGreaterThan(0);
        expect(await deleteConnector(handle, 'plan')).toBe(true);
        expect(await importGraph()).toEqual([]);
        expect(await presentationGraph()).toEqual([]);
    });

    it('Pfad-Politik: .canvas außerhalb der freigegebenen Wurzeln ist blockiert', async () => {
        await createConnector(handle, { id: 'boese', name: 'Böse', kind: 'json-canvas', locator: '/etc/geheim.canvas' });
        const result = await syncConnector(handle, 'boese', { files, now: fixedClock() });
        expect(result.status).toBe('failed');
        expect(result.message).toContain('blockiert');
    });
});

// ---------------------------------------------------------------------------
describe('Präsentationsschicht: native Pinnwände und Koexistenz', () => {
    const iri = createIriFactory(INSTANCE_BASE);

    const nativeCanvas = (): CanvasData => ({
        id: 'canvas-1',
        name: 'Planung',
        cards: [
            {
                id: 'card-a', type: 'note', title: 'Karte A', content: 'Notiz',
                x: 10.5, y: 20, width: 240, height: 180, color: '#00674F',
                createdAt: '2026-01-07T10:00:00.000Z', updatedAt: '2026-01-07T10:00:00.000Z',
            },
            {
                id: 'grp', type: 'group', title: 'Rahmen',
                x: -50, y: -50, width: 600, height: 400,
                createdAt: '2026-01-07T10:00:00.000Z', updatedAt: '2026-01-07T10:00:00.000Z',
            },
        ],
        connections: [{ id: 'conn-1', fromId: 'card-a', toId: 'grp', type: 'simple' }],
        viewport: { x: 12, y: -30, zoom: 1.5 },
        createdAt: '2026-01-07T09:00:00.000Z', updatedAt: '2026-01-07T11:00:00.000Z',
    });

    it('buildNativeCanvasLayout: Viewport + Karten + Kanten, rendersNode nur für Nicht-Gruppen', () => {
        const group = buildNativeCanvasLayout(nativeCanvas(), iri);
        const canvasIri = iri.entity('canvas', 'canvas-1');
        expect(group.canvasIri).toBe(canvasIri);
        expect(group.quads.some(q => q.subject.value === canvasIri && q.predicate.value === OW.viewportZoom && q.object.value === '1.5')).toBe(true);
        const cardLayout = iri.entity('canvas-node', 'canvas-1/card-a');
        expect(group.quads.some(q => q.subject.value === cardLayout && q.predicate.value === OW.xPosition && q.object.value === '10.5')).toBe(true);
        expect(group.quads.some(q => q.subject.value === cardLayout && q.predicate.value === OW.rendersNode)).toBe(true);
        const groupLayout = iri.entity('canvas-node', 'canvas-1/grp');
        expect(group.quads.some(q => q.subject.value === groupLayout && q.predicate.value === OW.rendersNode)).toBe(false);
        expect(group.quads.some(q => q.subject.value === groupLayout && q.predicate.value === OW.nodeKind && q.object.value === 'group')).toBe(true);
    });

    it('buildWorkspaceQuads: Gruppen und Gruppen-Kanten erzeugen KEINE semantischen Aussagen', () => {
        const { quads, counts } = buildWorkspaceQuads(
            { docs: [], tasks: [], projects: [], canvases: [nativeCanvas()], calendars: [], events: [], conversations: [] },
            iri,
        );
        expect(counts.cards).toBe(1);
        expect(quads.some(q => q.subject.value === iri.entity('card', 'canvas-1/grp'))).toBe(false);
        expect(quads.some(q => q.predicate.value === OW.linksTo)).toBe(false);
        expectNoLayoutPredicates(quads, 'Workspace-Graph');
    });

    it('replaceCanvasLayouts ersetzt gruppenweise; pruneOrphanCanvasLayouts entfernt nur Verwaiste', async () => {
        const store = new OxigraphStore();
        const canvas = nativeCanvas();

        // Canvas 1 ist im Workspace als ow:Canvas verankert (lebendig).
        await store.load(
            [factory.quad(namedNode(iri.entity('canvas', 'canvas-1')), namedNode(RDF.type), namedNode(OW.Canvas))],
            namedNode(iri.graph('workspace')),
        );
        // Zweite Layout-Gruppe eines (bereits gelöschten) Imports.
        const ghostCanvas = iri.entity('canvas', 'geist');
        const ghostNode = iri.entity('canvas-node', 'geist/n1');
        const ghostQuads = [
            factory.quad(namedNode(ghostNode), namedNode(RDF.type), namedNode(OW.CanvasNode)),
            factory.quad(namedNode(ghostNode), namedNode(SCHEMA.isPartOf), namedNode(ghostCanvas)),
        ];

        await replaceCanvasLayouts(store, iri, [
            buildNativeCanvasLayout(canvas, iri),
            { canvasIri: ghostCanvas, quads: ghostQuads },
        ]);

        // Ersetzen von Canvas 1 lässt die fremde Gruppe unangetastet.
        canvas.cards[0].x = 999;
        await replaceCanvasLayouts(store, iri, [buildNativeCanvasLayout(canvas, iri)]);
        const layout = async () => {
            const quads: Quad[] = [];
            for await (const q of store.dump(namedNode(iri.graph('presentation')))) quads.push(q);
            return quads;
        };
        let current = await layout();
        expect(current.some(q => q.subject.value === iri.entity('canvas-node', 'canvas-1/card-a') && q.object.value === '999')).toBe(true);
        expect(current.some(q => q.subject.value === ghostNode)).toBe(true);

        // Prune: der Geist hat kein ow:Canvas mehr → weg; Canvas 1 bleibt.
        const removed = await pruneOrphanCanvasLayouts(store, iri);
        expect(removed).toEqual([ghostCanvas]);
        current = await layout();
        expect(current.some(q => q.subject.value === ghostNode)).toBe(false);
        expect(current.some(q => q.subject.value === iri.entity('canvas-node', 'canvas-1/card-a'))).toBe(true);
    });

    it('Graph-Projektion: map + projection sind zueinander invers (Fixture-Fixpunkt)', () => {
        const parsed = parseJsonCanvas(OBSIDIAN_FIXTURE).canvas;
        const built = buildJsonCanvasQuads(parsed, iri, 'plan', 'vaults/z/plan.canvas');
        const projected = projectCanvasToJsonCanvas(built.canvasIri, built.semantic, built.layout);
        expect(byId(projected.nodes)).toEqual(byId(parsed.nodes));
        expect(byId(projected.edges)).toEqual(byId(parsed.edges));
    });
});

// ---------------------------------------------------------------------------
describe('Generierte Query-Views (SPEC §9)', () => {
    let handle: GraphHandle;

    beforeEach(async () => {
        handle = { store: new OxigraphStore(), iri: createIriFactory(INSTANCE_BASE) };
        const doc = handle.iri.entity('doc', 'doc-1');
        const target = handle.iri.entity('doc', 'doc-2');
        await handle.store.load([
            factory.quad(namedNode(doc), namedNode(RDF.type), namedNode(OW.Document)),
            factory.quad(namedNode(doc), namedNode(SCHEMA.name), literal('Erster Eintrag', 'de')),
            factory.quad(namedNode(doc), namedNode(OW.linksTo), namedNode(target)),
            factory.quad(namedNode(target), namedNode(RDF.type), namedNode(OW.Document)),
            factory.quad(namedNode(target), namedNode(SCHEMA.name), literal('Zweiter Eintrag', 'de')),
        ], namedNode(handle.iri.graph('workspace')));
        // Layout-Köder: darf in keiner View auftauchen (Dataset-Ausschluss).
        await handle.store.load([
            factory.quad(
                namedNode(handle.iri.entity('canvas-node', 'x/n1')),
                namedNode(OW.xPosition),
                literal('42'),
            ),
        ], namedNode(handle.iri.graph('presentation')));
    });

    it('speichert, listet und löst eine CONSTRUCT-View auf — ohne Präsentations-Quads', async () => {
        const view = await createQueryView(handle, {
            id: 'doku-netz',
            name: 'Dokument-Netz',
            queryText: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
            layoutMethod: 'radial',
        });
        expect((await listQueryViews(handle)).map(v => v.id)).toEqual(['doku-netz']);
        expect((await getQueryView(handle, 'doku-netz'))?.layoutMethod).toBe('radial');

        const resolved = await resolveQueryView(handle, 'doku-netz');
        expect(resolved.view.id).toBe(view.id);
        expect(resolved.truncated).toBe(false);
        const names = new Map(resolved.nodes.map(node => [node.id, node.name]));
        expect(names.get(handle.iri.entity('doc', 'doc-1'))).toBe('Erster Eintrag');
        expect(resolved.links).toContainEqual({
            source: handle.iri.entity('doc', 'doc-1'),
            target: handle.iri.entity('doc', 'doc-2'),
            type: 'linksTo',
        });
        // Der Layout-Köder aus graph/presentation ist unsichtbar.
        expect(resolved.nodes.some(node => node.id.includes('canvas-node'))).toBe(false);
    });

    it('lehnt Nicht-Graph-Ergebnisse ab und löscht Views rückstandsfrei', async () => {
        await createQueryView(handle, {
            id: 'falsch',
            name: 'Falsche Form',
            queryText: 'SELECT ?s WHERE { ?s ?p ?o }',
            layoutMethod: 'force-directed',
        });
        await expect(resolveQueryView(handle, 'falsch')).rejects.toThrow(/CONSTRUCT oder DESCRIBE/);
        expect(await deleteQueryView(handle, 'falsch')).toBe(true);
        expect(await listQueryViews(handle)).toEqual([]);
    });
});
