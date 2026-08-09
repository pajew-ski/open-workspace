/**
 * GitProvider über das Prozess-git der Maschine — die Git-Bindung der
 * Runtimes `server` und `ha-addon` (SPEC §5.2; beide teilen dasselbe
 * Container-Image, M12). Nur serverseitig importieren.
 *
 * Alle Aufrufe laufen ohne Terminal-Prompts (GIT_TERMINAL_PROMPT=0):
 * fehlende Credentials sind ein ehrlicher Fehler, kein hängender Prozess.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitAuthor, GitChange, GitCommitResult, GitProvider } from './types';

const execFileAsync = promisify(execFile);

const GIT_ENV = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
};

async function git(dir: string, args: string[]): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', args, {
            cwd: dir,
            env: GIT_ENV,
            maxBuffer: 32 * 1024 * 1024,
        });
        return stdout;
    } catch (error) {
        const err = error as { stderr?: string; stdout?: string; message?: string };
        const detail = (err.stderr ?? err.stdout ?? err.message ?? '').trim();
        throw new Error(`git ${args[0]} fehlgeschlagen: ${detail}`);
    }
}

function parseStatusState(x: string, y: string): GitChange['state'] {
    if (x === '?' && y === '?') return 'untracked';
    if (x === 'A' || y === 'A') return 'added';
    if (x === 'D' || y === 'D') return 'deleted';
    return 'modified';
}

export function createProcessGitProvider(): GitProvider {
    return {
        kind: 'process-git',

        async isRepo(dir) {
            try {
                await git(dir, ['rev-parse', '--git-dir']);
                return true;
            } catch {
                return false;
            }
        },

        async init(dir) {
            await git(dir, ['init', '--initial-branch=main']);
        },

        async head(dir) {
            try {
                return (await git(dir, ['rev-parse', 'HEAD'])).trim();
            } catch {
                return null;
            }
        },

        async status(dir) {
            const output = await git(dir, ['status', '--porcelain']);
            const changes: GitChange[] = [];
            for (const line of output.split('\n')) {
                if (line.trim() === '') continue;
                const x = line[0];
                const y = line[1];
                // Rename-Zeilen ("R  alt -> neu") auf den neuen Pfad kürzen.
                const rawPath = line.slice(3);
                const path = rawPath.includes(' -> ') ? rawPath.split(' -> ')[1] : rawPath;
                changes.push({ path: path.replace(/^"|"$/g, ''), state: parseStatusState(x, y) });
            }
            return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
        },

        async commitAll(dir, message, author: GitAuthor): Promise<GitCommitResult> {
            await git(dir, ['add', '-A']);
            const staged = (await git(dir, ['status', '--porcelain'])).trim();
            if (staged === '') {
                const sha = await this.head(dir);
                return { sha, committed: false };
            }
            await git(dir, [
                '-c', `user.name=${author.name}`,
                '-c', `user.email=${author.email}`,
                'commit', '-m', message,
            ]);
            const sha = (await git(dir, ['rev-parse', 'HEAD'])).trim();
            return { sha, committed: true };
        },

        async changedFiles(dir, fromSha, toSha) {
            const output = await git(dir, ['diff', '--name-only', fromSha, toSha]);
            return output.split('\n').filter(line => line.trim() !== '').sort();
        },

        async diff(dir, fromSha, toSha) {
            return git(dir, ['diff', fromSha, toSha]);
        },

        async push(dir, remoteUrl, branch) {
            await git(dir, ['push', remoteUrl, `HEAD:refs/heads/${branch}`]);
        },

        async pull(dir, remoteUrl, branch) {
            await git(dir, ['pull', '--ff-only', remoteUrl, branch]);
        },
    };
}
