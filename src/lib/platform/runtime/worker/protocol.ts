/**
 * Protokoll zwischen Haupt-Thread und Store-Worker (SPEC §5.2, M12).
 *
 * Der Store der Runtime `local` läuft in einem Web Worker — „die UI
 * blockiert nie auf einer Query" ist eine Anforderung der Spec, und
 * Oxigraph-WASM arbeitet synchron. Nach außen bleibt es dasselbe
 * `GraphStore`-Interface (Invariante 7): der Worker-Client bildet jede
 * Methode auf genau eine Nachricht ab.
 *
 * Ergebnisse werden vollständig übertragen statt gestreamt. Das ist eine
 * bewusste Entscheidung: Oxigraph liefert seine Ergebnisse ohnehin
 * materialisiert, und ein Pseudo-Stream über `postMessage` wäre mehr
 * Buchhaltung ohne einen einzigen Ladepunkt weniger. Die Kappung leisten
 * die Aufrufer (Retrieval-Grenzen, Endpoint-Limits).
 *
 * Transaktionen behalten ihre Semantik: `tx-begin` öffnet im Worker eine
 * echte `store.transaction(...)`, die offen bleibt, bis `tx-commit` oder
 * `tx-rollback` kommt. Lesen INNERHALB der Transaktion ist damit möglich —
 * ohne das wäre die Schreibschicht (§12.4) über einen Worker nicht
 * lauffähig, weil sie liest, ändert und schreibt.
 */

import type { GraphStore, LoadReport, QueryOptions } from '@/lib/graph/store/types';
import { GraphStoreError } from '@/lib/graph/store/types';
import type { NamedNode, Quad } from '@rdfjs/types';
import { decodeQuad, decodeTerm, encodeQuad, encodeTerm, type EncodedTerm } from './terms';

export interface EncodedQueryOptions {
    defaultGraphs?: string[];
    namedGraphs?: string[];
    timeoutMs?: number;
    readOnly?: boolean;
    baseIri?: string;
}

/** Transaktions-Kennung; fehlt sie, läuft die Operation außerhalb. */
type WithTx = { tx?: number };

export type StoreRequest =
    | ({ id: number; kind: 'query'; sparql: string; options?: EncodedQueryOptions } & WithTx)
    | ({ id: number; kind: 'update'; sparql: string; options?: EncodedQueryOptions } & WithTx)
    | ({ id: number; kind: 'load'; quads: EncodedTerm[]; graph: string; replace?: boolean } & WithTx)
    | ({ id: number; kind: 'dump'; graph?: string } & WithTx)
    | ({ id: number; kind: 'graphs' } & WithTx)
    | { id: number; kind: 'tx-begin' }
    | { id: number; kind: 'tx-commit'; tx: number }
    | { id: number; kind: 'tx-rollback'; tx: number }
    | { id: number; kind: 'close' };

export type StoreResult =
    | { kind: 'bindings'; variables: string[]; bindings: Record<string, EncodedTerm>[] }
    | { kind: 'quads'; quads: EncodedTerm[] }
    | { kind: 'boolean'; value: boolean }
    | { kind: 'load'; added: number; removed: number; graph: string }
    | { kind: 'graphs'; graphs: string[] }
    | { kind: 'tx'; tx: number }
    | { kind: 'void' };

export type StoreResponse =
    | { id: number; ok: true; result: StoreResult }
    | { id: number; ok: false; error: { message: string; code?: string } };

