/**
 * Serverseitige Store-Instanz (Runtime `server`/`ha-addon`).
 *
 * Initialisierung beim ersten Zugriff:
 *  1. Instanz-Base auflösen (OW_INSTANCE_BASE → data/graph/instance.json →
 *     neue UUID, persistiert). `https://exocortex.local` existiert nicht mehr.
 *  2. Mitgelieferte Ontologie `ontology/ow.ttl` plus Reasoning-Axiome
 *     `ontology/rules/*.ttl` nach `graph/vocab`, SHACL-Shapes
 *     `ontology/shapes/*.ttl` nach `graph/shapes` laden —
 *     Reasoning/Validierung funktionieren offline (SPEC §3.2, §7.2).
 *  3. Snapshot `data/graph/` wiederherstellen, falls vorhanden.
 *  4. Bootstrap (Abschluss SPEC §12.4): Fehlt der Snapshot oder stammt er
 *     aus der Zeit VOR der Umstellung der Schreibpfade (Manifest v1), wird
 *     der Dateibestand unter data/docs|tasks|canvas EINMALIG in den Store
 *     (re-)migriert — bis dahin waren die Dateien die operative Quelle.
 *  5. Zugriffsregeln (SPEC §17.2, M13): `acl.nq` zurücklesen, danach
 *     fehlende Standardregeln ergänzen — jeder Graph gehört per Default
 *     nur seinem Eigentümer.
 *  6. OWL-RL-Materialisierung (SPEC §7.3, M7): `graph/<u>/inferred/<scope>`
 *     wird nie persistiert (SPEC §8.1) und deshalb beim Start neu erzeugt.
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
import { createIriFactory, isValidInstanceBase, urnInstanceBase, DEFAULT_USER_ID, type IriFactory } from '../iri';
import { createNodeFileSystem } from '@/lib/platform/runtime/node-fs';
import { parseRdf } from '../serialize/io';
import {
    readManifest,
    restoreAclSnapshot,
    restoreSnapshot,
    writeAclSnapshot,
    writeSnapshot,
    SNAPSHOT_SCHEMA_VERSION,
    type SnapshotReport,
} from '../serialize/snapshot';
import { namedNode } from '../rdf';
import { runReasoning } from '../reasoning/run';
import { writeWorkspaceToStore, type WorkspaceContext } from '../workspace/crud';
import { workspaceFromStore } from '../workspace/read';
import { projectWorkspaceFiles, readWorkspaceFiles, workspaceFilePathsFor } from '../workspace/files';
import { invalidateSearchIndexes } from '../search/cache';
import { replaceAiMirror } from '../meta/ai';
import { loadAiMirrorInput } from '../meta/ai-input.server';
import { ensureDefaultAuthorizations } from '../authz/acl-graph';
import { ensureUser, spaceOwners } from '../authz/principals';

export interface ServerGraph {
    store: OxigraphStore;
    iri: IriFactory;
}

interface ServerGraphState extends ServerGraph {
    /** Prozessweite Serialisierung aller Mutationen (ein Schreiber pro Graph). */
    mutationChain: Promise<unknown>;
    /** Nutzer, deren Erstkontakt in diesem Prozess schon erledigt ist (M13). */
    bootstrappedUsers: Set<string>;
}

/**
 * Verwalter der Installation (M13, SPEC §17.2). Der Seed — und nur der:
 * Sobald `graph/acl` steht, ist der Graph die Wahrheit; diese Liste legt
 * beim Start nur die Regeln an, die noch fehlen. Default ist der
 * Einzelnutzer, damit eine bestehende Installation sich selbst gehört.
 */
export function adminUsers(env: NodeJS.ProcessEnv = process.env): string[] {
    const configured = (env.OW_ADMIN_USERS ?? '')
        .split(/[,\s]+/)
        .map(entry => entry.trim())
        .filter(Boolean);
    return configured.length > 0 ? [...new Set(configured)].sort() : [DEFAULT_USER_ID];
}

