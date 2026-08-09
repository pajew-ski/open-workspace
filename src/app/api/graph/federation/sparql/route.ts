/**
 * Eingehender Föderations-Endpoint (SPEC §7.4, M11).
 *
 * GET|POST /api/graph/federation/sparql — SPARQL 1.1 Protocol, read-only,
 * für fremde Workspaces und SPARQL-Clients.
 *
 * Reine Transport-Hülle: Identität → erlaubtes Dataset (Injektion, kein
 * Nachfilter), Rate-Limit, Zeit- und Ergebnis-Limit liegen in
 * `src/lib/graph/federation/inbound.ts`. Ohne gültiges Token ist das
 * Dataset leer — die Query läuft, sieht aber nichts.
 */

import { getFederationHost } from '@/lib/graph/federation/host.server';

export const dynamic = 'force-dynamic';

async function handle(request: Request, method: 'GET' | 'POST'): Promise<Response> {
    try {
        return await getFederationHost().handle(request, method);
    } catch (error) {
        console.error('Federation Endpoint Error:', error);
        return new Response('Interner Fehler im Föderations-Endpoint.\n', {
            status: 500,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
    }
}

export async function GET(request: Request): Promise<Response> {
    return handle(request, 'GET');
}

export async function POST(request: Request): Promise<Response> {
    return handle(request, 'POST');
}

export async function OPTIONS(): Promise<Response> {
    return getFederationHost().options();
}
