/**
 * Einzelne Query-View: Details + Löschen (GRAPH_CORE_SPEC §9, M5).
 * Löschen holt die UI-Bestätigung vor dem Aufruf ein (AGENTS.md,
 * Safety-Regeln).
 */

import { NextRequest, NextResponse } from 'next/server';
import {persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { getUserGraph } from '@/lib/graph/server/context';
import { deleteQueryView, getQueryView } from '@/lib/graph/views/registry';

interface RouteContext {
    params: Promise<{ id: string }>;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

export async function GET(_request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    if (!ID_PATTERN.test(id)) {
        return NextResponse.json({ error: 'Ungültige View-ID' }, { status: 400 });
    }
    try {
        const handle = await getUserGraph();
        const view = await getQueryView(handle, id);
        if (!view) {
            return NextResponse.json({ error: 'View nicht gefunden' }, { status: 404 });
        }
        return NextResponse.json({ view });
    } catch (error) {
        return NextResponse.json(
            { error: 'View nicht ladbar', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    if (!ID_PATTERN.test(id)) {
        return NextResponse.json({ error: 'Ungültige View-ID' }, { status: 400 });
    }
    try {
        const handle = await getUserGraph();
        const deleted = await deleteQueryView(handle, id);
        if (!deleted) {
            return NextResponse.json({ error: 'View nicht gefunden' }, { status: 404 });
        }
        await persistServerGraphSnapshot();
        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json(
            { error: 'View konnte nicht gelöscht werden', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}
