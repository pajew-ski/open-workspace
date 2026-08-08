/**
 * Sync-Runner des Connector-Frameworks (SPEC §6.2).
 *
 * Ablauf eines Laufs für materialisierende Connectors:
 *  1. `probe` bestimmt die aktuelle Quell-Revision.
 *  2. Unveränderte Revision → **No-Op**: der Import-Graph wird nicht
 *     angefasst, nur der Lauf-Knoten in `graph/meta` aktualisiert.
 *  3. Geänderte Revision → `pull`, dann in EINER Transaktion:
 *     Import-Graph vollständig ersetzen (`replace: true` — der Graph ist
 *     ein Spiegel, kein Arbeitsbereich) + PROV-Tripel + Meta-Zustand.
 *
 * PROV (SPEC §6.2) liegt im Import-Graphen selbst, Subjekt ist die
 * Graph-IRI: `prov:wasDerivedFrom` (Quelle), `prov:generatedAtTime`,
 * `prov:wasAttributedTo` (Connector-Instanz), `ow:revision`. Der Runner
 * schreibt sie einheitlich — kein Connector wiederholt diese Logik.
 *
 * Fehlerbild: Quell-QUALITÄT (kaputte Dateien, unbekannte Prädikate)
 * bricht nie ab — sie landet im Quarantäne-Bericht. Nur INFRASTRUKTUR
 * (Netz, Auth, Konfiguration) führt zu status 'failed'; auch dann bleibt
 * der letzte gute Import unangetastet.
 */

import type { Quad } from '@rdfjs/types';
import { factory, namedNode, literal, typedLiteral } from '../rdf';
import { OW, PROV } from '../vocab';
import { getConnectorKind } from './catalog';
import { createGuardedFetch } from './http';
import { getConnector, runErrors, saveConnectorState, type GraphHandle } from './registry';
import type {
    ConnectorContext,
    ConnectorInstanceView,
    QuarantineEntry,
    SourceRef,
    SyncResult,
} from './types';

export interface SyncOptions {
    /** Basis-fetch — Tests injizieren hier einen Stub (Guard bleibt aktiv). */
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Zeitquelle, injizierbar für deterministische Tests. */
    now?: () => Date;
    onProgress?: (progress: { done: number; total?: number; note?: string }) => void;
}

function provQuads(view: ConnectorInstanceView, revision: string | undefined, nowIso: string): Quad[] {
    const graph = namedNode(view.targetGraph);
    const source = /^https?:\/\//.test(view.locator)
        ? namedNode(view.locator)
        : literal(view.locator);
    const quads: Quad[] = [
        factory.quad(graph, namedNode(PROV.wasDerivedFrom), source, graph),
        factory.quad(graph, namedNode(PROV.generatedAtTime), typedLiteral.dateTime(nowIso), graph),
        factory.quad(graph, namedNode(PROV.wasAttributedTo), namedNode(view.iri), graph),
    ];
    if (revision) {
        quads.push(factory.quad(graph, namedNode(OW.revision), literal(revision), graph));
    }
    return quads;
}

function summarize(quadCount: number, quarantined: QuarantineEntry[]): string {
    const base = `${quadCount} Aussagen importiert`;
    if (quarantined.length === 0) return `${base}.`;
    return `${base}, ${quarantined.length} Quell-Einheit(en) quarantäniert.`;
}

/**
 * Führt einen Sync-Lauf für eine registrierte Connector-Instanz aus.
 * Wirft nie wegen Quell-Qualität; Infrastrukturfehler werden als
 * status 'failed' zurückgegeben und in `graph/meta` protokolliert.
 */
