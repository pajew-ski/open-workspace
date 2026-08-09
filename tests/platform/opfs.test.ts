// @vitest-environment node
/**
 * OPFS-Backing der Runtime `local` (SPEC §5.2/§8.3, M12).
 *
 * Node hat kein OPFS. Statt den Adapter zu mocken (dann prüfte der Test
 * sich selbst), steht hier eine ehrliche Nachbildung der OPFS-Handles:
 * verschachtelte Verzeichnisse, `createWritable`, `keys()`, `removeEntry`
 * — genau die Formen, gegen die der Adapter programmiert ist. Geprüft wird
 * der Adapter, nicht der Browser.
 *
 * Die Abnahme ist bewusst nicht „Dateien lassen sich schreiben", sondern:
 * `isomorphic-git` (Runtime `local`, M6) läuft auf diesem Backing
 * unverändert — inklusive der Frische-Signale, ohne die es seinem
 * Index-Cache glaubt.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createOpfsFileSystem, readStorageStatus, requestPersistentStorage, STORAGE_WARNING_RATIO, type OpfsDirectoryHandle } from '../../src/lib/platform/runtime/opfs';
import { createIsomorphicGitProvider } from '../../src/lib/platform/runtime/isomorphic-git';

const encoder = new TextEncoder();

/** Nachbildung eines OPFS-Verzeichnisses (nur was der Adapter benutzt). */
function createDirectoryHandle(): OpfsDirectoryHandle {
    const files = new Map<string, { data: Uint8Array; lastModified: number }>();
    const directories = new Map<string, OpfsDirectoryHandle>();
    // Monotone Uhr: zwei Schreibvorgänge dürfen nie dieselbe mtime tragen.
    let clock = 1_700_000_000_000;

    const handle: OpfsDirectoryHandle = {
        async getDirectoryHandle(name, options) {
            const existing = directories.get(name);
            if (existing) return existing;
            if (!options?.create) throw new Error(`NotFoundError: ${name}`);
            const created = createDirectoryHandle();
            directories.set(name, created);
            return created;
        },
        async getFileHandle(name, options) {
            if (!files.has(name)) {
                if (!options?.create) throw new Error(`NotFoundError: ${name}`);
                files.set(name, { data: new Uint8Array(), lastModified: (clock += 1000) });
            }
            return {
                async getFile() {
                    const entry = files.get(name);
                    if (!entry) throw new Error(`NotFoundError: ${name}`);
                    const copy = entry.data.slice();
                    return {
                        size: copy.length,
                        lastModified: entry.lastModified,
                        async text() { return new TextDecoder().decode(copy); },
                        async arrayBuffer() { return copy.buffer as ArrayBuffer; },
                    };
                },
                async createWritable() {
                    const chunks: Uint8Array[] = [];
                    return {
                        async write(data: string | Uint8Array) {
                            chunks.push(typeof data === 'string' ? encoder.encode(data) : data);
                        },
                        async close() {
                            const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
                            const merged = new Uint8Array(size);
                            let offset = 0;
                            for (const chunk of chunks) {
                                merged.set(chunk, offset);
                                offset += chunk.length;
                            }
                            files.set(name, { data: merged, lastModified: (clock += 1000) });
                        },
                    };
                },
            };
        },
        async removeEntry(name) {
            if (!files.delete(name) && !directories.delete(name)) {
                throw new Error(`NotFoundError: ${name}`);
            }
        },
        async *keys() {
            for (const name of files.keys()) yield name;
            for (const name of directories.keys()) yield name;
        },
    };
    return handle;
}

