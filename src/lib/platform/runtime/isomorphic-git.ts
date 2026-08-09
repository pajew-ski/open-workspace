/**
 * GitProvider über isomorphic-git — die Git-Bindung der Runtime `local`
 * (SPEC §5.2/§8.3): läuft über JEDES BinaryFileSystemLike (im Browser das
 * OPFS-Backing, in Tests das Memory-Double), ohne Prozess-git.
 *
 * Remote-Sync (push/pull) braucht einen HTTP-Client; im Browser ist er
 * CORS-abhängig (SPEC §8.3 — ehrliche Einschränkung, keine Fußnote).
 * Ohne übergebenen Client bietet der Provider push/pull nicht an —
 * lokale Commits, Status und Diffs funktionieren vollständig.
 */

import git from 'isomorphic-git';
import type { HttpClient } from 'isomorphic-git';
import type { BinaryFileSystemLike, GitAuthor, GitChange, GitCommitResult, GitProvider } from './types';

interface ShimStats {
    type: 'file' | 'dir';
    mode: number;
    size: number;
    ino: number;
    mtimeMs: number;
    ctimeMs: number;
    uid: number;
    gid: number;
    dev: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}

function unsupported(op: string): never {
    const error = new Error(`ENOSYS: ${op} wird von diesem Dateisystem nicht unterstützt`) as NodeJS.ErrnoException;
    error.code = 'ENOSYS';
    throw error;
}

interface IsoGitFsPromises {
    readFile(path: string, options?: string | { encoding?: string }): Promise<string | Uint8Array>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<ShimStats>;
    lstat(path: string): Promise<ShimStats>;
    readlink(path: string): Promise<never>;
    symlink(path: string): Promise<never>;
}

/**
 * node-fs-förmiger Shim über BinaryFileSystemLike. Größe und mtime kommen
 * aus den Frische-Signalen des Backings — ohne sie würde isomorphic-git
 * seinem Index-Cache vertrauen und inhaltsgleiche Stats als „unverändert"
 * lesen (Änderungen blieben unsichtbar).
 */
export function toIsomorphicGitFs(files: BinaryFileSystemLike): { promises: IsoGitFsPromises } {
    const stat = async (path: string): Promise<ShimStats> => {
        const result = await files.stat(path);
        const mtimeMs = result.mtimeMs ?? 0;
        return {
            type: result.isDirectory ? 'dir' : 'file',
            mode: result.isDirectory ? 0o40755 : 0o100644,
            size: result.isDirectory ? 0 : result.size ?? 0,
            ino: 0,
            mtimeMs,
            ctimeMs: mtimeMs,
            uid: 1,
            gid: 1,
            dev: 1,
            isFile: () => !result.isDirectory,
            isDirectory: () => result.isDirectory,
            isSymbolicLink: () => false,
        };
    };
    return {
        promises: {
            readFile: async (path: string, options?: string | { encoding?: string }) => {
                const encoding = typeof options === 'string' ? options : options?.encoding;
                return encoding === 'utf8' ? files.readFile(path) : files.readBytes(path);
            },
            writeFile: async (path: string, data: string | Uint8Array) => {
                if (typeof data === 'string') {
                    await files.writeFile(path, data);
                } else {
                    await files.writeBytes(path, data);
                }
            },
            unlink: (path: string) => files.rm(path),
            readdir: (path: string) => files.readdir(path),
            mkdir: (path: string) => files.mkdir(path),
            rmdir: (path: string) => files.rm(path),
            stat,
            lstat: stat,
            readlink: () => unsupported('readlink'),
            symlink: () => unsupported('symlink'),
        },
    };
}

function decodeBlob(blob: Uint8Array): string {
    return new TextDecoder().decode(blob);
}

/**
 * Minimaler zeilenbasierter Diff (LCS): reicht für die deterministisch
 * sortierten Snapshot-Dateien und bleibt menschenlesbar. Prozess-git
 * liefert für `server`/`ha-addon` den vollen `git diff`.
 */
export function simpleLineDiff(before: string, after: string): string {
    const a = before === '' ? [] : before.split('\n');
    const b = after === '' ? [] : after.split('\n');
    const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const out: string[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            i += 1;
            j += 1;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            out.push(`-${a[i]}`);
            i += 1;
        } else {
            out.push(`+${b[j]}`);
            j += 1;
        }
    }
    while (i < a.length) {
        out.push(`-${a[i]}`);
        i += 1;
    }
    while (j < b.length) {
        out.push(`+${b[j]}`);
        j += 1;
    }
    return out.join('\n');
}

