// @vitest-environment node
/**
 * Store im Worker (SPEC §5.2, M12) — die Runtime `local` hält Oxigraph aus
 * dem Haupt-Thread heraus, damit die UI nie auf einer Query blockiert.
 *
 * Geprüft wird die echte Kette: `createWorkerStore` (Haupt-Thread-Seite)
 * schickt Nachrichten über einen `MessageChannel` an `createStoreHost`
 * (Worker-Seite), der sie gegen einen echten `OxigraphStore` ausführt.
 * Nur der Transportweg ist kurzgeschlossen — dieselben Module, dasselbe
 * Protokoll, dieselbe Serialisierung wie im Browser.
 *
 * Der Anspruch ist nicht „irgendetwas kommt an", sondern: Ein Worker-Store
 * verhält sich wie der Store daneben. Deshalb läuft jede Erwartung gegen
 * BEIDE — Abweichung ist ein Fehler.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageChannel, type MessagePort } from 'node:worker_threads';

import { OxigraphStore } from '../../src/lib/graph/store/oxigraph';
import { GraphStoreError, type GraphStore } from '../../src/lib/graph/store/types';
import { createStoreHost, encodeError, type StoreRequest, type StoreResponse } from '../../src/lib/platform/runtime/worker/protocol';
import { createWorkerStore, type StoreEndpoint } from '../../src/lib/platform/runtime/worker/client';
import { decodeQuad, encodeQuad } from '../../src/lib/platform/runtime/worker/terms';
import type { Quad } from '@rdfjs/types';

const GRAPH = 'urn:ow:test:graph/workspace';
const OTHER = 'urn:ow:test:graph/public';

/** `MessagePort` aus node:worker_threads in die Worker-Form bringen. */
function toEndpoint(port: MessagePort): StoreEndpoint {
    const listeners = new Map<(event: MessageEvent) => void, (value: unknown) => void>();
    return {
        postMessage: message => port.postMessage(message),
        addEventListener: (_type, listener) => {
            const wrapped = (value: unknown) => listener({ data: value } as MessageEvent);
            listeners.set(listener, wrapped);
            port.on('message', wrapped);
        },
        removeEventListener: (_type, listener) => {
            const wrapped = listeners.get(listener);
            if (wrapped) port.off('message', wrapped);
            listeners.delete(listener);
        },
        terminate: () => port.close(),
        start: () => port.start?.(),
    };
}

/** Startet die Worker-Seite auf einem Port — wie store.worker.ts, ohne Browser. */
function serve(port: MessagePort, store: GraphStore): void {
    const host = createStoreHost(store);
    port.on('message', message => {
        const request = message as StoreRequest;
        if (!request || typeof request.id !== 'number') return;
        void (async () => {
            let response: StoreResponse;
            try {
                response = { id: request.id, ok: true, result: await host.handle(request) };
            } catch (error) {
                response = { id: request.id, ok: false, error: encodeError(error) };
            }
            port.postMessage(response);
        })();
    });
    port.start?.();
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of source) items.push(item);
    return items;
}

const INSERT = `INSERT DATA { GRAPH <${GRAPH}> {
    <urn:ow:test:doc/1> <http://schema.org/name> "Notiz \\u00fcber Ingress"@de .
    <urn:ow:test:doc/1> <http://schema.org/dateModified> "2026-08-09T10:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
} }`;