export function encodeQueryOptions(options?: QueryOptions): EncodedQueryOptions | undefined {
    if (!options) return undefined;
    return {
        ...(options.defaultGraphs ? { defaultGraphs: options.defaultGraphs.map(g => g.value) } : {}),
        ...(options.namedGraphs ? { namedGraphs: options.namedGraphs.map(g => g.value) } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
        ...(options.baseIri !== undefined ? { baseIri: options.baseIri } : {}),
    };
}

function decodeQueryOptions(options: EncodedQueryOptions | undefined): QueryOptions | undefined {
    if (!options) return undefined;
    return {
        ...(options.defaultGraphs ? { defaultGraphs: options.defaultGraphs.map(namedNode) } : {}),
        ...(options.namedGraphs ? { namedGraphs: options.namedGraphs.map(namedNode) } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
        ...(options.baseIri !== undefined ? { baseIri: options.baseIri } : {}),
    };
}

export function namedNode(iri: string): NamedNode {
    return decodeTerm({ t: 'NamedNode', v: iri }) as NamedNode;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of source) items.push(item);
    return items;
}

/** Rollback-Signal: verlässt die Transaktion nie als Fehler nach außen. */
class TransactionRollback extends Error {
    constructor() {
        super('rollback');
        this.name = 'TransactionRollback';
    }
}

interface TxSession {
    store: GraphStore;
    settle: (commit: boolean) => void;
    completed: Promise<void>;
}

/**
 * Führt Anfragen gegen einen echten Store aus — im Worker, und in den Tests
 * direkt gegen denselben Store, damit die Abbildung ohne Browser prüfbar
 * ist (dieselbe Klasse, kein Nachbau).
 */
export function createStoreHost(store: GraphStore) {
    const sessions = new Map<number, TxSession>();
    let nextTx = 0;

    const target = (tx: number | undefined): GraphStore => {
        if (tx === undefined) return store;
        const session = sessions.get(tx);
        if (!session) throw new GraphStoreError(`Unbekannte Transaktion ${tx}.`, 'TRANSACTION_FAILED');
        return session.store;
    };

    async function begin(): Promise<number> {
        const id = (nextTx += 1);
        let settle: (commit: boolean) => void = () => undefined;
        const decision = new Promise<boolean>(resolve => { settle = resolve; });
        let ready: () => void = () => undefined;
        const started = new Promise<void>(resolve => { ready = resolve; });

        const completed = store.transaction(async tx => {
            sessions.set(id, { store: tx, settle, completed: Promise.resolve() });
            ready();
            if (!(await decision)) throw new TransactionRollback();
        }).catch((error: unknown) => {
            if (error instanceof TransactionRollback) return;
            throw error;
        }).finally(() => {
            sessions.delete(id);
        });

        // Fehler beim Start (z. B. Store geschlossen) dürfen nicht im
        // Hintergrund verpuffen; sie kommen über `started`/`completed`.
        await Promise.race([started, completed]);
        const session = sessions.get(id);
        if (!session) throw new GraphStoreError('Transaktion konnte nicht geöffnet werden.', 'TRANSACTION_FAILED');
        session.completed = completed;
        return id;
    }

    async function finish(id: number, commit: boolean): Promise<void> {
        const session = sessions.get(id);
        if (!session) throw new GraphStoreError(`Unbekannte Transaktion ${id}.`, 'TRANSACTION_FAILED');
        session.settle(commit);
        await session.completed;
    }

    return {
        get openTransactions(): number {
            return sessions.size;
        },
        async handle(request: StoreRequest): Promise<StoreResult> {
            switch (request.kind) {
                case 'query': {
                    const result = await target(request.tx).query(request.sparql, decodeQueryOptions(request.options));
                    if (result.type === 'boolean') return { kind: 'boolean', value: result.value };
                    if (result.type === 'quads') {
                        const quads = await collect(result.quads);
                        return { kind: 'quads', quads: quads.map(encodeQuad) };
                    }
                    const bindings = await collect(result.bindings);
                    return {
                        kind: 'bindings',
                        variables: result.variables,
                        bindings: bindings.map(binding => {
                            const encoded: Record<string, EncodedTerm> = {};
                            for (const [variable, term] of Object.entries(binding)) {
                                encoded[variable] = encodeTerm(term);
                            }
                            return encoded;
                        }),
                    };
                }
                case 'update':
                    await target(request.tx).update(request.sparql, decodeQueryOptions(request.options));
                    return { kind: 'void' };
                case 'load': {
                    const report: LoadReport = await target(request.tx).load(
                        request.quads.map(decodeQuad),
                        namedNode(request.graph),
                        request.replace === undefined ? undefined : { replace: request.replace },
                    );
                    return { kind: 'load', added: report.added, removed: report.removed, graph: report.graph.value };
                }
                case 'dump': {
                    const quads: Quad[] = await collect(
                        target(request.tx).dump(request.graph ? namedNode(request.graph) : undefined),
                    );
                    return { kind: 'quads', quads: quads.map(encodeQuad) };
                }
                case 'graphs': {
                    const graphs = await target(request.tx).graphs();
                    return { kind: 'graphs', graphs: graphs.map(graph => graph.value) };
                }
                case 'tx-begin':
                    return { kind: 'tx', tx: await begin() };
                case 'tx-commit':
                    await finish(request.tx, true);
                    return { kind: 'void' };
                case 'tx-rollback':
                    await finish(request.tx, false);
                    return { kind: 'void' };
                case 'close':
                    for (const id of [...sessions.keys()]) await finish(id, false);
                    await store.close();
                    return { kind: 'void' };
            }
        },
    };
}

export type StoreHost = ReturnType<typeof createStoreHost>;

/** Fehler über die Grenze: Code erhalten, damit `GraphStoreError` überlebt. */
export function encodeError(error: unknown): { message: string; code?: string } {
    if (error instanceof GraphStoreError) return { message: error.message, code: error.code };
    return { message: error instanceof Error ? error.message : String(error) };
}

export function decodeError(error: { message: string; code?: string }): Error {
    if (error.code) {
        return new GraphStoreError(error.message, error.code as GraphStoreError['code']);
    }
    return new Error(error.message);
}