const GRAPH_DIR = () => path.join(process.cwd(), 'data', 'graph');
const INSTANCE_FILE = () => path.join(GRAPH_DIR(), 'instance.json');
const ONTOLOGY_FILE = () => path.join(process.cwd(), 'ontology', 'ow.ttl');
const RULES_DIR = () => path.join(process.cwd(), 'ontology', 'rules');
const SHAPES_DIR = () => path.join(process.cwd(), 'ontology', 'shapes');

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
        bootstrappedUsers: new Set<string>(),
    };
    const fs = createNodeFileSystem();
    // 2. Vokabular + Reasoning-Axiome nach graph/vocab, Shapes nach
    //    graph/shapes (mitgelieferte Kopien, kein Netzzugriff).
    const vocabQuads = parseRdf(await fs.readFile(ONTOLOGY_FILE()), { format: 'text/turtle' });
    vocabQuads.push(...await parseTurtleDir(fs, RULES_DIR()));
    await state.store.load(vocabQuads, namedNode(state.iri.sharedGraph('vocab')), { replace: true });
    const shapesQuads = await parseTurtleDir(fs, SHAPES_DIR());
    await state.store.load(shapesQuads, namedNode(state.iri.sharedGraph('shapes')), { replace: true });
    // 3. Snapshot wiederherstellen, falls vorhanden (Manifest v1 und v2).
    await restoreSnapshot(state.store, fs, GRAPH_DIR());
    // 4. Bootstrap: Dateibestand einmalig (re-)migrieren, wenn der Snapshot
    //    fehlt oder noch aus der Dateien-als-Quelle-Ära stammt (v1).
    const manifest = await readManifest(fs, GRAPH_DIR());
    const migrated = !manifest || manifest.schemaVersion < SNAPSHOT_SCHEMA_VERSION;
    if (migrated) {
        const input = await readWorkspaceFiles();
        await writeWorkspaceToStore(state.store, state.iri, input);
    }
    // 4b. AI-Spiegel (M9, SPEC §18-Muster): Skills, Agenten und Werkzeuge
    //     der Installation werden bei jedem Start aus der operativen
    //     Konfiguration nach graph/meta generiert, nie von Hand gepflegt.
    const mirror = await replaceAiMirror(state, await loadAiMirrorInput());
    // 5. Zugriffsregeln: gesicherte Regeln zurücklesen, dann auffüllen.
    //    Vor dem Snapshot, weil der Erstkontakt den Nutzerknoten in
    //    graph/meta anlegt — und der gehört mit in dieselbe Datei.
    await restoreAclSnapshot(state.store, fs, GRAPH_DIR(), namedNode(state.iri.sharedGraph('acl')));
    const accessChanged = await bootstrapAccess(state, DEFAULT_USER_ID);
    if (migrated || mirror.changed || accessChanged) {
        await writeSnapshot(state.store, fs, GRAPH_DIR(), state.iri.instanceBase);
    }
    // 6. Inferenz-Graphen materialisieren (nie persistiert, SPEC §8.1).
    await runReasoning(state);
    return state;
}

/**
 * Legt Nutzerknoten und fehlende Standardregeln an (SPEC §17.1/§17.2).
 * Idempotent: bestehende Regeln bleiben, wie ihr Verwalter sie gesetzt hat.
 */
async function bootstrapAccess(state: ServerGraphState, userId: string, displayName?: string): Promise<boolean> {
    const handle = { store: state.store, iri: state.iri };
    const admins = adminUsers();
    for (const admin of new Set([...admins, userId])) {
        await ensureUser(handle, admin, admin === userId ? displayName : undefined);
    }
    const userIri = createIriFactory(state.iri.instanceBase, userId);
    const report = await ensureDefaultAuthorizations(handle, {
        admins,
        spaceOwners: await spaceOwners(handle),
        // Ein Nutzergraph existiert erst mit seinem ersten Quad — seine
        // Regeln müssen davor stehen, sonst kann er nie entstehen.
        additionalGraphs: [
            userIri.graph('workspace'),
            userIri.graph('public'),
            userIri.graph('presentation'),
        ],
    });
    state.bootstrappedUsers.add(userId);
    if (report.created.length > 0) {
        await writeAclSnapshot(state.store, createNodeFileSystem(), GRAPH_DIR(), namedNode(state.iri.sharedGraph('acl')));
    }
    return report.created.length > 0;
}

/**
 * Erstkontakt einer Identität (M13): Nutzerknoten in `graph/meta`,
 * Standardregeln in `graph/acl`. Läuft genau einmal pro Prozess und
 * Nutzer und immer über die Mutations-Kette.
 */
