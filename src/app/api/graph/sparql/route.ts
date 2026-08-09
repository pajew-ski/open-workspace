/**
 * SPARQL 1.1 Protocol Endpoint (SPEC §7.1, M2).
 *
 * GET  /api/graph/sparql?query=…&default-graph-uri=…&named-graph-uri=…
 * POST /api/graph/sparql  (application/sparql-query |
 *                          application/sparql-update |
 *                          application/x-www-form-urlencoded)
 *
 * Transport-Hülle um executeSparqlProtocol() — Dataset-Klammern, Update-
 * Schutz und Content Negotiation liegen im Protocol-Layer, nicht hier.
 */

import type { NextRequest } from 'next/server';
import { getServerGraph } from '@/lib/graph/server/instance';
import { executeSparqlProtocol, type SparqlProtocolRequest } from '@/lib/graph/sparql/protocol';
import { invalidateSearchIndexes } from '@/lib/graph/search/cache';

const MAX_BODY_BYTES = 1_000_000;

function toResponse(result: { status: number; contentType: string; body: string }): Response {
    return new Response(result.body === '' ? null : result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
    });
}

async function handle(request: NextRequest, method: 'GET' | 'POST'): Promise<Response> {
    try {
        const { store, iri } = await getServerGraph();
        const url = request.nextUrl;

        const protocolRequest: SparqlProtocolRequest = {
            method,
            contentType: request.headers.get('content-type'),
            accept: request.headers.get('accept'),
            query: url.searchParams.get('query'),
            update: null,
            body: null,
            defaultGraphUris: url.searchParams.getAll('default-graph-uri'),
            namedGraphUris: url.searchParams.getAll('named-graph-uri'),
        };

        if (method === 'POST') {
            const body = await request.text();
            if (body.length > MAX_BODY_BYTES) {
                return new Response('Request-Body zu groß (max. 1 MB).\n', { status: 413 });
            }
            const contentType = (protocolRequest.contentType ?? '').split(';')[0].trim().toLowerCase();
            if (contentType === 'application/x-www-form-urlencoded') {
                const form = new URLSearchParams(body);
                protocolRequest.query = form.get('query') ?? protocolRequest.query;
                protocolRequest.update = form.get('update');
                protocolRequest.defaultGraphUris = [
                    ...(protocolRequest.defaultGraphUris ?? []),
                    ...form.getAll('default-graph-uri'),
                ];
                protocolRequest.namedGraphUris = [
                    ...(protocolRequest.namedGraphUris ?? []),
                    ...form.getAll('named-graph-uri'),
                ];
            } else {
                protocolRequest.body = body;
            }
        }

        const result = await executeSparqlProtocol(store, iri, protocolRequest);
        // Ein erfolgreiches UPDATE (204) läuft am Mutations-Pfad von
        // server/instance.ts vorbei — Suchindizes hier invalidieren (M8).
        if (result.status === 204) {
            invalidateSearchIndexes(store);
        }
        return toResponse(result);
    } catch (error) {
        console.error('SPARQL Endpoint Error:', error);
        return new Response('Interner Fehler im SPARQL-Endpoint.\n', { status: 500 });
    }
}

export async function GET(request: NextRequest): Promise<Response> {
    return handle(request, 'GET');
}

export async function POST(request: NextRequest): Promise<Response> {
    return handle(request, 'POST');
}
