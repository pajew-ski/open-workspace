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
import { executeSparqlProtocol } from '@/lib/graph/sparql/protocol';
import { sparqlHttpResponse, sparqlRequestFromHttp, SparqlBodyTooLargeError } from '@/lib/graph/sparql/http';
import { invalidateSearchIndexes } from '@/lib/graph/search/cache';
import { createFederationResolver } from '@/lib/graph/federation/host.server';
import { summarizeFederation } from '@/lib/graph/federation/service';

async function handle(request: NextRequest, method: 'GET' | 'POST'): Promise<Response> {
    try {
        const { store, iri } = await getServerGraph();

        let protocolRequest;
        try {
            protocolRequest = await sparqlRequestFromHttp(request, method);
        } catch (error) {
            if (error instanceof SparqlBodyTooLargeError) {
                return new Response(`${error.message}\n`, { status: 413 });
            }
            throw error;
        }

        // Föderation (SPEC §7.4, M11): `SERVICE` gegen registrierte
        // Endpoints wird VOR der lokalen Ausführung aufgelöst.
        const federation = createFederationResolver();
        const result = await executeSparqlProtocol(store, iri, protocolRequest, {
            federation: federation.resolve,
        });
        // Ein erfolgreiches UPDATE (204) läuft am Mutations-Pfad von
        // server/instance.ts vorbei — Suchindizes hier invalidieren (M8).
        if (result.status === 204) {
            invalidateSearchIndexes(store);
        }
        const report = federation.report();
        return sparqlHttpResponse(
            result,
            // HTTP-Header vertragen kein UTF-8 — die Kurzfassung geht
            // ASCII-bereinigt raus (der volle Bericht steht im Server-Log).
            report.calls.length > 0
                ? { 'X-OW-Federation': summarizeFederation(report).replace(/[^\x20-\x7E]/g, '?') }
                : {},
        );
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
