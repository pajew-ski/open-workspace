/**
 * Gespeicherte Queries als Graph-Entitäten (GRAPH_CORE_SPEC §7.1/§9 —
 * M5-Views, erweitert mit dem SPARQL-Editor aus M2).
 *
 * GET  /api/graph/views — gespeicherte Queries (ow:QueryView in graph/meta).
 * POST /api/graph/views — legt eine gespeicherte Query an. Graph-förmige
 *      Queries (CONSTRUCT/DESCRIBE) werden beim Anlegen einmal probeweise
 *      als View aufgelöst; SELECT/ASK werden probeweise ausgeführt —
 *      lieber ein klarer Fehler als eine tote Karteileiche (Invariante 10).
 *      Updates sind nicht speicherbar (lesende Queries, SPEC §7.1).
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseBody, createGraphViewSchema } from '@/lib/api/validation';
import {persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { getRequestGraph, getUserGraph } from '@/lib/graph/server/context';
import { createQueryView, deleteQueryView, listQueryViews, resolveQueryView } from '@/lib/graph/views/registry';
import { isGraphQuery, isReadQuery } from '@/lib/graph/sparql/classify';
import { resolveDataset } from '@/lib/graph/sparql/protocol';

export async function GET() {
    try {
        const handle = await getUserGraph();
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

    if (!isReadQuery(parsed.data.queryText)) {
        return NextResponse.json(
            { error: 'Nur lesende Queries sind speicherbar', details: 'SELECT, ASK, CONSTRUCT oder DESCRIBE — Updates werden nicht als gespeicherte Query abgelegt.' },
            { status: 400 },
        );
    }

    try {
        const { store, iri, grant } = await getRequestGraph();
        const handle = { store, iri };
        const view = await createQueryView(handle, {
            name: parsed.data.name,
            queryText: parsed.data.queryText,
            layoutMethod: parsed.data.layoutMethod,
        });
        try {
            if (isGraphQuery(parsed.data.queryText)) {
                await resolveQueryView(handle, view.id, { allowedGraphs: grant.readableGraphs });
            } else {
                // SELECT/ASK: probeweise ausführen (Syntax + Dataset), Ergebnis verwerfen.
                const dataset = await resolveDataset(handle.store, handle.iri, undefined, {
                    allowedGraphs: grant.readableGraphs,
                });
                await handle.store.query(parsed.data.queryText, {
                    defaultGraphs: dataset.defaultGraphs,
                    namedGraphs: dataset.namedGraphs,
                    timeoutMs: 30_000,
                });
            }
        } catch (error) {
            await deleteQueryView(handle, view.id);
            return NextResponse.json(
                { error: 'Query ist nicht ausführbar', details: error instanceof Error ? error.message : 'unknown' },
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
