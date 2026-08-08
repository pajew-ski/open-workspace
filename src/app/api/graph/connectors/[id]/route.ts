/**
 * Einzelne Connector-Instanz: Details + Löschen (GRAPH_CORE_SPEC §6, M3).
 * Löschen entfernt Registry-Knoten UND Import-Graphen — die UI holt davor
 * die Bestätigung ein (AGENTS.md, Safety-Regeln).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerGraph, persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { deleteConnector, getConnector } from '@/lib/graph/connectors/registry';

interface RouteContext {
    params: Promise<{ id: string }>;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

export async function GET(_request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    if (!ID_PATTERN.test(id)) {
        return NextResponse.json({ error: 'Ungültige Connector-ID' }, { status: 400 });
    }
    try {
        const handle = await getServerGraph();
        const connector = await getConnector(handle, id);
        if (!connector) {
            return NextResponse.json({ error: 'Connector nicht gefunden' }, { status: 404 });
        }
        return NextResponse.json({ connector });
    } catch (error) {
        return NextResponse.json(
            { error: 'Connector nicht ladbar', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    if (!ID_PATTERN.test(id)) {
        return NextResponse.json({ error: 'Ungültige Connector-ID' }, { status: 400 });
    }
    try {
        const handle = await getServerGraph();
        const deleted = await deleteConnector(handle, id);
        if (!deleted) {
            return NextResponse.json({ error: 'Connector nicht gefunden' }, { status: 404 });
        }
        await persistServerGraphSnapshot();
        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json(
            { error: 'Connector konnte nicht gelöscht werden', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}
