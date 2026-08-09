/**
 * Generierte Query-Views (GRAPH_CORE_SPEC §9, M5).
 *
 * GET  /api/graph/views — gespeicherte Views (ow:QueryView in graph/meta).
 * POST /api/graph/views — legt eine View an (Name, SPARQL-CONSTRUCT/
 *      DESCRIBE, Layout-Verfahren). Die Query wird beim Anlegen einmal
 *      probeweise aufgelöst, damit keine kaputte View gespeichert wird —
 *      lieber ein klarer Fehler als eine tote Karteileiche (Invariante 10).
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseBody, createGraphViewSchema } from '@/lib/api/validation';
import { getServerGraph, persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { createQueryView, deleteQueryView, listQueryViews, resolveQueryView } from '@/lib/graph/views/registry';

export async function GET() {
    try {
        const handle = await getServerGraph();
        const views = await listQueryViews(handle);
        return NextResponse.json({ views });
    } catch (error) {
        return NextResponse.json(
            { error: 'Views nicht ladbar', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}

export async function POST(request: NextRequest) {
    const parsed = await parseBody(createGraphViewSchema, request);
    if (!parsed.ok) return parsed.response;

    try {
        const handle = await getServerGraph();
        const view = await createQueryView(handle, {
            name: parsed.data.name,
            queryText: parsed.data.queryText,
            layoutMethod: parsed.data.layoutMethod,
        });
        try {
            await resolveQueryView(handle, view.id);
        } catch (error) {
            await deleteQueryView(handle, view.id);
            return NextResponse.json(
                { error: 'Query ist als View nicht auflösbar', details: error instanceof Error ? error.message : 'unknown' },
                { status: 400 },
            );
        }
        await persistServerGraphSnapshot();
        return NextResponse.json({ view }, { status: 201 });
    } catch (error) {
        return NextResponse.json(
            { error: 'View konnte nicht angelegt werden', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 },
        );
    }
}