describe('FileSystemLike über OPFS', () => {
    it('legt Pfade als Handle-Kette an und liest sie zurück', async () => {
        const files = createOpfsFileSystem(createDirectoryHandle());

        await files.mkdir('/data/graph');
        await files.writeFile('/data/graph/manifest.json', '{"version":2}');
        expect(await files.readFile('/data/graph/manifest.json')).toBe('{"version":2}');
        expect(await files.exists('/data/graph')).toBe(true);
        expect(await files.exists('/data/graph/manifest.json')).toBe(true);
        expect(await files.exists('/data/fehlt')).toBe(false);
        expect(await files.readdir('/data/graph')).toEqual(['manifest.json']);
        expect((await files.stat('/data/graph')).isDirectory).toBe(true);
    });

    it('trägt die Binär-Ebene und die Frische-Signale (M6)', async () => {
        const files = createOpfsFileSystem(createDirectoryHandle());
        await files.writeBytes('/objects/pack', new Uint8Array([1, 2, 3, 4]));
        expect(Array.from(await files.readBytes('/objects/pack'))).toEqual([1, 2, 3, 4]);

        const before = await files.stat('/objects/pack');
        await files.writeBytes('/objects/pack', new Uint8Array([1, 2, 3, 4, 5]));
        const after = await files.stat('/objects/pack');
        expect(before.size).toBe(4);
        expect(after.size).toBe(5);
        expect(after.mtimeMs as number).toBeGreaterThan(before.mtimeMs as number);
    });

    it('meldet fehlende Pfade als ENOENT — darauf prüft isomorphic-git', async () => {
        const files = createOpfsFileSystem(createDirectoryHandle());
        await expect(files.readFile('/fehlt.txt')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(files.stat('/fehlt.txt')).rejects.toMatchObject({ code: 'ENOENT' });
        // `rm` ist tolerant, wie node-fs.
        await expect(files.rm('/fehlt.txt')).resolves.toBeUndefined();
    });

    it('trägt isomorphic-git: Commit und Diff laufen auf dem Browser-Backing', async () => {
        const files = createOpfsFileSystem(createDirectoryHandle());
        const git = createIsomorphicGitProvider(files);
        const author = { name: 'Open Workspace', email: 'graph-backup@open-workspace.local' };

        await files.mkdir('/repo');
        await git.init('/repo');
        await files.writeFile('/repo/notiz.md', 'erste Fassung\n');
        const first = await git.commitAll('/repo', 'Erste Fassung', author);
        expect(first.committed).toBe(true);

        await files.writeFile('/repo/notiz.md', 'zweite Fassung\n');
        expect(await git.status('/repo')).toEqual([{ path: 'notiz.md', state: 'modified' }]);
        const second = await git.commitAll('/repo', 'Zweite Fassung', author);

        expect(await git.changedFiles('/repo', first.sha as string, second.sha as string)).toEqual(['notiz.md']);
        const diff = await git.diff('/repo', first.sha as string, second.sha as string);
        expect(diff).toContain('-erste Fassung');
        expect(diff).toContain('+zweite Fassung');
    }, 30_000);
});

describe('Speicher-Lage des Browsers (§8.3)', () => {
    const original = globalThis.navigator;

    afterEach(() => {
        if (original === undefined) {
            Reflect.deleteProperty(globalThis, 'navigator');
        } else {
            Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
        }
    });

    function stubStorage(storage: Partial<StorageManager> | undefined): void {
        Object.defineProperty(globalThis, 'navigator', {
            value: storage === undefined ? {} : { storage },
            configurable: true,
        });
    }

    it('sagt ehrlich, dass es keinen privaten Dateispeicher gibt', async () => {
        stubStorage(undefined);
        expect(await readStorageStatus()).toMatchObject({ available: false, persisted: false, warning: false });
        expect(await requestPersistentStorage()).toBe(false);
    });

    it('meldet Persistenz, Belegung und die 80-%-Warnung', async () => {
        stubStorage({
            getDirectory: (async () => ({})) as StorageManager['getDirectory'],
            persisted: async () => true,
            estimate: async () => ({ usage: 850, quota: 1000 }),
        });
        const status = await readStorageStatus();
        expect(status).toMatchObject({ available: true, persisted: true, usage: 850, quota: 1000, warning: true });
        expect(status.ratio).toBeGreaterThanOrEqual(STORAGE_WARNING_RATIO);

        stubStorage({
            getDirectory: (async () => ({})) as StorageManager['getDirectory'],
            persisted: async () => false,
            estimate: async () => ({ usage: 100, quota: 1000 }),
        });
        expect(await readStorageStatus()).toMatchObject({ persisted: false, warning: false });
    });

    it('gibt das Ergebnis der Persistenz-Anfrage unverfälscht weiter', async () => {
        const persist = vi.fn(async () => false);
        stubStorage({ getDirectory: (async () => ({})) as StorageManager['getDirectory'], persist });
        expect(await requestPersistentStorage()).toBe(false);
        expect(persist).toHaveBeenCalledOnce();
    });
});
