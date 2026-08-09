/**
 * Serverseitige Store-Instanz (Runtime `server`/`ha-addon`).
 *
 * Initialisierung beim ersten Zugriff:
 *  1. Instanz-Base auflösen (OW_INSTANCE_BASE → data/graph/instance.json →
 *     neue UUID, persistiert). `https://exocortex.local` existiert nicht mehr.
 *  2. Mitgelieferte Ontologie `ontology/ow.ttl` nach `graph/vocab` laden —
 *     Reasoning/Validierung funktionieren offline (SPEC §3.2).
 *  3. Snapshot `data/graph/` wiederherstellen, falls vorhanden.
 *  4. Bootstrap (Abschluss SPEC §12.4): Fehlt der Snapshot oder stammt er
 *     aus der Zeit VOR der Umstellung der Schreibpfade (Manifest v1), wird
 *     der Dateibestand unter data/docs|tasks|canvas EINMALIG in den Store
 *     (re-)migriert — bis dahin waren die Dateien die operative Quelle.
 *
 * Danach ist der Store die einzige Wahrheit: Alle Lese- und Schreibpfade
 * laufen über `workspace/crud.ts`, die Dateien sind Projektion, und
 * externe Datei-Edits kommen über Connectors zurück (obsidian-vault,
 * git-backup — SPEC §16). Der frühere Pro-Request-Spiegel
 * (`syncWorkspaceFromFiles`) ist mitsamt seinen Übergangs-Markern
 * aufgelöst; das prüft `tests/graph/workspace-roundtrip.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { OxigraphStore } from '../store/oxigraph';
import { createIriFactory, isValidInstanceBase, urnInstanceBase, type IriFactory } from '../iri';
import { createNodeFileSystem } from '@/lib/platform/runtime/node-fs';
import { parseRdf } from '../serialize/io';
import { readManifest, restoreSnapshot, writeSnapshot, SNAPSHOT_SCHEMA_VERSION, type SnapshotReport } from '../serialize/snapshot';
import { namedNode } from '../rdf';
import { writeWorkspaceToStore, type WorkspaceContext } from '../workspace/crud';
import { workspaceFromStore } from '../workspace/read';
import { defaultWorkspaceFilePaths, projectWorkspaceFiles, readWorkspaceFiles } from '../workspace/files';

export interface ServerGraph {
    store: OxigraphStore;
    iri: IriFactory;
}

interface ServerGraphState extends ServerGraph {
    /** Prozessweite Serialisierung aller Mutationen (ein Schreiber pro Graph). */
    mutationChain: Promise<unknown>;
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
        mutationChain: Promise.resolve(),
    };
    const fs = createNodeFileSystem();
    // 2. Vokabular laden (mitgelieferte Kopie, kein Netzzugriff).
    const ttl = await fs.readFile(ONTOLOGY_FILE());
    const vocabQuads = parseRdf(ttl, { format: 'text/turtle' });
    await state.store.load(vocabQuads, namedNode(state.iri.sharedGraph('vocab')), { replace: true });
    // 3. Snapshot wiederherstellen, falls vorhanden (Manifest v1 und v2).
    await restoreSnapshot(state.store, fs, GRAPH_DIR());
    // 4. Bootstrap: Dateibestand einmalig (re-)migrieren, wenn der Snapshot
    //    fehlt oder noch aus der Dateien-als-Quelle-Ära stammt (v1).
    const manifest = await readManifest(fs, GRAPH_DIR());
    if (!manifest || manifest.schemaVersion < SNAPSHOT_SCHEMA_VERSION) {
        const input = await readWorkspaceFiles();
        await writeWorkspaceToStore(state.store, state.iri, input);
        await writeSnapshot(state.store, fs, GRAPH_DIR(), state.iri.instanceBase);
    }
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

/** Store + IRI-Fabrik, initialisiert (Bootstrap abgeschlossen). */
export async function getServerGraph(): Promise<ServerGraph> {
    const state = await getState();
    return { store: state.store, iri: state.iri };
}

/** Reiht eine Funktion in die prozessweite Mutations-Kette ein. */
async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const state = await getState();
    const run = state.mutationChain.then(fn);
    state.mutationChain = run.catch(() => undefined);
    return run;
}

/**
 * Persistiert den Store nach `data/graph/` (SPEC §8.1). Läuft nach jeder
 * Workspace-Mutation und nach Connector-Mutationen (Anlegen, Sync,
 * Löschen), damit der Zustand einen Neustart überlebt. Deterministisch
 * (RDFC-1.0), daher git-tauglich: `data/graph/` ist der Working-Tree des
 * Git-Syncs (M6). Läuft über die Mutations-Kette, damit Snapshot-Writes
 * nicht mit Workspace-Mutationen verschränken.
 */
export async function persistServerGraphSnapshot(): Promise<SnapshotReport> {
    const state = await getState();
    return runExclusive(() => writeSnapshot(state.store, createNodeFileSystem(), GRAPH_DIR(), state.iri.instanceBase));
}

/**
 * Projiziert die Workspace-Dateien neu aus dem Store — nötig, nachdem ein
 * Store-Serialisierungs-Connector (git-backup, SPEC §8.2) kanonische
 * Graphen wiederhergestellt hat: der Store ist die Wahrheit, also müssen
 * die Datei-Projektionen ihm folgen. Der VOR der Projektion gelesene
 * Dateibestand dient als Vorzustand, damit verwaiste Dateien weichen.
 */
export async function reprojectWorkspaceFiles(): Promise<void> {
    const state = await getState();
    await runExclusive(async () => {
        const previous = await readWorkspaceFiles();
        const input = await workspaceFromStore(state.store, state.iri);
        await projectWorkspaceFiles(input, previous);
    });
}

/**
 * Workspace-Kontext für die Store-first-CRUD-Schicht (workspace/crud.ts) —
 * der EINE Weg, auf dem UI und API den Workspace lesen und verändern.
 */
export async function getWorkspaceContext(): Promise<WorkspaceContext> {
    const state = await getState();
    return {
        store: state.store,
        iri: state.iri,
        paths: defaultWorkspaceFilePaths(),
        runExclusive,
        persistSnapshot: () => writeSnapshot(state.store, createNodeFileSystem(), GRAPH_DIR(), state.iri.instanceBase),
    };
}

/** Nur für Tests: Singleton zurücksetzen. */
export function __resetServerGraphForTests(): void {
    delete globalState.__owGraphState;
}
