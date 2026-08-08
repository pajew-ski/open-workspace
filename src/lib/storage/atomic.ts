/**
 * Atomic file persistence utilities.
 *
 * - writeFileAtomic / writeJsonAtomic: write to a temp file in the same
 *   directory, then rename over the target. rename() is atomic on POSIX
 *   filesystems, so readers never observe a half-written file and a crash
 *   mid-write never destroys the previous version.
 * - withFileLock: per-path in-process promise queue that serializes
 *   read-modify-write cycles so concurrent requests cannot interleave
 *   and lose updates.
 * - readJsonSafe: tolerant reader. Missing file returns the fallback;
 *   corrupt JSON is preserved as `<file>.corrupt-<timestamp>` for forensics
 *   and the fallback is returned instead of throwing.
 *
 * Note: the lock only covers this Node process. That matches the current
 * single-instance deployment model of the app.
 */

import { promises as fs } from 'fs';
import path from 'path';

let tmpCounter = 0;

/**
 * Atomically write raw string content to a file (temp file + rename).
 * Ensures the parent directory exists.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    tmpCounter += 1;
    const tmpPath = `${filePath}.${process.pid}.${tmpCounter}.tmp`;

    try {
        await fs.writeFile(tmpPath, content, 'utf-8');
        await fs.rename(tmpPath, filePath);
    } catch (error) {
        // Best-effort cleanup so failed writes don't leave temp files behind
        await fs.unlink(tmpPath).catch(() => undefined);
        throw error;
    }
}

/**
 * Atomically serialize data as pretty-printed JSON and write it to filePath.
 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    await writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

/**
 * Read and parse a JSON file.
 * - ENOENT (file missing) -> fallback
 * - Unparseable JSON -> file is copied to `<file>.corrupt-<timestamp>`,
 *   the error is logged, and the fallback is returned.
 * - Other read errors are logged and the fallback is returned so API
 *   handlers keep working (previous behavior of the storage modules).
 */
export async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
    let content: string;
    try {
        content = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
            console.error(`[storage] Failed to read ${filePath}:`, error);
        }
        return fallback;
    }

    try {
        return JSON.parse(content) as T;
    } catch (error) {
        const corruptPath = `${filePath}.corrupt-${Date.now()}`;
        console.error(
            `[storage] Corrupt JSON in ${filePath}, preserving copy at ${corruptPath}:`,
            error
        );
        try {
            await fs.copyFile(filePath, corruptPath);
        } catch (copyError) {
            console.error(`[storage] Failed to preserve corrupt file ${filePath}:`, copyError);
        }
        return fallback;
    }
}

// Per-path promise queue. The stored promise is always "settled-safe"
// (never rejects), so one failing operation does not poison the queue.
const fileQueues = new Map<string, Promise<void>>();

/**
 * Serialize an async read-modify-write cycle on a file (or any string key).
 * All calls with the same resolved path run strictly one after another in
 * this process. Do NOT nest withFileLock calls on the same path (deadlock);
 * locking different paths sequentially or nested is fine.
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const key = path.resolve(filePath);
    const previous = fileQueues.get(key) ?? Promise.resolve();

    const run = previous.then(() => fn());
    const tail = run.then(
        () => undefined,
        () => undefined
    );
    fileQueues.set(key, tail);

    try {
        return await run;
    } finally {
        // Drop the map entry once this call is still the tail (queue drained)
        if (fileQueues.get(key) === tail) {
            fileQueues.delete(key);
        }
    }
}
