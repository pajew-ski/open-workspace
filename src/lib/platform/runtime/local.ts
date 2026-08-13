/**
 * RuntimeAdapter der Runtime `local` (SPEC §5.2, M12) — die Browser-
 * Bindungen: Store im Web Worker (Oxigraph-WASM), Dateien im OPFS,
 * isomorphic-git über genau dieses Dateisystem, Einzelnutzer-Identität,
 * Secrets im `localStorage`.
 *
 * Alle vier Bindungen laufen über die Interfaces, die seit M6 stehen —
 * es gibt keinen zweiten Codepfad „für den Browser" (Invariante 7).
 *
 * Capabilities sind ehrlich (SPEC §5.2): ohne HTTP-Server gibt es weder
 * SPARQL-Endpoint noch MCP-Server noch eingehende Föderation. Ausgehende
 * Föderation hängt an CORS der Gegenstelle und ist deshalb per Default aus;
 * `OW_LOCAL_FEDERATION` bzw. `allowFederationOutbound` schaltet sie
 * bewusst frei, wenn die Endpoints CORS beherrschen.
 */

import type { GraphStore } from '@/lib/graph/store/types';
import { DEFAULT_USER_ID } from '@/lib/graph/iri';
import type { BinaryFileSystemLike, RuntimeAdapter } from './types';
import { createOpfsFileSystem, requestPersistentStorage, type OpfsDirectoryHandle } from './opfs';
import { createIsomorphicGitProvider } from './isomorphic-git';
import { createWorkerStore, type StoreEndpoint } from './worker/client';

export interface LocalRuntimeOptions {
    /**
     * Erzeugt den Worker. Ohne Angabe wird `worker/store.worker.ts` über
     * die Bundler-Auflösung geladen — injizierbar, damit Tests denselben
     * Adapter ohne Browser prüfen können.
     */
    createEndpoint?: () => StoreEndpoint;
    /** Dateisystem-Wurzel; ohne Angabe das OPFS dieser Origin. */
    files?: BinaryFileSystemLike;
    /** Ausgehende Föderation nur, wenn die Gegenstellen CORS können. */
    allowFederationOutbound?: boolean;
}

function defaultEndpoint(): StoreEndpoint {
    return new Worker(new URL('./worker/store.worker.ts', import.meta.url), {
        type: 'module',
        name: 'open-workspace-store',
    });
}

function localSecrets() {
    const storageKey = (key: string) => `ow.secret.${key}`;
    return {
        get: async (key: string) => {
            if (typeof localStorage === 'undefined') return null;
            return localStorage.getItem(storageKey(key));
        },
        set: async (key: string, value: string) => {
            if (typeof localStorage === 'undefined') {
                throw new Error('Ohne localStorage lässt sich in dieser Umgebung nichts speichern.');
            }
            localStorage.setItem(storageKey(key), value);
        },
    };
}

export function createLocalRuntimeAdapter(options: LocalRuntimeOptions = {}): RuntimeAdapter {
    const files = options.files ?? createOpfsFileSystem(
        () => navigator.storage.getDirectory() as unknown as Promise<OpfsDirectoryHandle>,
    );
    let store: Promise<GraphStore> | null = null;

    return {
        id: 'local',
        store: () => {
            if (!store) {
                store = (async () => {
                    // Dauerhafter Speicher wird beim ersten Zugriff angefragt
                    // (SPEC §8.3). Ein „nein" des Browsers ist kein Fehler —
                    // es steht in der Speicher-Karte der Einstellungen.
                    await requestPersistentStorage();
                    return createWorkerStore((options.createEndpoint ?? defaultEndpoint)());
                })();
            }
            return store;
        },
        files: () => files,
        git: () => createIsomorphicGitProvider(files),
        auth: () => ({
            // Ein Gerät, ein Nutzer — es gibt niemanden zu unterscheiden.
            identity: async () => ({ userId: DEFAULT_USER_ID, groups: [] }),
        }),
        secrets: () => localSecrets(),
        capabilities: {
            // Kein HTTP-Server im Browser: der Store ist In-Process
            // erreichbar, ein Endpoint nach außen existiert nicht.
            sparqlEndpoint: false,
            mcpServer: false,
            federationOutbound: options.allowFederationOutbound ?? false,
            federationInbound: false,
            multiUser: false,
            reasoningTier: 'rl',
            // Der Tier-1-Kern ist pur und läuft deshalb auch hier — das
            // ist der Punkt an ihm (CAUSAL_LAYER_SPEC §18).
            causalTier: 'graph',
        },
    };
}
