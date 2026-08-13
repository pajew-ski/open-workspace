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
import { getRequestGraph } from '@/lib/graph/server/context';
import { persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { executeSparqlProtocol } from '@/lib/graph/sparql/protocol';
import { sparqlHttpResponse, sparqlRequestFromHttp, SparqlBodyTooLargeError } from '@/lib/graph/sparql/http';
import { invalidateSearchIndexes } from '@/lib/graph/search/cache';
import { createFederationResolver } from '@/lib/graph/federation/host.server';
import { summarizeFederation } from '@/lib/graph/federation/service';

async function handle(request: NextRequest, method: 'GET' | 'POST'): Promise<Response> {
    try {
        const { store, iri, grant } = await getRequestGraph();

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
            // Dataset-Resolver (§17.3): lesen nur das Erlaubte, schreiben
            // nur ins Freigegebene — injiziert, nicht nachgefiltert.
            allowedGraphs: grant.readableGraphs,
            writableGraphs: grant.writableGraphs ?? [],
            // C1: Ein Kausalmodell IST sein Named Graph — er entsteht
            // deshalb beim ersten Schreibvorgang und kann nicht vorher in
            // der Liste stehen. Das Muster gilt nur für den eigenen
            // Namensraum und nur für Graphen, die es noch nicht gibt.
            writableScopes: grant.writableScopes ?? [],
        });
        // Ein erfolgreiches UPDATE (204) läuft am Mutations-Pfad von
        // server/instance.ts vorbei — Suchindizes hier invalidieren (M8)
        // UND den Snapshot schreiben. Ohne das Zweite überlebt kein per
        // SPARQL geschriebenes Tripel den nächsten Neustart; für einen von
        // Hand modellierten DAG (CAUSAL_LAYER_SPEC C0) ist der Editor der
        // vorgesehene Schreibweg, und stiller Verlust wäre dort fatal.
        if (result.status === 204) {
            invalidateSearchIndexes(store);
            await persistServerGraphSnapshot();
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
