/**
 * Sync-Lauf einer Connector-Instanz (GRAPH_CORE_SPEC §6.2, M3).
 *
 * Antwortet immer mit dem vollständigen Laufbericht inkl. Quarantäne —
 * Quell-Qualität bricht einen Import nie ab (M3-Abnahme), deshalb ist
 * auch ein Lauf mit quarantänierten Einheiten ein 200. Nur wenn die
 * Infrastruktur scheitert (Netz, Auth, Konfiguration), meldet `status:
 * 'failed'` das ehrlich — ebenfalls als 200 mit Bericht, denn der Lauf
 * selbst wurde ordnungsgemäß ausgeführt und protokolliert.
 */

import { NextRequest, NextResponse } from 'next/server';
import {persistServerGraphSnapshot, reprojectWorkspaceFiles } from '@/lib/graph/server/instance';
import { getRequestGraph, getUserGraph } from '@/lib/graph/server/context';
import { snapshotExportRefusal } from '@/lib/graph/authz/resolve';
import { getConnector } from '@/lib/graph/connectors/registry';
import { syncConnector } from '@/lib/graph/connectors/sync';
import { createNodeFileSystem } from '@/lib/platform/runtime/node-fs';
import { createNodeRuntimeAdapter } from '@/lib/platform/runtime/server';

interface RouteContext {
    params: Promise<{ id: string }>;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

export async function POST(_request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    if (!ID_PATTERN.test(id)) {
        return NextResponse.json({ error: 'Ungültige Connector-ID' }, { status: 400 });
    }
    try {
        const handle = await getUserGraph();
        const existing = await getConnector(handle, id);
        if (!existing) {
            return NextResponse.json({ error: 'Connector nicht gefunden' }, { status: 404 });
        }
        const refused = await refuseSnapshotExport(existing.kind);
        if (refused) return refused;
        const result = await syncConnector(handle, id, {
            files: createNodeFileSystem(),
            runtime: createNodeRuntimeAdapter(),
        });
        // Wiederhergestellte kanonische Graphen (git-backup, SPEC §8.2):
        // die Datei-Projektionen folgen dem Store.
        if (result.restoredGraphs.length > 0) {
            await reprojectWorkspaceFiles();
        }
        await persistServerGraphSnapshot();
        const connector = await getConnector(handle, id);
        return NextResponse.json({ result, connector });
    } catch (error) {
        return NextResponse.json(
            { error: 'Synchronisierung nicht ausführbar', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}

/**
 * §17.4: Ein Git-Backup nimmt den ganzen Snapshot mit. Wer ihn ausliefert,
 * muss jeden enthaltenen Graphen verwalten dürfen.
 */
async function refuseSnapshotExport(kind: string): Promise<Response | null> {
    if (kind !== 'git-backup') return null;
    const { store, iri, grant } = await getRequestGraph();
    const existing = (await store.graphs()).map(g => g.value);
    const refusal = snapshotExportRefusal(grant, iri.instanceBase, existing);
    return refusal ? NextResponse.json({ error: 'Backup nicht erlaubt', details: refusal }, { status: 403 }) : null;
}
