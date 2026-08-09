// @vitest-environment node
/**
 * Git-Schicht des Git-Syncs (SPEC §8, M6): EINE Erwartung, zwei
 * Bindungen — Prozess-git (Runtimes `server`/`ha-addon`, dasselbe Image)
 * und isomorphic-git über FileSystemLike (Runtime `local`). Damit ist
 * „In jeder Runtime führt eine Änderung zu einem minimalen, lesbaren
 * Diff" auf der Git-Ebene für alle drei Runtimes abgedeckt.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BinaryFileSystemLike, GitProvider } from '../../src/lib/platform/runtime/types';
import { createNodeFileSystem } from '../../src/lib/platform/runtime/node-fs';
import { createMemoryFileSystem } from '../../src/lib/platform/runtime/memfs';
import { createProcessGitProvider } from '../../src/lib/platform/runtime/process-git';
import { createIsomorphicGitProvider, simpleLineDiff } from '../../src/lib/platform/runtime/isomorphic-git';

const AUTHOR = { name: 'Open Workspace', email: 'graph-backup@open-workspace.local' };

interface Binding {
    name: string;
    setup(): Promise<{ files: BinaryFileSystemLike; git: GitProvider; dir: string }>;
}

const bindings: Binding[] = [
    {
        name: 'process-git (server/ha-addon)',
        setup: async () => {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-git-'));
            return { files: createNodeFileSystem(), git: createProcessGitProvider(), dir };
        },
    },
    {
        name: 'isomorphic-git über FileSystemLike (local)',
        setup: async () => {
            const files = createMemoryFileSystem();
            const dir = '/repo';
            await files.mkdir(dir);
            return { files, git: createIsomorphicGitProvider(files), dir };
        },
    },
];

describe.each(bindings)('GitProvider: $name', binding => {
    let files: BinaryFileSystemLike;
    let git: GitProvider;
    let dir: string;

    beforeEach(async () => {
        ({ files, git, dir } = await binding.setup());
    });

    it('init ist idempotent; head ist ohne Commits null', async () => {
        expect(await git.isRepo(dir)).toBe(false);
        await git.init(dir);
        await git.init(dir);
        expect(await git.isRepo(dir)).toBe(true);
        expect(await git.head(dir)).toBeNull();
    });

    it('commitAll committet alles; sauberer Baum ist ein No-Op', async () => {
        await git.init(dir);
        await files.writeFile(`${dir}/workspace.nq`, '<urn:s> <urn:p> "a" <urn:g> .\n');
        await files.mkdir(`${dir}/import`);
        await files.writeFile(`${dir}/import/quelle.nq`, '<urn:x> <urn:y> "z" <urn:g2> .\n');

        const first = await git.commitAll(dir, 'Backup 1', AUTHOR);
        expect(first.committed).toBe(true);
        expect(first.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(await git.head(dir)).toBe(first.sha);

        const noop = await git.commitAll(dir, 'Backup 2', AUTHOR);
        expect(noop.committed).toBe(false);
        expect(noop.sha).toBe(first.sha);
    });

    it('status meldet Änderungen relativ zu HEAD', async () => {
        await git.init(dir);
        await files.writeFile(`${dir}/a.nq`, 'eins\n');
        await files.writeFile(`${dir}/b.nq`, 'zwei\n');
        await git.commitAll(dir, 'Basis', AUTHOR);

        await files.writeFile(`${dir}/a.nq`, 'eins geändert\n');
        await files.writeFile(`${dir}/c.nq`, 'drei\n');
        await files.rm(`${dir}/b.nq`);

        const status = await git.status(dir);
        expect(status).toEqual([
            { path: 'a.nq', state: 'modified' },
            { path: 'b.nq', state: 'deleted' },
            { path: 'c.nq', state: 'untracked' },
        ]);
    });

    it('Abnahme M6: eine Änderung ergibt einen minimalen, lesbaren Diff', async () => {
        await git.init(dir);
        const lines = [
            '<urn:doc-1> <urn:titel> "Erster Eintrag" <urn:g> .',
            '<urn:doc-2> <urn:titel> "Zweiter Eintrag" <urn:g> .',
            '<urn:doc-3> <urn:titel> "Dritter Eintrag" <urn:g> .',
        ];
        await files.writeFile(`${dir}/workspace.nq`, `${lines.join('\n')}\n`);
        await files.writeFile(`${dir}/meta.nq`, '<urn:meta> <urn:p> "unverändert" <urn:g> .\n');
        const first = await git.commitAll(dir, 'Backup 1', AUTHOR);

        const changed = [...lines];
        changed[1] = '<urn:doc-2> <urn:titel> "Zweiter Eintrag, bearbeitet" <urn:g> .';
        await files.writeFile(`${dir}/workspace.nq`, `${changed.join('\n')}\n`);
        const second = await git.commitAll(dir, 'Backup 2', AUTHOR);

        expect(await git.changedFiles(dir, first.sha!, second.sha!)).toEqual(['workspace.nq']);

        const diff = await git.diff(dir, first.sha!, second.sha!);
        expect(diff).toContain('-<urn:doc-2> <urn:titel> "Zweiter Eintrag" <urn:g> .');
        expect(diff).toContain('+<urn:doc-2> <urn:titel> "Zweiter Eintrag, bearbeitet" <urn:g> .');
        // Minimal: unveränderte Aussagen tauchen nicht als +/--Zeilen auf.
        expect(diff).not.toMatch(/^[+-]<urn:doc-1>/m);
        expect(diff).not.toMatch(/^[+-]<urn:doc-3>/m);
        expect(diff).not.toContain('meta.nq');
    });
});

describe('Remote-Sync (Prozess-git, lokales Bare-Repo als Gegenstelle)', () => {
    it('push und ff-only-pull transportieren Commits', async () => {
        const git = createProcessGitProvider();
        const files = createNodeFileSystem();
        const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-git-remote-'));
        const bare = path.join(base, 'remote.git');
        const work = path.join(base, 'work');
        const clone = path.join(base, 'clone');
        await fs.mkdir(bare, { recursive: true });
        await fs.mkdir(work, { recursive: true });
        await fs.mkdir(clone, { recursive: true });
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const run = promisify(execFile);
        await run('git', ['init', '--bare', '--initial-branch=main'], { cwd: bare });

        await git.init(work);
        await files.writeFile(`${work}/workspace.nq`, 'stand eins\n');
        await git.commitAll(work, 'Backup 1', AUTHOR);
        await git.push!(work, bare, 'main');

        await git.init(clone);
        await git.pull!(clone, bare, 'main');
        expect(await files.readFile(`${clone}/workspace.nq`)).toBe('stand eins\n');
        expect(await git.head(clone)).toBe(await git.head(work));
    });
});

describe('simpleLineDiff', () => {
    it('liefert nur die tatsächlich geänderten Zeilen', () => {
        const diff = simpleLineDiff('a\nb\nc', 'a\nB\nc');
        expect(diff).toBe('-b\n+B');
        expect(simpleLineDiff('gleich', 'gleich')).toBe('');
    });
});