export async function ensureUserBootstrap(userId: string, displayName?: string): Promise<void> {
    const state = await getState();
    if (state.bootstrappedUsers.has(userId)) return;
    await runExclusive(async () => {
        if (state.bootstrappedUsers.has(userId)) return;
        const changed = await bootstrapAccess(state, userId, displayName);
        if (changed) {
            await writeSnapshot(state.store, createNodeFileSystem(), GRAPH_DIR(), state.iri.instanceBase);
        }
    });
}

/** Persistiert `graph/acl` neben dem Snapshot (M13, nie im Manifest). */
export async function persistAclSnapshot(): Promise<void> {
    const state = await getState();
    await writeAclSnapshot(state.store, createNodeFileSystem(), GRAPH_DIR(), namedNode(state.iri.sharedGraph('acl')));
}

/** Parst alle `.ttl`-Dateien eines Verzeichnisses (sortiert, deterministisch). */
async function parseTurtleDir(fs: ReturnType<typeof createNodeFileSystem>, dir: string) {
    if (!(await fs.exists(dir))) return [];
    const quads = [];
    for (const name of (await fs.readdir(dir)).filter(n => n.endsWith('.ttl')).sort()) {
        quads.push(...parseRdf(await fs.readFile(path.join(dir, name)), { format: 'text/turtle' }));
    }
    return quads;
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

/**
 * Reiht eine Funktion in die prozessweite Mutations-Kette ein. Nach jedem
 * Durchlauf werden die Suchindizes invalidiert (M8): alle Mutationspfade
 * außer dem SPARQL-Update-Endpoint laufen hierüber (Workspace-CRUD,
 * Connector-Sync/-Löschen, Snapshot, Restore); die SPARQL-Route
 * invalidiert selbst.
 */
async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const state = await getState();
    const run = state.mutationChain
        .then(fn)
        .finally(() => invalidateSearchIndexes(state.store));
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
 * Erneuert den AI-Spiegel in `graph/meta` (M9) aus der operativen
 * Konfiguration — von den Mutations-Routen der AI-Schicht (Skills,
 * Agenten, Werkzeuge, MCP-Server) nach jedem erfolgreichen Schreiben
 * aufgerufen. Ändert sich der Spiegel, folgen Reasoning-Lauf (die
 * ow:Agent-⊑-foaf:Agent-Hülle lebt in graph/inferred) und Snapshot.
 */
export async function refreshAiMirror(): Promise<void> {
    const state = await getState();
    await runExclusive(async () => {
        const mirror = await replaceAiMirror(state, await loadAiMirrorInput());
        if (!mirror.changed) return;
        await runReasoning(state);
        await writeSnapshot(state.store, createNodeFileSystem(), GRAPH_DIR(), state.iri.instanceBase);
    });
}

/**
 * Wie `refreshAiMirror`, aber nicht-fatal — für die Mutations-Routen der
 * AI-Schicht: deren operativer Schreibvorgang ist bereits gelungen; ein
 * Spiegel-Fehler wird protokolliert und heilt sich beim nächsten Start
 * oder der nächsten Mutation selbst (der Spiegel wird stets vollständig
 * neu generiert).
 */
export async function refreshAiMirrorAfterMutation(context: string): Promise<void> {
    try {
        await refreshAiMirror();
    } catch (error) {
        console.error(`AI-Spiegel nach Mutation (${context}) nicht aktualisiert:`, error);
    }
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
 *
 * Seit M13 ist er nutzerskaliert: IRI-Fabrik und Datei-Projektion folgen
 * der Identität der laufenden Anfrage (`server/context.ts`). Für den
 * Einzelnutzer ändert sich dadurch nichts — er behält `graph/u/default/*`
 * und `data/docs|tasks|canvas`.
 */
export async function getWorkspaceContext(): Promise<WorkspaceContext> {
    const state = await getState();
    const { currentIdentity } = await import('./context');
    const identity = await currentIdentity();
    const userId = identity.userId || DEFAULT_USER_ID;
    if (userId !== DEFAULT_USER_ID) await ensureUserBootstrap(userId, identity.displayName);
    const iri = userId === state.iri.userId ? state.iri : createIriFactory(state.iri.instanceBase, userId);
    return {
        store: state.store,
        iri,
        paths: workspaceFilePathsFor(userId),
        runExclusive,
        persistSnapshot: () => writeSnapshot(state.store, createNodeFileSystem(), GRAPH_DIR(), state.iri.instanceBase),
    };
}

/** Nur für Tests: Singleton zurücksetzen. */
export function __resetServerGraphForTests(): void {
    delete globalState.__owGraphState;
}
