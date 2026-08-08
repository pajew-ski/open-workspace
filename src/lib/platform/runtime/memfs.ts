/**
 * FileSystemLike im Speicher — für Tests und als Grundlage des
 * OPFS-Adapters der Runtime `local` (M6).
 */

import type { FileSystemLike } from './types';

export function createMemoryFileSystem(): FileSystemLike & { files: Map<string, string> } {
    const files = new Map<string, string>();
    const dirs = new Set<string>();

    const normalize = (path: string) => path.replace(/\/+$/, '');

    return {
        files,
        readFile: async path => {
            const content = files.get(normalize(path));
            if (content === undefined) throw new Error(`ENOENT: ${path}`);
            return content;
        },
        writeFile: async (path, content) => {
            files.set(normalize(path), content);
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
            files.delete(normalize(path));
        },
    };
}
