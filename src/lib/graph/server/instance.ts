/**
 * Serverseitige Store-Instanz (Runtime `server`/`ha-addon`).
 *
 * Initialisierung beim ersten Zugriff:
 *  1. Instanz-Base auflösen (OW_INSTANCE_BASE → data/graph/instance.json →
 *     neue UUID, persistiert). `https://exocortex.local` existiert nicht mehr.
 *  2. Mitgelieferte Ontologie `ontology/ow.ttl` nach `graph/vocab` laden —
 *     Reasoning/Validierung funktionieren offline (SPEC §3.2).
 *  3. Snapshot `data/graph/` wiederherstellen, falls vorhanden.
 *
 * // MIGRATION: Bis die Schreibpfade auf den Store umgestellt sind
 * (SPEC §12.4), bleiben die Dateien unter data/docs|tasks|canvas die
 * operative Quelle. syncWorkspaceFromFiles() spiegelt sie bei jeder
 * Anfrage inhalts-gehasht in den Workspace-Graphen (No-Op, wenn
 * unverändert). Dieser Lesepfad hat ein Ablaufdatum: Er endet, sobald
 * src/lib/storage/* über den Store schreibt — dann ist der Store die
 * Wahrheit und die Dateien sind Projektion.
 */

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { OxigraphStore } from '../store/oxigraph';
import { createIriFactory, isValidInstanceBase, urnInstanceBase, type IriFactory } from '../iri';
import { createNodeFileSystem } from '@/lib/platform/runtime/node-fs';
import { parseRdf } from '../serialize/io';
import { restoreSnapshot } from '../serialize/snapshot';
import { buildWorkspaceQuads, type MigrationCounts, type WorkspaceSnapshotInput } from '../migrate/from-files';
import { namedNode } from '../rdf';
import { listDocs } from '@/lib/storage/docs';
import { listTasks } from '@/lib/storage/tasks';
import { listProjects } from '@/lib/storage/projects';
import { listCanvases, getCanvas, type CanvasData } from '@/lib/storage/canvas';

export interface ServerGraph {
    store: OxigraphStore;
    iri: IriFactory;
}

interface ServerGraphState extends ServerGraph {
    lastWorkspaceHash: string | null;
    syncChain: Promise<unknown>;
}

const GRAPH_DIR = () => path.join(process.cwd(), 'data', 'graph');
const INSTANCE_FILE = () => path.join(GRAPH_DIR(), 'instance.json');
const ONTOLOGY_FILE = () => path.join(process.cwd(), 'ontology', 'ow.ttl');

/**
 * Dev-Hot-Reload-sicherer Singleton (Next.js erzeugt Module mehrfach).
 * Als Promise gehalten, damit parallele Erst-Requests nicht doppelt
 * initialisieren.
 */
const globalState = globalThis as unknown as { __owGraphState?: Promise<ServerGraphState> };

async function resolveInstanceBase(): Promise<string> {
    const fromEnv = process.env.OW_INSTANCE_BASE;
    if (fromEnv) {
        if (!isValidInstanceBase(fromEnv)) {
            throw new Error(
                `OW_INSTANCE_BASE ist ungültig: "${fromEnv}". Erwartet: absolute HTTP(S)-IRI ` +
                'mit abschließendem "/" (z. B. https://ws.example.org/id/) oder urn:ow:<uuid>:.',
            );
        }
        return fromEnv;
    }
    const fs = createNodeFileSystem();
    if (await fs.exists(INSTANCE_FILE())) {
        const parsed: unknown = JSON.parse(await fs.readFile(INSTANCE_FILE()));
        const base = (parsed as { instanceBase?: string }).instanceBase;
        if (base && isValidInstanceBase(base)) return base;
        throw new Error(`data/graph/instance.json enthält keine gültige instanceBase.`);
    }
    const base = urnInstanceBase(randomUUID());
    await fs.mkdir(GRAPH_DIR());
    await fs.writeFile(
        INSTANCE_FILE(),
        `${JSON.stringify({ instanceBase: base, createdAt: new Date().toISOString() }, null, 2)}\n`,
    );
    return base;
}

async function createState(): Promise<ServerGraphState> {
    const instanceBase = await resolveInstanceBase();
    const state: ServerGraphState = {
        store: new OxigraphStore(),
        iri: createIriFactory(instanceBase),
        lastWorkspaceHash: null,
        syncChain: Promise.resolve(),
    };
    const fs = createNodeFileSystem();
    // 2. Vokabular laden (mitgelieferte Kopie, kein Netzzugriff).
    const ttl = await fs.readFile(ONTOLOGY_FILE());
    const vocabQuads = parseRdf(ttl, { format: 'text/turtle' });
    await state.store.load(vocabQuads, namedNode(state.iri.sharedGraph('vocab')), { replace: true });
    // 3. Snapshot wiederherstellen, falls vorhanden.
    await restoreSnapshot(state.store, fs, GRAPH_DIR());
    return state;
}

function getState(): Promise<ServerGraphState> {
    if (!globalState.__owGraphState) {
        globalState.__owGraphState = createState();
        // Fehlgeschlagene Initialisierung nicht dauerhaft cachen.
        globalState.__owGraphState.catch(() => {
            delete globalState.__owGraphState;
        });
    }
    return globalState.__owGraphState;
}

export async function readWorkspaceInput(): Promise<WorkspaceSnapshotInput> {
    const [docs, tasks, projects, canvasIndex] = await Promise.all([
        listDocs(),
        listTasks(),
        listProjects().catch(() => []),
        listCanvases(),
    ]);
    const canvases = (
        await Promise.all(canvasIndex.map(entry => getCanvas(entry.id)))
    ).filter((canvas): canvas is CanvasData => canvas !== null);
    return { docs, tasks, projects, canvases };
}

function hashInput(input: WorkspaceSnapshotInput): string {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/**
 * // MIGRATION: Dateien → Workspace-Graph, inhalts-gehasht. Entfällt mit
 * der Umstellung der Schreibpfade auf den Store (TODO.md, Graph-Core M1).
 */
export async function syncWorkspaceFromFiles(state?: ServerGraphState): Promise<MigrationCounts | null> {
    const s = state ?? (await getState());
    // Läufe serialisieren, damit parallele Requests nicht doppelt laden.
    const run = s.syncChain.then(async () => {
        const input = await readWorkspaceInput();
        const hash = hashInput(input);
        if (s.lastWorkspaceHash === hash) return null;
        const { quads, counts } = buildWorkspaceQuads(input, s.iri);
        await s.store.load(quads, namedNode(s.iri.graph('workspace')), { replace: true });
        s.lastWorkspaceHash = hash;
        return counts;
    });
    s.syncChain = run.catch(() => undefined);
    return run;
}

/** Store + IRI-Fabrik, initialisiert und mit dem Dateibestand synchron. */
export async function getServerGraph(): Promise<ServerGraph> {
    const state = await getState();
    await syncWorkspaceFromFiles(state);
    return { store: state.store, iri: state.iri };
}

/** Nur für Tests: Singleton zurücksetzen. */
export function __resetServerGraphForTests(): void {
    delete globalState.__owGraphState;
}
