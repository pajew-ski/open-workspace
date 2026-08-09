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
import type { FileSystemLike, RuntimeAdapter } from '@/lib/platform/runtime/types';
import { factory, namedNode, literal, typedLiteral } from '../rdf';
import { OW, PROV } from '../vocab';
import { replaceCanvasLayouts } from '../presentation/layout';
import { snapshotFileForGraph } from '../serialize/snapshot';
import { getConnectorKind } from './catalog';
import { createGuardedFetch } from './http';
import { getConnector, runErrors, saveConnectorState, type GraphHandle } from './registry';
import {
    ConnectorConflictError,
    type ConnectorContext,
    type ConnectorInstanceView,
    type PresentationGroup,
    type QuarantineEntry,
    type SourceRef,
    type SyncResult,
} from './types';

export interface SyncOptions {
    /** Basis-fetch — Tests injizieren hier einen Stub (Guard bleibt aktiv). */
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Zeitquelle, injizierbar für deterministische Tests. */
    now?: () => Date;
    /** Dateizugriff der Runtime — Pflicht für Datei-Connectors (obsidian-vault). */
    files?: FileSystemLike;
    /** Runtime-Adapter (SPEC §5.2) — Pflicht für git-backup (Git-Bindung). */
    runtime?: RuntimeAdapter;
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

function summarize(quadCount: number, quarantined: QuarantineEntry[], restoredGraphs: string[] = []): string {
    const parts = [`${quadCount} Aussagen importiert`];
    if (restoredGraphs.length > 0) {
        parts.push(`${restoredGraphs.length} Graph(en) wiederhergestellt`);
    }
    if (quarantined.length > 0) {
        parts.push(`${quarantined.length} Quell-Einheit(en) quarantäniert`);
    }
    return `${parts.join(', ')}.`;
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
    const presentationGroups: PresentationGroup[] = [];
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
        files: options.files,
        runtime: options.runtime,
        report: progress => options.onProgress?.(progress),
        quarantine: entry => quarantined.push(entry),
        presentation: group => presentationGroups.push(group),
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
                restoredGraphs: [],
                quarantined: [],
                message: 'Revision unverändert — kein Import nötig.',
                finishedAt: finishedAtIso,
            };
        }

        // Quads einsammeln; Store-Serialisierungs-Connectors (SPEC §8.2)
        // dürfen Quads mit expliziter Graph-Komponente liefern — sie werden
        // pro kanonischem Ziel-Graphen gruppiert und ersetzt. Nur
        // Snapshot-fähige Graphen sind wiederherstellbar (acl/vocab/
        // shapes/inferred nie); alles andere landet im Import-Graphen.
        const canRestore = impl.capabilities.restoresCanonicalGraphs === true;
        const pulled: Quad[] = [];
        const restoreByGraph = new Map<string, Quad[]>();
        for await (const quad of impl.pull(ref, ctx)) {
            if (
                canRestore &&
                quad.graph.termType === 'NamedNode' &&
                quad.graph.value !== view.targetGraph
            ) {
                if (snapshotFileForGraph(quad.graph.value, handle.iri.instanceBase) === null) {
                    ctx.quarantine({
                        source: quad.graph.value,
                        reason: 'Graph ist nicht wiederherstellbar (acl/vocab/shapes/inferred sind geschützt).',
                    });
                    continue;
                }
                const list = restoreByGraph.get(quad.graph.value) ?? [];
                list.push(quad);
                restoreByGraph.set(quad.graph.value, list);
                continue;
            }
            pulled.push(quad);
        }
        const importFinishedIso = now().toISOString();
        const quads = [...pulled, ...provQuads(view, ref.revision, importFinishedIso)];
        const restoredGraphs = [...restoreByGraph.keys()].sort();

        let added = 0;
        let removed = 0;
        await handle.store.transaction(async tx => {
            const report = await tx.load(quads, namedNode(view.targetGraph), { replace: true });
            added = report.added;
            removed = report.removed;
            // Wiederhergestellte kanonische Graphen: vollständiger Replace
            // in DERSELBEN Transaktion (SPEC §8.2 — Restore ist Teil des
            // Laufs, kein zweiter Codepfad).
            for (const [graphIri, graphQuads] of restoreByGraph) {
                await tx.load(graphQuads, namedNode(graphIri), { replace: true });
            }
            // Layout-Schicht (SPEC §9): gemeldete Gruppen ersetzen die
            // Layouts ihrer Canvases in graph/<u>/presentation — in
            // derselben Transaktion wie der Import-Replace.
            if (presentationGroups.length > 0) {
                await replaceCanvasLayouts(tx, handle.iri, presentationGroups);
            }
            await saveConnectorState({ store: tx, iri: handle.iri }, {
                ...view,
                syncState: 'idle',
                revision: ref.revision ?? view.revision,
                modifiedAt: importFinishedIso,
                lastRun: {
                    at: importFinishedIso,
                    revision: ref.revision,
                    summary: summarize(pulled.length, quarantined, restoredGraphs),
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
            restoredGraphs,
            quarantined,
            message: summarize(pulled.length, quarantined, restoredGraphs),
            finishedAt: importFinishedIso,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return persistFailure(handle, view, now().toISOString(), message, quarantined);
    } finally {
        options.signal?.removeEventListener('abort', onOuterAbort);
    }
}

export interface PushResult {
    connectorId: string;
    status: 'pushed' | 'conflict' | 'failed';
    /** Quell-Revision nach dem Schreiben (bei Erfolg). */
    revision?: string;
    /** html_url bei PR-Schreibweg. */
    url?: string;
    /** Abweichungen bei status 'conflict' (aus dem ConflictReport). */
    conflicts: Array<{ path?: string; reason: string }>;
    message: string;
    finishedAt: string;
}

/**
 * Führt einen Export-Lauf (`push`, SPEC §6.2) für eine registrierte
 * Connector-Instanz aus. Revisionskonflikte (Quelle extern verändert)
 * werden als status 'conflict' gemeldet und als Sync-Zustand
 * protokolliert — geschrieben wird dann nichts.
 */
export async function pushConnector(handle: GraphHandle, connectorId: string, options: SyncOptions = {}): Promise<PushResult> {
    const now = options.now ?? (() => new Date());
    const view = await getConnector(handle, connectorId);
    if (!view) {
        throw new Error(`Connector "${connectorId}" ist nicht registriert.`);
    }
    const impl = getConnectorKind(view.kind);
    const finishedEarlyIso = now().toISOString();
    if (!impl || !impl.push) {
        return {
            connectorId,
            status: 'failed',
            conflicts: [],
            message: `Connector-Art "${view.kind}" unterstützt keinen Export.`,
            finishedAt: finishedEarlyIso,
        };
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
        files: options.files,
        runtime: options.runtime,
        report: progress => options.onProgress?.(progress),
        quarantine: entry => quarantined.push(entry),
        // Export-Läufe importieren nichts — Layout-Meldungen wären ein
        // Connector-Fehler und verhallen bewusst.
        presentation: () => undefined,
    };

    try {
        const ref: SourceRef = {
            id: view.id,
            kind: view.kind,
            locator: view.locator,
            // Letzte gepullte Revision — Grundlage der Konfliktregel §6.2.
            revision: view.revision,
        };
        const receipt = await impl.push(ref, { added: [], removed: [] }, ctx);
        const finishedAtIso = now().toISOString();
        const message = receipt.mode === 'pull-request' && receipt.url
            ? `Export als Pull Request angelegt: ${receipt.url}`
            : 'Export in die Quelle geschrieben.';
        await handle.store.transaction(async tx => {
            await saveConnectorState({ store: tx, iri: handle.iri }, {
                ...view,
                syncState: 'idle',
                revision: receipt.revision,
                modifiedAt: finishedAtIso,
                lastRun: {
                    at: finishedAtIso,
                    revision: receipt.revision,
                    summary: message,
                    errors: runErrors(quarantined),
                },
            });
        });
        return {
            connectorId,
            status: 'pushed',
            revision: receipt.revision,
            url: receipt.url,
            conflicts: [],
            message,
            finishedAt: finishedAtIso,
        };
    } catch (error) {
        const finishedAtIso = now().toISOString();
        if (error instanceof ConnectorConflictError) {
            await handle.store.transaction(async tx => {
                await saveConnectorState({ store: tx, iri: handle.iri }, {
                    ...view,
                    syncState: 'conflict',
                    modifiedAt: finishedAtIso,
                    lastRun: {
                        at: finishedAtIso,
                        revision: view.revision,
                        summary: `Export blockiert: ${error.message}`,
                        errors: runErrors(error.report.conflicts.map(conflict => ({
                            source: conflict.path ?? view.locator,
                            reason: conflict.reason,
                        }))),
                    },
                });
            });
            return {
                connectorId,
                status: 'conflict',
                conflicts: error.report.conflicts,
                message: error.message,
                finishedAt: finishedAtIso,
            };
        }
        const message = error instanceof Error ? error.message : String(error);
        await handle.store.transaction(async tx => {
            await saveConnectorState({ store: tx, iri: handle.iri }, {
                ...view,
                syncState: 'error',
                modifiedAt: finishedAtIso,
                lastRun: {
                    at: finishedAtIso,
                    revision: view.revision,
                    summary: `Export fehlgeschlagen: ${message}`,
                    errors: runErrors([{ source: view.locator, reason: message }, ...quarantined]),
                },
            });
        });
        return {
            connectorId,
            status: 'failed',
            conflicts: [],
            message: `Export fehlgeschlagen: ${message}`,
            finishedAt: finishedAtIso,
        };
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
        restoredGraphs: [],
        quarantined,
        message: `Synchronisierung fehlgeschlagen: ${message}`,
        finishedAt: finishedAtIso,
    };
}