export async function syncConnector(handle: GraphHandle, connectorId: string, options: SyncOptions = {}): Promise<SyncResult> {
    const now = options.now ?? (() => new Date());
    const view = await getConnector(handle, connectorId);
    if (!view) {
        throw new Error(`Connector "${connectorId}" ist nicht registriert.`);
    }
    const impl = getConnectorKind(view.kind);
    if (!impl) {
        return persistFailure(handle, view, now().toISOString(), `Connector-Art "${view.kind}" ist in dieser Version nicht implementiert.`);
    }
    if (impl.mode !== 'materialize' || !impl.pull) {
        return persistFailure(handle, view, now().toISOString(), `Connector-Art "${view.kind}" materialisiert nicht — nichts zu synchronisieren.`);
    }

    const quarantined: QuarantineEntry[] = [];
    const abort = new AbortController();
    const onOuterAbort = () => abort.abort();
    options.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const ctx: ConnectorContext = {
        store: handle.store,
        iri: handle.iri,
        signal: abort.signal,
        fetch: createGuardedFetch({
            fetchImpl: options.fetchImpl,
            signal: abort.signal,
            timeoutMs: options.timeoutMs,
        }),
        report: progress => options.onProgress?.(progress),
        quarantine: entry => quarantined.push(entry),
    };

    try {
        const config = impl.configFromLocator(view.locator);
        const probed = await impl.probe(config, ctx);
        const ref: SourceRef = { ...probed, id: view.id };
        const finishedAtIso = now().toISOString();

        // No-Op: Revision unverändert → Import-Graph bleibt unangetastet.
        if (ref.revision && view.revision && ref.revision === view.revision) {
            await handle.store.transaction(async tx => {
                await saveConnectorState({ store: tx, iri: handle.iri }, {
                    ...view,
                    syncState: 'idle',
                    modifiedAt: finishedAtIso,
                    lastRun: {
                        at: finishedAtIso,
                        revision: ref.revision,
                        summary: 'Revision unverändert — kein Import nötig.',
                        errors: [],
                    },
                });
            });
            return {
                connectorId: view.id,
                status: 'noop',
                revision: ref.revision,
                previousRevision: view.revision,
                added: 0,
                removed: 0,
                quarantined: [],
                message: 'Revision unverändert — kein Import nötig.',
                finishedAt: finishedAtIso,
            };
        }

        const pulled: Quad[] = [];
        for await (const quad of impl.pull(ref, ctx)) {
            pulled.push(quad);
        }
        const importFinishedIso = now().toISOString();
        const quads = [...pulled, ...provQuads(view, ref.revision, importFinishedIso)];

        let added = 0;
        let removed = 0;
        await handle.store.transaction(async tx => {
            const report = await tx.load(quads, namedNode(view.targetGraph), { replace: true });
            added = report.added;
            removed = report.removed;
            await saveConnectorState({ store: tx, iri: handle.iri }, {
                ...view,
                syncState: 'idle',
                revision: ref.revision ?? view.revision,
                modifiedAt: importFinishedIso,
                lastRun: {
                    at: importFinishedIso,
                    revision: ref.revision,
                    summary: summarize(pulled.length, quarantined),
                    errors: runErrors(quarantined),
                },
            });
        });

        return {
            connectorId: view.id,
            status: 'imported',
            revision: ref.revision,
            previousRevision: view.revision,
            added,
            removed,
            quarantined,
            message: summarize(pulled.length, quarantined),
            finishedAt: importFinishedIso,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return persistFailure(handle, view, now().toISOString(), message, quarantined);
    } finally {
        options.signal?.removeEventListener('abort', onOuterAbort);
    }
}

async function persistFailure(
    handle: GraphHandle,
    view: ConnectorInstanceView,
    finishedAtIso: string,
    message: string,
    quarantined: QuarantineEntry[] = [],
): Promise<SyncResult> {
    await handle.store.transaction(async tx => {
        await saveConnectorState({ store: tx, iri: handle.iri }, {
            ...view,
            syncState: 'error',
            modifiedAt: finishedAtIso,
            lastRun: {
                at: finishedAtIso,
                revision: view.revision,
                summary: `Synchronisierung fehlgeschlagen: ${message}`,
                errors: runErrors([{ source: view.locator, reason: message }, ...quarantined]),
            },
        });
    });
    return {
        connectorId: view.id,
        status: 'failed',
        previousRevision: view.revision,
        added: 0,
        removed: 0,
        quarantined,
        message: `Synchronisierung fehlgeschlagen: ${message}`,
        finishedAt: finishedAtIso,
    };
}