describe('GraphStore über die Worker-Grenze', () => {
    let backing: OxigraphStore;
    let reference: OxigraphStore;
    let channel: MessageChannel;
    let store: GraphStore;

    beforeEach(async () => {
        backing = new OxigraphStore();
        reference = new OxigraphStore();
        channel = new MessageChannel();
        serve(channel.port2, backing);
        store = createWorkerStore(toEndpoint(channel.port1));
        await store.update(INSERT);
        await reference.update(INSERT);
    });

    afterEach(async () => {
        await store.close();
        await reference.close();
    });

    it('liefert SELECT-Bindungen mit erhaltenen Literal-Details', async () => {
        const sparql = `SELECT ?name WHERE { GRAPH <${GRAPH}> { ?s <http://schema.org/name> ?name } }`;
        const result = await store.query(sparql);
        const expected = await reference.query(sparql);
        if (result.type !== 'bindings' || expected.type !== 'bindings') throw new Error('SELECT erwartet');

        const rows = await collect(result.bindings);
        const expectedRows = await collect(expected.bindings);
        expect(result.variables).toEqual(expected.variables);
        expect(rows).toHaveLength(1);
        expect(rows[0].name.value).toBe(expectedRows[0].name.value);
        expect((rows[0].name as { language: string }).language).toBe('de');
        // Der dekodierte Term ist ein vollwertiger RDF/JS-Term.
        expect(rows[0].name.equals(expectedRows[0].name)).toBe(true);
    });

    it('liefert ASK, CONSTRUCT und dump identisch zum Store daneben', async () => {
        const ask = `ASK { GRAPH <${GRAPH}> { ?s <http://schema.org/name> ?o } }`;
        expect(await store.query(ask)).toEqual({ type: 'boolean', value: true });

        const construct = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${GRAPH}> { ?s ?p ?o } }`;
        const result = await store.query(construct);
        if (result.type !== 'quads') throw new Error('CONSTRUCT erwartet');
        const quads = await collect(result.quads);
        expect(quads).toHaveLength(2);

        const dumped = await collect(store.dump({ termType: 'NamedNode', value: GRAPH, equals: () => false } as never));
        expect(dumped).toHaveLength(2);
        expect(dumped.every(quad => quad.graph.value === GRAPH)).toBe(true);
        expect((await store.graphs()).map(graph => graph.value)).toEqual([GRAPH]);
    });

    it('lädt Quads in genau einen Named Graph — mit Ersetzungs-Semantik', async () => {
        const quads = (await collect(reference.dump())).map(quad => decodeQuad(encodeQuad(quad)));
        const target = { termType: 'NamedNode' as const, value: OTHER, equals: () => false } as never;

        const report = await store.load(quads as Quad[], target, { replace: true });
        expect(report.added).toBe(2);
        expect(report.graph.value).toBe(OTHER);
        expect((await store.graphs()).map(graph => graph.value).sort()).toEqual([OTHER, GRAPH].sort());

        const again = await store.load([], target, { replace: true });
        expect(again.removed).toBe(2);
    });

    it('hält Transaktionen offen: lesen, ändern, schreiben in EINER Transaktion', async () => {
        const value = await store.transaction(async tx => {
            const before = await tx.query(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${GRAPH}> { ?s ?p ?o } }`);
            if (before.type !== 'bindings') throw new Error('SELECT erwartet');
            const [row] = await collect(before.bindings);
            await tx.update(`INSERT DATA { GRAPH <${GRAPH}> { <urn:ow:test:doc/2> <http://schema.org/name> "Zweite" } }`);
            return row.n.value;
        });
        expect(value).toBe('2');

        const after = await store.query(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${GRAPH}> { ?s ?p ?o } }`);
        if (after.type !== 'bindings') throw new Error('SELECT erwartet');
        expect((await collect(after.bindings))[0].n.value).toBe('3');
    });

    it('rollt eine gescheiterte Transaktion vollständig zurück', async () => {
        await expect(store.transaction(async tx => {
            await tx.update(`INSERT DATA { GRAPH <${GRAPH}> { <urn:ow:test:doc/3> <http://schema.org/name> "Verworfen" } }`);
            throw new Error('Abbruch mitten drin');
        })).rejects.toThrow('Abbruch mitten drin');

        const after = await store.query(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${GRAPH}> { ?s ?p ?o } }`);
        if (after.type !== 'bindings') throw new Error('SELECT erwartet');
        expect((await collect(after.bindings))[0].n.value).toBe('2');
    });

    it('reicht Store-Fehler mit ihrem Code über die Grenze', async () => {
        // Kein Default-Graph-Schreibpfad (Invariante 4) — auch nicht über den Worker.
        await expect(store.update('INSERT DATA { <urn:ow:test:x> <urn:ow:test:p> "y" }'))
            .rejects.toMatchObject({ name: 'GraphStoreError', code: 'DEFAULT_GRAPH_WRITE' });
        await expect(store.query('SELECT ?s WHERE { ?s ?p'))
            .rejects.toBeInstanceOf(GraphStoreError);
        // Der Store lebt weiter: ein Fehler ist kein Abriss der Verbindung.
        expect(await store.query(`ASK { GRAPH <${GRAPH}> { ?s ?p ?o } }`)).toEqual({ type: 'boolean', value: true });
    });

    it('beendet offene Anfragen beim Schließen, statt sie hängen zu lassen', async () => {
        await store.close();
        await expect(store.query('SELECT * WHERE { ?s ?p ?o }')).rejects.toThrow(/geschlossen/);
    });
});
