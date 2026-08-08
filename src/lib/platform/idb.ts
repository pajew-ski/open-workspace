'use client';

/**
 * Minimal promise-based IndexedDB wrapper (no dependency) for the
 * serverless persistence paths (chat conversations, later: content
 * mirrors). One database, versioned object stores.
 */

const DB_NAME = 'open-workspace';
const DB_VERSION = 1;
export const STORES = {
    conversations: 'conversations',
    meta: 'meta',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB nicht verfügbar'));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORES.conversations)) {
                db.createObjectStore(STORES.conversations, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORES.meta)) {
                db.createObjectStore(STORES.meta);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open fehlgeschlagen'));
    });
    return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB Anfrage fehlgeschlagen'));
    });
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
    const db = await openDb();
    const tx = db.transaction(store, 'readonly');
    return requestToPromise(tx.objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    const db = await openDb();
    const tx = db.transaction(store, 'readonly');
    return requestToPromise(tx.objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export async function idbPut(store: string, value: unknown, key?: IDBValidKey): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(store, 'readwrite');
    await requestToPromise(tx.objectStore(store).put(value, key));
}

export async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(store, 'readwrite');
    await requestToPromise(tx.objectStore(store).delete(key));
}

export async function idbClear(store: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(store, 'readwrite');
    await requestToPromise(tx.objectStore(store).clear());
}
