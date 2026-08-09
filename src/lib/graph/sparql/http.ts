/**
 * HTTP-Abbildung des SPARQL 1.1 Protocol (SPEC §7.1).
 *
 * Eine Quelle für alle Endpunkte, die das Protokoll sprechen: die interne
 * Route (`/api/graph/sparql`) und der eingehende Föderations-Endpoint
 * (`/api/graph/federation/sparql`, SPEC §7.4). Die Sicherheitsentscheidungen
 * liegen weiterhin im Executor (`protocol.ts`) — hier steht nur, wie eine
 * HTTP-Anfrage in `SparqlProtocolRequest` übersetzt wird.
 */

import type { SparqlProtocolRequest, SparqlProtocolResponse } from './protocol';

export const MAX_SPARQL_BODY_BYTES = 1_000_000;

export class SparqlBodyTooLargeError extends Error {
    constructor(readonly maxBytes: number) {
        super(`Request-Body zu groß (max. ${Math.round(maxBytes / 1000)} kB).`);
        this.name = 'SparqlBodyTooLargeError';
    }
}

/** Baut die Protokoll-Anfrage aus einer HTTP-Anfrage (GET oder POST). */
export async function sparqlRequestFromHttp(
    request: Request,
    method: 'GET' | 'POST',
    options: { maxBodyBytes?: number } = {},
): Promise<SparqlProtocolRequest> {
    const url = new URL(request.url);
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
    if (method !== 'POST') return protocolRequest;

    const body = await request.text();
    const maxBytes = options.maxBodyBytes ?? MAX_SPARQL_BODY_BYTES;
    if (body.length > maxBytes) throw new SparqlBodyTooLargeError(maxBytes);

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
    return protocolRequest;
}

/** Protokoll-Antwort → HTTP-Antwort (204 trägt keinen Body). */
export function sparqlHttpResponse(
    result: SparqlProtocolResponse,
    extraHeaders: Record<string, string> = {},
): Response {
    return new Response(result.body === '' ? null : result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType, ...extraHeaders },
    });
}
