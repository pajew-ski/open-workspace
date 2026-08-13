/**
 * FileSystemLike im Speicher — für Tests und als Grundlage des
 * OPFS-Adapters der Runtime `local`. Trägt die Binär-Ebene (M6,
 * Git-Objekte) und wirft Fehler mit `code`-Feld (ENOENT), wie es
 * isomorphic-git von einem fs erwartet.
 */

import type { BinaryFileSystemLike } from './types';

function enoent(path: string): NodeJS.ErrnoException {
    const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    return error;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function createMemoryFileSystem(): BinaryFileSystemLike & { files: Map<string, string | Uint8Array> } {
    const files = new Map<string, string | Uint8Array>();
    const dirs = new Set<string>();
    // Monoton wachsende Schreib-Uhr als mtime-Ersatz: jede Änderung macht
    // Stat-Caches (isomorphic-git-Index) nachweislich stale. Schrittweite
    // 1000 ms, weil Git-Index-Vergleiche auf SEKUNDEN runden — feinere
    // Schritte fielen auf 0 zusammen und Änderungen blieben unsichtbar.
    let writeClock = 0;
    const mtimes = new Map<string, number>();
    const touch = (path: string) => {
        writeClock += 1000;
        mtimes.set(path, writeClock);
    };

    // Löst '.'/'..'-Segmente und doppelte Trenner auf — isomorphic-git
    // erzeugt Pfade wie `<dir>/.` (Walker-Wurzel).
    const normalize = (path: string) => {
        const absolute = path.startsWith('/');
        const segments: string[] = [];
        for (const segment of path.split('/')) {
            if (segment === '' || segment === '.') continue;
            if (segment === '..') {
                segments.pop();
                continue;
            }
            segments.push(segment);
        }
        return (absolute ? '/' : '') + segments.join('/');
    };

    return {
        files,
        readFile: async path => {
            const content = files.get(normalize(path));
            if (content === undefined) throw enoent(path);
            return typeof content === 'string' ? content : textDecoder.decode(content);
        },
        writeFile: async (path, content) => {
            const normalized = normalize(path);
            files.set(normalized, content);
            touch(normalized);
        },
        appendFile: async (path, content) => {
            const normalized = normalize(path);
            const existing = files.get(normalized);
            const before = existing === undefined
                ? ''
                : typeof existing === 'string' ? existing : textDecoder.decode(existing);
            files.set(normalized, before + content);
            touch(normalized);
        },
        readBytes: async path => {
            const content = files.get(normalize(path));
            if (content === undefined) throw enoent(path);
            return typeof content === 'string' ? textEncoder.encode(content) : content;
        },
        writeBytes: async (path, data) => {
            const normalized = normalize(path);
            files.set(normalized, data);
            touch(normalized);
        },
        mkdir: async path => {
            dirs.add(normalize(path));
        },
        readdir: async path => {
            const prefix = `${normalize(path)}/`;
            const entries = new Set<string>();
            for (const file of files.keys()) {
                if (file.startsWith(prefix)) {
                    entries.add(file.slice(prefix.length).split('/')[0]);
                }
            }
            for (const dir of dirs) {
                if (dir.startsWith(prefix)) {
                    entries.add(dir.slice(prefix.length).split('/')[0]);
                }
            }
            return [...entries];
        },
        exists: async path => {
            const normalized = normalize(path);
            if (files.has(normalized) || dirs.has(normalized)) return true;
            const prefix = `${normalized}/`;
            for (const file of files.keys()) {
                if (file.startsWith(prefix)) return true;
            }
            return false;
        },
        rm: async path => {
            const normalized = normalize(path);
            files.delete(normalized);
            mtimes.delete(normalized);
        },
        stat: async path => {
            const normalized = normalize(path);
            const content = files.get(normalized);
            if (content !== undefined) {
                const size = typeof content === 'string' ? textEncoder.encode(content).length : content.length;
                return { isDirectory: false, size, mtimeMs: mtimes.get(normalized) ?? 0 };
            }
            if (dirs.has(normalized)) return { isDirectory: true };
            const prefix = `${normalized}/`;
            for (const file of files.keys()) {
                if (file.startsWith(prefix)) return { isDirectory: true };
            }
            throw enoent(path);
        },
    };
}
