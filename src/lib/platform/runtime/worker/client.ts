/**
 * `GraphStore` über eine Worker-Grenze (SPEC §5.2, M12).
 *
 * Der Haupt-Thread bekommt genau das Interface, das er von jedem anderen
 * Store kennt (Invariante 7) — die Nachrichten sind eine Implementierungs-
 * Frage, keine zweite API. Absichtlich ohne jeden Oxigraph-Import: Der Sinn
 * des Workers ist, dass die WASM-Maschine NICHT im Haupt-Thread liegt.
 */

import type { GraphStore, LoadReport, QueryOptions, QueryResult } from '@/lib/graph/store/types';
import { GraphStoreError } from '@/lib/graph/store/types';
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import {
    decodeError,
    encodeQueryOptions,
    namedNode,
    type StoreRequest,
    type StoreResponse,
    type StoreResult,
} from './protocol';
import { decodeQuad, decodeTerm, encodeQuad } from './terms';

/** Alles, worüber sich Nachrichten austauschen lassen (Worker, MessagePort). */
export interface StoreEndpoint {
    postMessage(message: unknown): void;
    addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    terminate?(): void;
    start?(): void;
}

/** `Omit` über eine Union verteilt sich nicht von selbst. */
type StoreRequestBody = StoreRequest extends infer Request
    ? Request extends { id: number } ? Omit<Request, 'id'> : never
    : never;

async function* iterate<T>(items: T[]): AsyncIterable<T> {
    for (const item of items) yield item;
}

function toQueryResult(result: StoreResult): QueryResult {
    if (result.kind === 'boolean') return { type: 'boolean', value: result.value };
    if (result.kind === 'quads') {
        return { type: 'quads', quads: iterate(result.quads.map(decodeQuad)) };
    }
    if (result.kind === 'bindings') {
        const bindings = result.bindings.map(binding => {
            const decoded: Record<string, Term> = {};
            for (const [variable, term] of Object.entries(binding)) decoded[variable] = decodeTerm(term);
            return decoded;
        });
        return { type: 'bindings', variables: result.variables, bindings: iterate(bindings) };
    }
    throw new GraphStoreError(`Unerwartete Antwort des Store-Workers: ${result.kind}.`, 'QUERY_FAILED');
}

export function createWorkerStore(endpoint: StoreEndpoint): GraphStore {
    const pending = new Map<number, { resolve: (result: StoreResult) => void; reject: (error: Error) => void }>();
    let nextId = 0;
    let closed = false;

    const onMessage = (event: MessageEvent) => {
        const response = event.data as StoreResponse | undefined;
        if (!response || typeof response.id !== 'number') return;
        const entry = pending.get(response.id);
        if (!entry) return;
        pending.delete(response.id);
        if (response.ok) entry.resolve(response.result);
        else entry.reject(decodeError(response.error));
    };
    endpoint.addEventListener('message', onMessage);
    endpoint.start?.();

    function send(request: StoreRequestBody): Promise<StoreResult> {
        if (closed) {
            return Promise.reject(new GraphStoreError('Der Store-Worker ist bereits geschlossen.', 'QUERY_FAILED'));
        }
        const id = (nextId += 1);
        return new Promise<StoreResult>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            endpoint.postMessage({ ...request, id } as StoreRequest);
        });
    }

    /** Store-Sicht auf eine offene Transaktion — dieselben Nachrichten, mit tx. */
    function storeFor(tx: number | undefined): GraphStore {
        return {
            async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
                return toQueryResult(await send({ kind: 'query', sparql, options: encodeQueryOptions(options), tx }));
            },
            async update(sparql: string, options?: QueryOptions): Promise<void> {
                await send({ kind: 'update', sparql, options: encodeQueryOptions(options), tx });
            },
            async load(quads, graph, opts): Promise<LoadReport> {
                const materialized: Quad[] = [];
                for await (const quad of quads as AsyncIterable<Quad>) materialized.push(quad);
                const result = await send({
                    kind: 'load',
                    quads: materialized.map(encodeQuad),
                    graph: graph.value,
                    ...(opts?.replace === undefined ? {} : { replace: opts.replace }),
                    tx,
                });
                if (result.kind !== 'load') {
                    throw new GraphStoreError('Unerwartete Antwort auf load().', 'TRANSACTION_FAILED');
                }
                return { added: result.added, removed: result.removed, graph: namedNode(result.graph) };
            },
            dump(graph?: NamedNode): AsyncIterable<Quad> {
                const request = send({ kind: 'dump', ...(graph ? { graph: graph.value } : {}), tx });
                return (async function* stream() {
                    const result = await request;
                    if (result.kind !== 'quads') {
                        throw new GraphStoreError('Unerwartete Antwort auf dump().', 'QUERY_FAILED');
                    }
                    for (const quad of result.quads) yield decodeQuad(quad);
                })();
            },
            async graphs(): Promise<NamedNode[]> {
                const result = await send({ kind: 'graphs', tx });
                if (result.kind !== 'graphs') {
                    throw new GraphStoreError('Unerwartete Antwort auf graphs().', 'QUERY_FAILED');
                }
                return result.graphs.map(namedNode);
            },
            async transaction<T>(fn: (tx: GraphStore) => Promise<T>): Promise<T> {
                if (tx !== undefined) {
                    // Verschachtelte Transaktionen gibt es im Store-Interface
                    // nicht; die innere läuft in derselben äußeren.
                    return fn(storeFor(tx));
                }
                const opened = await send({ kind: 'tx-begin' });
                if (opened.kind !== 'tx') {
                    throw new GraphStoreError('Transaktion konnte nicht geöffnet werden.', 'TRANSACTION_FAILED');
                }
                try {
                    const value = await fn(storeFor(opened.tx));
                    await send({ kind: 'tx-commit', tx: opened.tx });
                    return value;
                } catch (error) {
                    await send({ kind: 'tx-rollback', tx: opened.tx }).catch(() => undefined);
                    throw error;
                }
            },
            async close(): Promise<void> {
                if (tx !== undefined) return;
                if (closed) return;
                await send({ kind: 'close' }).catch(() => undefined);
                closed = true;
                endpoint.removeEventListener('message', onMessage);
                for (const entry of pending.values()) {
                    entry.reject(new GraphStoreError('Der Store-Worker wurde geschlossen.', 'QUERY_FAILED'));
                }
                pending.clear();
                endpoint.terminate?.();
            },
        };
    }

    return storeFor(undefined);
}
