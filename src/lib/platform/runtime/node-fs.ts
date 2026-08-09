/**
 * FileSystemLike über node:fs/promises — der Datei-Adapter der Runtimes
 * `server` und `ha-addon`. Nur serverseitig importieren. Trägt seit M6
 * auch die Binär-Ebene (Git-Objekte).
 */

import { promises as fs } from 'fs';
import type { BinaryFileSystemLike } from './types';

export function createNodeFileSystem(): BinaryFileSystemLike {
    return {
        readFile: path => fs.readFile(path, 'utf-8'),
        writeFile: async (path, content) => {
            await fs.writeFile(path, content, 'utf-8');
        },
        readBytes: async path => new Uint8Array(await fs.readFile(path)),
        writeBytes: async (path, data) => {
            await fs.writeFile(path, data);
        },
        mkdir: async path => {
            await fs.mkdir(path, { recursive: true });
        },
        readdir: path => fs.readdir(path),
        exists: async path => {
            try {
                await fs.access(path);
                return true;
            } catch {
                return false;
            }
        },
        rm: async path => {
            await fs.rm(path, { force: true });
        },
        stat: async path => {
            const stats = await fs.stat(path);
            return { isDirectory: stats.isDirectory() };
        },
    };
}
