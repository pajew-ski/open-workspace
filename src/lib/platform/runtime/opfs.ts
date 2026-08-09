/**
 * FileSystemLike über das Origin Private File System (SPEC §5.2/§8.3, M12).
 *
 * Das ist das Datei-Backing der Runtime `local`: derselbe Vertrag wie
 * node:fs (`BinaryFileSystemLike`), damit Snapshot-Schreiber, Vault-Import
 * und isomorphic-git im Browser unverändert laufen — inklusive der
 * Frische-Signale `size`/`mtimeMs`, ohne die isomorphic-git seinem
 * Index-Cache glaubt und Änderungen übersieht (M6).
 *
 * OPFS kennt keine Pfade, nur verschachtelte Verzeichnis-Handles. Die
 * Übersetzung Pfad → Handle-Kette passiert hier — und nur hier.
 *
 * Fehler tragen `code: 'ENOENT'`, weil isomorphic-git genau darauf prüft.
 */

import type { BinaryFileSystemLike } from './types';

/**
 * Ausschnitt der OPFS-Handles, den dieser Adapter braucht. Eigene Typen,
 * weil die DOM-Typen der Toolchain die Iterator-Methoden nicht kennen und
 * weil Tests dieselben Formen ohne Browser bereitstellen können.
 */
export interface OpfsFileHandle {
    getFile(): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; size: number; lastModified: number }>;
    createWritable(): Promise<{ write(data: string | Uint8Array): Promise<void>; close(): Promise<void> }>;
}

export interface OpfsDirectoryHandle {
    getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
    removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
    keys(): AsyncIterableIterator<string>;
}

type DirectoryHandle = OpfsDirectoryHandle;

interface OpfsError extends Error {
    code?: string;
}

function enoent(path: string): OpfsError {
    const error = new Error(`ENOENT: ${path}`) as OpfsError;
    error.code = 'ENOENT';
    return error;
}

function splitPath(path: string): string[] {
    const segments: string[] = [];
    for (const segment of path.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') {
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    return segments;
}

/**
 * @param root Wurzel-Verzeichnis. Ohne Angabe `navigator.storage.getDirectory()`
 *             — die Injektion existiert für Tests und für Unterverzeichnisse
 *             als eigene „Laufwerke".
 */
export function createOpfsFileSystem(root: DirectoryHandle | (() => Promise<DirectoryHandle>)): BinaryFileSystemLike {
    const getRoot = typeof root === 'function' ? root : async () => root;

    async function resolveDirectory(segments: string[], create: boolean): Promise<DirectoryHandle | null> {
        let handle = await getRoot();
        for (const segment of segments) {
            try {
                handle = await handle.getDirectoryHandle(segment, { create });
            } catch {
                return null;
            }
        }
        return handle;
    }

    async function resolveFile(path: string, create: boolean): Promise<OpfsFileHandle | null> {
        const segments = splitPath(path);
        const name = segments.pop();
        if (!name) return null;
        const directory = await resolveDirectory(segments, create);
        if (!directory) return null;
        try {
            return await directory.getFileHandle(name, { create });
        } catch {
            return null;
        }
    }

    async function write(path: string, data: string | Uint8Array): Promise<void> {
        const handle = await resolveFile(path, true);
        if (!handle) throw enoent(path);
        const writable = await handle.createWritable();
        try {
            await writable.write(data);
        } finally {
            await writable.close();
        }
    }

    return {
        readFile: async path => {
            const handle = await resolveFile(path, false);
            if (!handle) throw enoent(path);
            return (await handle.getFile()).text();
        },
        writeFile: (path, content) => write(path, content),
        readBytes: async path => {
            const handle = await resolveFile(path, false);
            if (!handle) throw enoent(path);
            return new Uint8Array(await (await handle.getFile()).arrayBuffer());
        },
        writeBytes: (path, data) => write(path, data),
        mkdir: async path => {
            const directory = await resolveDirectory(splitPath(path), true);
            if (!directory) throw enoent(path);
        },
        readdir: async path => {
            const directory = await resolveDirectory(splitPath(path), false);
            if (!directory) throw enoent(path);
            const names: string[] = [];
            for await (const name of directory.keys()) names.push(name);
            return names;
        },
        exists: async path => {
            const segments = splitPath(path);
            if (segments.length === 0) return true;
            const name = segments.pop() as string;
            const parent = await resolveDirectory(segments, false);
            if (!parent) return false;
            try {
                await parent.getFileHandle(name);
                return true;
            } catch {
                try {
                    await parent.getDirectoryHandle(name);
                    return true;
                } catch {
                    return false;
                }
            }
        },
        rm: async path => {
            const segments = splitPath(path);
            const name = segments.pop();
            if (!name) return;
            const parent = await resolveDirectory(segments, false);
            if (!parent) return;
            try {
                await parent.removeEntry(name, { recursive: true });
            } catch {
                // `rm` ist tolerant (force), wie in node-fs.ts.
            }
        },
        stat: async path => {
            const segments = splitPath(path);
            if (segments.length === 0) return { isDirectory: true };
            const name = segments.pop() as string;
            const parent = await resolveDirectory(segments, false);
            if (!parent) throw enoent(path);
            try {
                const file = await (await parent.getFileHandle(name)).getFile();
                return { isDirectory: false, size: file.size, mtimeMs: file.lastModified };
            } catch {
                try {
                    await parent.getDirectoryHandle(name);
                    return { isDirectory: true };
                } catch {
                    throw enoent(path);
                }
            }
        },
    };
}

export interface StorageStatus {
    /** Steht OPFS in diesem Browser überhaupt zur Verfügung? */
    available: boolean;
    /** Sind die Daten vor automatischem Aufräumen geschützt? */
    persisted: boolean;
    /** Belegt/verfügbar in Bytes, soweit der Browser sie nennt. */
    usage: number | null;
    quota: number | null;
    /** Anteil belegt (0..1), sofern beides bekannt ist. */
    ratio: number | null;
    /** true ab 80 % Belegung — die Warnschwelle aus SPEC §8.3. */
    warning: boolean;
}

export const STORAGE_WARNING_RATIO = 0.8;

/**
 * Speicher-Lage des Browsers (SPEC §8.3). Der Nutzer muss wissen, ob seine
 * Daten „evictable" sind — deshalb wird das Ergebnis angezeigt und nicht
 * bloß geloggt.
 */
export async function readStorageStatus(): Promise<StorageStatus> {
    const empty: StorageStatus = { available: false, persisted: false, usage: null, quota: null, ratio: null, warning: false };
    if (typeof navigator === 'undefined' || !navigator.storage) return empty;
    const available = typeof navigator.storage.getDirectory === 'function';
    const persisted = typeof navigator.storage.persisted === 'function'
        ? await navigator.storage.persisted().catch(() => false)
        : false;
    let usage: number | null = null;
    let quota: number | null = null;
    if (typeof navigator.storage.estimate === 'function') {
        const estimate = await navigator.storage.estimate().catch(() => null);
        usage = estimate?.usage ?? null;
        quota = estimate?.quota ?? null;
    }
    const ratio = usage !== null && quota ? usage / quota : null;
    return {
        available,
        persisted,
        usage,
        quota,
        ratio,
        warning: ratio !== null && ratio >= STORAGE_WARNING_RATIO,
    };
}

/**
 * Fordert dauerhaften Speicher an (SPEC §8.3: beim ersten Schreibvorgang).
 * Liefert das ehrliche Ergebnis — der Browser darf ablehnen, und dann ist
 * der lokale Bestand löschbar.
 */
export async function requestPersistentStorage(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    return navigator.storage.persist().catch(() => false);
}