export function createIsomorphicGitProvider(
    files: BinaryFileSystemLike,
    options: { http?: HttpClient } = {},
): GitProvider {
    const fs = toIsomorphicGitFs(files);

    const readBlobAt = async (dir: string, sha: string, filepath: string): Promise<string | null> => {
        try {
            const { blob } = await git.readBlob({ fs, dir, oid: sha, filepath });
            return decodeBlob(blob);
        } catch {
            return null;
        }
    };

    const changedBetween = async (dir: string, fromSha: string, toSha: string): Promise<string[]> => {
        const changed = await git.walk({
            fs,
            dir,
            trees: [git.TREE({ ref: fromSha }), git.TREE({ ref: toSha })],
            map: async (filepath, [a, b]) => {
                if (filepath === '.') return undefined;
                const typeA = a ? await a.type() : undefined;
                const typeB = b ? await b.type() : undefined;
                if (typeA === 'tree' || typeB === 'tree') return undefined;
                const oidA = a ? await a.oid() : undefined;
                const oidB = b ? await b.oid() : undefined;
                return oidA === oidB ? undefined : filepath;
            },
        }) as Array<string | undefined>;
        return changed.filter((entry): entry is string => entry !== undefined).sort();
    };

    const provider: GitProvider = {
        kind: 'isomorphic-git',

        async isRepo(dir) {
            try {
                await git.resolveRef({ fs, dir, ref: 'HEAD', depth: 2 });
                return true;
            } catch {
                return files.exists(`${dir.replace(/\/$/, '')}/.git`);
            }
        },

        async init(dir) {
            await git.init({ fs, dir, defaultBranch: 'main' });
        },

        async head(dir) {
            try {
                return await git.resolveRef({ fs, dir, ref: 'HEAD' });
            } catch {
                return null;
            }
        },

        async status(dir) {
            const matrix = await git.statusMatrix({ fs, dir });
            const changes: GitChange[] = [];
            for (const [filepath, headState, workdirState, stageState] of matrix) {
                if (headState === 1 && workdirState === 1 && stageState === 1) continue;
                let state: GitChange['state'];
                if (headState === 0 && workdirState === 2 && stageState === 0) {
                    state = 'untracked';
                } else if (headState === 0) {
                    state = 'added';
                } else if (workdirState === 0) {
                    state = 'deleted';
                } else {
                    state = 'modified';
                }
                changes.push({ path: filepath, state });
            }
            return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
        },

        async commitAll(dir, message, author: GitAuthor): Promise<GitCommitResult> {
            const matrix = await git.statusMatrix({ fs, dir });
            let dirty = false;
            for (const [filepath, headState, workdirState, stageState] of matrix) {
                if (headState === 1 && workdirState === 1 && stageState === 1) continue;
                dirty = true;
                if (workdirState === 0) {
                    await git.remove({ fs, dir, filepath });
                } else {
                    await git.add({ fs, dir, filepath });
                }
            }
            if (!dirty) {
                return { sha: await provider.head(dir), committed: false };
            }
            const sha = await git.commit({ fs, dir, message, author });
            return { sha, committed: true };
        },

        changedFiles: changedBetween,

        async diff(dir, fromSha, toSha) {
            const sections: string[] = [];
            for (const filepath of await changedBetween(dir, fromSha, toSha)) {
                const before = (await readBlobAt(dir, fromSha, filepath)) ?? '';
                const after = (await readBlobAt(dir, toSha, filepath)) ?? '';
                sections.push(`--- a/${filepath}\n+++ b/${filepath}\n${simpleLineDiff(before, after)}`);
            }
            return sections.join('\n');
        },
    };

    if (options.http) {
        const http = options.http;
        provider.push = async (dir, remoteUrl, branch) => {
            await git.push({ fs, http, dir, url: remoteUrl, ref: 'HEAD', remoteRef: `refs/heads/${branch}` });
        };
        provider.pull = async (dir, remoteUrl, branch) => {
            await git.pull({
                fs,
                http,
                dir,
                url: remoteUrl,
                ref: branch,
                fastForwardOnly: true,
                author: { name: 'Open Workspace', email: 'graph-backup@open-workspace.local' },
            });
        };
    }

    return provider;
}
