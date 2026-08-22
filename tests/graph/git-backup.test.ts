// @vitest-environment node
/**
 * Abnahme M6 (Git-Sync, SPEC §8): `git-backup` als regulärer Connector
 * über den EINEN Vertrag, in beiden Git-Bindungen (Prozess-git für
 * `server`/`ha-addon`, isomorphic-git über FileSystemLike für `local`):
 *
 *  - Eine Änderung führt zu einem minimalen, lesbaren Diff (Backup-Commit).
 *  - Eine externe Edit an einer .ttl-/.nq-Datei kommt beim nächsten Pull
 *    im Store an — fremde Dateien im Import-Graphen, Snapshot-Dateien als
 *    Restore ihrer kanonischen Graphen.
 *  - Modus `backup` ist eine Einbahnstraße (Pull lehnt ehrlich ab);
 *    Modus `bidirectional` folgt der Konfliktregel §6.2 beim Push.
 *  - `acl` (und alles nicht Snapshot-fähige) ist nie wiederherstellbar.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { promises as nodeFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Quad } from '@rdfjs/types';
import type { BinaryFileSystemLike, GitProvider, RuntimeAdapter } from '../../src/lib/platform/runtime/types';
import { createNodeFileSystem } from '../../src/lib/platform/runtime/node-fs';
import { createMemoryFileSystem } from '../../src/lib/platform/runtime/memfs';
import { createProcessGitProvider } from '../../src/lib/platform/runtime/process-git';
import { createIsomorphicGitProvider } from '../../src/lib/platform/runtime/isomorphic-git';
import { OxigraphStore } from '../../src/lib/graph/store/oxigraph';
import { createIriFactory, urnInstanceBase, DEFAULT_USER_ID } from '../../src/lib/graph/iri';
import { namedNode } from '../../src/lib/graph/rdf';
import { writeWorkspaceToStore } from '../../src/lib/graph/workspace/crud';
import type { WorkspaceSnapshotInput } from '../../src/lib/graph/migrate/from-files';
import { createConnector, getConnector, type GraphHandle } from '../../src/lib/graph/connectors/registry';
import { pushConnector, syncConnector } from '../../src/lib/graph/connectors/sync';
import { gitBackupConnector, type GitBackupConfig } from '../../src/lib/graph/connectors/git-backup';

const INSTANCE = urnInstanceBase('00000000-0000-4000-8000-0000000000aa');

function fixture(title = 'Erster Eintrag'): WorkspaceSnapshotInput {
    return {
        docs: [
            {
                id: 'doc-1', slug: 'erster-eintrag', title, content: 'Inhalt eins.',
                tags: [], inLanguage: 'de',
                createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-02T10:00:00.000Z',
            },
            {
                id: 'doc-2', slug: 'zweiter-eintrag', title: 'Zweiter Eintrag', content: 'Inhalt zwei.',
                tags: [], inLanguage: 'de',
                createdAt: '2026-01-03T10:00:00.000Z', updatedAt: '2026-01-03T10:00:00.000Z',
            },
        ],
        tasks: [], projects: [], canvases: [],
        calendars: [], events: [], conversations: [],
    };
}

interface Binding {
    name: string;
    setup(): Promise<{ files: BinaryFileSystemLike; git: GitProvider; repoDir: string }>;
}

const tmpRoots: string[] = [];

const bindings: Binding[] = [
    {
        name: 'process-git (server/ha-addon)',
        setup: async () => {
            const base = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'ow-backup-'));
            tmpRoots.push(base);
            process.env.OW_GIT_ROOTS = base;
            return { files: createNodeFileSystem(), git: createProcessGitProvider(), repoDir: path.join(base, 'repo') };
        },
    },
    {
        name: 'isomorphic-git über FileSystemLike (local)',
        setup: async () => {
            const files = createMemoryFileSystem();
            process.env.OW_GIT_ROOTS = '/backup';
            return { files, git: createIsomorphicGitProvider(files), repoDir: '/backup/repo' };
        },
    },
];

const originalGitRoots = process.env.OW_GIT_ROOTS;
afterAll(() => {
    if (originalGitRoots === undefined) {
        delete process.env.OW_GIT_ROOTS;
    } else {
        process.env.OW_GIT_ROOTS = originalGitRoots;
    }
});

function testRuntime(store: OxigraphStore, files: BinaryFileSystemLike, git: GitProvider): RuntimeAdapter {
    return {
        id: 'server',
        store: async () => store,
        files: () => files,
        git: () => git,
        auth: () => ({ identity: async () => ({ userId: DEFAULT_USER_ID, groups: [] }) }),
        secrets: () => ({
            get: async () => null,
            set: async () => {
                throw new Error('nicht unterstützt');
            },
        }),
        capabilities: {
            sparqlEndpoint: false,
            mcpServer: false,
            federationOutbound: false,
            federationInbound: false,
            multiUser: false,
            reasoningTier: 'rl',
            causalTier: 'graph',
        },
    };
}

async function registerBackup(handle: GraphHandle, config: GitBackupConfig): Promise<string> {
    const view = await createConnector(handle, {
        id: 'backup-1',
        name: 'Backup',
        kind: 'git-backup',
        locator: gitBackupConnector.locatorFor(config),
    });
    return view.id;
}

async function dumpGraph(handle: GraphHandle, graphIri: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of handle.store.dump(namedNode(graphIri))) {
        quads.push(q);
    }
    return quads;
}

describe.each(bindings)('git-backup über $name', binding => {
    let files: BinaryFileSystemLike;
    let git: GitProvider;
    let repoDir: string;
    let handle: GraphHandle;
    let runtime: RuntimeAdapter;

    beforeEach(async () => {
        ({ files, git, repoDir } = await binding.setup());
        const store = new OxigraphStore();
        const iri = createIriFactory(INSTANCE);
        handle = { store, iri };
        await writeWorkspaceToStore(store, iri, fixture());
        runtime = testRuntime(store, files, git);
    });

    it('Abnahme: Backup-Commits, eine Änderung ⇒ minimaler lesbarer Diff', async () => {
        const id = await registerBackup(handle, { path: repoDir, mode: 'backup', branch: 'main' });

        const first = await pushConnector(handle, id, { files, runtime });
        expect(first.status).toBe('pushed');
        const firstSha = await git.head(repoDir);
        expect(firstSha).toMatch(/^[0-9a-f]{40}$/);
        expect(await files.exists(`${repoDir}/workspace.nq`)).toBe(true);
        expect(await files.exists(`${repoDir}/manifest.json`)).toBe(true);

        // Unveränderter Store ⇒ zweites Backup committet nichts.
        const unchanged = await pushConnector(handle, id, { files, runtime });
        expect(unchanged.status).toBe('pushed');
        expect(await git.head(repoDir)).toBe(firstSha);

        // Eine Änderung: doc-1 bekommt einen neuen Titel.
        await writeWorkspaceToStore(handle.store, handle.iri, fixture('Erster Eintrag, überarbeitet'));
        const second = await pushConnector(handle, id, { files, runtime });
        expect(second.status).toBe('pushed');
        const secondSha = await git.head(repoDir);
        expect(secondSha).not.toBe(firstSha);

        expect(await git.changedFiles(repoDir, firstSha!, secondSha!)).toEqual(['manifest.json', 'workspace.nq']);
        const diff = await git.diff(repoDir, firstSha!, secondSha!);
        expect(diff).toContain('"Erster Eintrag"@de');
        expect(diff).toContain('"Erster Eintrag, überarbeitet"@de');
        // Minimal: die unveränderte Entität taucht in keiner +/−-Zeile auf.
        expect(diff).not.toMatch(/^[+-].*doc-2/m);
        expect(diff).not.toMatch(/^[+-].*Zweiter Eintrag/m);
    });

    it('Abnahme: externe .ttl-Datei kommt beim nächsten Pull im Store an (bidirectional)', async () => {
        await files.mkdir(repoDir);
        await files.writeFile(
            `${repoDir}/notizen.ttl`,
            '@prefix schema: <https://schema.org/> .\n<urn:extern:notiz-1> schema:name "Externe Notiz" .\n',
        );
        const id = await registerBackup(handle, { path: repoDir, mode: 'bidirectional', branch: 'main' });

        const sync = await syncConnector(handle, id, { files, runtime });
        expect(sync.status).toBe('imported');
        expect(sync.quarantined).toEqual([]);
        const imported = await dumpGraph(handle, handle.iri.importGraph(id));
        expect(imported.some(q =>
            q.subject.value === 'urn:extern:notiz-1' && q.object.value === 'Externe Notiz',
        )).toBe(true);

        // Unverändertes Repo ⇒ No-Op (Inhalts-Revision, SPEC §6.2).
        const again = await syncConnector(handle, id, { files, runtime });
        expect(again.status).toBe('noop');
    });

    it('Abnahme: externe Edit an einer Snapshot-Datei stellt den kanonischen Graphen wieder her', async () => {
        const id = await registerBackup(handle, { path: repoDir, mode: 'bidirectional', branch: 'main' });

        // Erstes Backup in ein leeres Verzeichnis ist erlaubt (kein fremder Stand).
        const push = await pushConnector(handle, id, { files, runtime });
        expect(push.status).toBe('pushed');

        // Externe Edit: Titel von doc-1 direkt in workspace.nq umschreiben.
        const workspaceNq = await files.readFile(`${repoDir}/workspace.nq`);
        expect(workspaceNq).toContain('"Erster Eintrag"@de');
        await files.writeFile(
            `${repoDir}/workspace.nq`,
            workspaceNq.replace('"Erster Eintrag"@de', '"Extern editierter Eintrag"@de'),
        );
        await git.commitAll(repoDir, 'Externe Edit', { name: 'Extern', email: 'extern@example.org' });

        const sync = await syncConnector(handle, id, { files, runtime });
        expect(sync.status).toBe('imported');
        expect(sync.restoredGraphs).toContain(handle.iri.graph('workspace'));
        const workspace = await dumpGraph(handle, handle.iri.graph('workspace'));
        expect(workspace.some(q => q.object.value === 'Extern editierter Eintrag')).toBe(true);
        expect(workspace.some(q => q.object.value === 'Erster Eintrag')).toBe(false);
        // Unbeteiligte Aussagen bleiben erhalten.
        expect(workspace.some(q => q.object.value === 'Zweiter Eintrag')).toBe(true);
    });

    it('Konfliktregel §6.2: Push nach externer Änderung ohne Sync wird verweigert', async () => {
        const id = await registerBackup(handle, { path: repoDir, mode: 'bidirectional', branch: 'main' });
        await pushConnector(handle, id, { files, runtime });

        await files.writeFile(`${repoDir}/fremd.ttl`, '<urn:x> <urn:y> "extern" .\n');

        const conflict = await pushConnector(handle, id, { files, runtime });
        expect(conflict.status).toBe('conflict');
        expect(conflict.conflicts.length).toBeGreaterThan(0);
        expect((await getConnector(handle, id))?.syncState).toBe('conflict');
        // Nichts geschrieben: die fremde Datei liegt unverändert im Repo.
        expect(await files.readFile(`${repoDir}/fremd.ttl`)).toBe('<urn:x> <urn:y> "extern" .\n');

        // Sync holt die Änderung, danach geht der Push wieder durch.
        const sync = await syncConnector(handle, id, { files, runtime });
        expect(sync.status).toBe('imported');
        const retry = await pushConnector(handle, id, { files, runtime });
        expect(retry.status).toBe('pushed');
    });

    it('Modus „backup" ist eine Einbahnstraße: Sync lehnt ehrlich ab', async () => {
        await files.mkdir(repoDir);
        await files.writeFile(`${repoDir}/notizen.ttl`, '<urn:a> <urn:b> "c" .\n');
        const id = await registerBackup(handle, { path: repoDir, mode: 'backup', branch: 'main' });
        const sync = await syncConnector(handle, id, { files, runtime });
        expect(sync.status).toBe('failed');
        expect(sync.message).toContain('Einbahnstraße');
    });

    it('acl ist nie wiederherstellbar (Sicherheitsfilter des Runners)', async () => {
        await files.mkdir(repoDir);
        const aclIri = `${INSTANCE}graph/acl`;
        await files.writeFile(`${repoDir}/acl.nq`, `<urn:s> <urn:p> "geheim" <${aclIri}> .\n`);
        await files.writeFile(`${repoDir}/manifest.json`, `${JSON.stringify({
            schemaVersion: 2,
            canonicalization: 'RDFC-1.0',
            instanceBase: INSTANCE,
            graphs: [{ iri: aclIri, file: 'acl.nq', quads: 1, sha256: 'x' }],
        }, null, 2)}\n`);
        const id = await registerBackup(handle, { path: repoDir, mode: 'bidirectional', branch: 'main' });

        const sync = await syncConnector(handle, id, { files, runtime });
        expect(sync.status).toBe('imported');
        expect(sync.restoredGraphs).toEqual([]);
        expect(sync.quarantined.some(entry => entry.source === 'acl.nq')).toBe(true);
        const graphs = (await handle.store.graphs()).map(g => g.value);
        expect(graphs).not.toContain(aclIri);
    });
});

describe('Backup-Ziel innerhalb eines fremden Repos (Issue #32)', () => {
    /**
     * Der Weg, den diese Prüfung schließt: `isRepo()` fragt Git, ob der
     * Pfad in einem Working Tree liegt — unter einem Checkout ist die
     * Antwort ja, wegen des UMGEBENDEN Repos. `push` überspringt dann
     * `init()`, und `git add -A` + `commit` legen den Graphen samt
     * `acl.nq` im fremden Repo ab. Steht dessen Remote auf einem
     * öffentlichen `origin`, ist der Rest ein Lauf ohne Rückfrage.
     */
    it('lehnt ab, statt in das umgebende Repo zu committen', async () => {
        const base = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'ow-fremd-'));
        tmpRoots.push(base);
        process.env.OW_GIT_ROOTS = base;
        const files = createNodeFileSystem();
        const git = createProcessGitProvider();
        await git.init(base);

        const nested = path.join(base, 'data', 'graph');
        await files.mkdir(nested);
        expect(await git.isRepo(nested)).toBe(true);        // das fremde Repo
        expect(await files.exists(`${nested}/.git`)).toBe(false);

        const store = new OxigraphStore();
        const iri = createIriFactory(INSTANCE);
        const handle: GraphHandle = { store, iri };
        await writeWorkspaceToStore(store, iri, fixture());
        const runtime = testRuntime(store, files, git);
        const id = await registerBackup(handle, { path: nested, mode: 'backup', branch: 'main' });

        const receipt = await pushConnector(handle, id, { files, runtime });
        expect(receipt.status).toBe('failed');
        expect(receipt.message).toMatch(/fremden Git-Repositories/);
        // Und zwar VOR dem ersten Byte: kein Snapshot, kein Commit.
        expect(await files.exists(`${nested}/workspace.nq`)).toBe(false);
        expect(await git.head(base)).toBeNull();
    });

    it('lässt ein eigenes Repository am selben Ort zu', async () => {
        const base = await nodeFs.mkdtemp(path.join(os.tmpdir(), 'ow-eigen-'));
        tmpRoots.push(base);
        process.env.OW_GIT_ROOTS = base;
        const files = createNodeFileSystem();
        const git = createProcessGitProvider();
        await git.init(base);

        const nested = path.join(base, 'backup');
        await files.mkdir(nested);
        await git.init(nested);                              // eigenes .git am Ziel

        const store = new OxigraphStore();
        const iri = createIriFactory(INSTANCE);
        const handle: GraphHandle = { store, iri };
        await writeWorkspaceToStore(store, iri, fixture());
        const runtime = testRuntime(store, files, git);
        const id = await registerBackup(handle, { path: nested, mode: 'backup', branch: 'main' });

        const receipt = await pushConnector(handle, id, { files, runtime });
        expect(receipt.status).toBe('pushed');
        expect(await git.head(nested)).toMatch(/^[0-9a-f]{40}$/);
        // Das umgebende Repo bleibt unberührt.
        expect(await git.head(base)).toBeNull();
    });
});

describe('git-backup Locator ↔ Konfiguration', () => {
    it('ist verlustfrei (Invariante 6)', () => {
        const config: GitBackupConfig = {
            path: 'data/backup',
            mode: 'bidirectional',
            remote: 'https://git.example.org/backup.git',
            branch: 'sicherung',
        };
        const locator = gitBackupConnector.locatorFor(config);
        expect(gitBackupConnector.configFromLocator(locator)).toEqual(config);
        const minimal: GitBackupConfig = { path: 'data/graph', mode: 'backup', branch: 'main' };
        expect(gitBackupConnector.configFromLocator(gitBackupConnector.locatorFor(minimal))).toEqual(minimal);
    });
});
