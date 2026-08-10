/// <reference lib="webworker" />
/**
 * Store-Worker der Runtime `local` (SPEC §5.2, M12).
 *
 * Hier — und nur hier — läuft Oxigraph-WASM im Browser. Der Haupt-Thread
 * spricht über `worker/client.ts` dasselbe `GraphStore`-Interface wie
 * überall sonst; die Nachrichtenschranke sorgt dafür, dass eine lange
 * Query die Oberfläche nicht anhält (SPEC §5.2: „Die UI blockiert nie auf
 * einer Query").
 *
 * Der Web-Build von Oxigraph will vor der ersten Nutzung initialisiert
 * werden (`init()`); das Bundling des `.wasm`-Artefakts übernimmt der
 * Bundler über die `import.meta.url`-Auflösung im Paket selbst.
 */

import * as oxigraph from 'oxigraph';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createStoreHost, encodeError, type StoreRequest, type StoreResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

/**
 * Der Web-Build exportiert seine Initialisierung als Default; der
 * Node-Build (den die Typen beschreiben) kennt sie nicht, weil er sein
 * WASM synchron lädt. Deshalb wird sie aufgerufen, wenn es sie gibt —
 * derselbe Worker läuft damit unter beiden Bindungen.
 */
const ready = (async () => {
    const initialize = (oxigraph as unknown as { default?: () => Promise<unknown> }).default;
    if (typeof initialize === 'function') await initialize();
    return createStoreHost(new OxigraphStore());
})();

self.addEventListener('message', event => {
    const request = event.data as StoreRequest | undefined;
    if (!request || typeof request.id !== 'number') return;
    void (async () => {
        let response: StoreResponse;
        try {
            const host = await ready;
            response = { id: request.id, ok: true, result: await host.handle(request) };
        } catch (error) {
            response = { id: request.id, ok: false, error: encodeError(error) };
        }
        self.postMessage(response);
    })();
});
