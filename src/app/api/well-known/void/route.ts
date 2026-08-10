/**
 * `GET /.well-known/void` (SPEC §17.5, M13) — Selbstbeschreibung des
 * öffentlichen Teilgraphen.
 *
 * Die Route liegt technisch unter `/api/well-known/void`; die Adresse aus
 * der Spezifikation wird in `next.config.ts` daraufhin umgeschrieben (ein
 * Verzeichnis mit führendem Punkt ist im App-Router kein Routen-Segment).
 *
 * Was ein Client hier sieht, ist **sein** Umfang: das Dataset kommt aus
 * demselben Grant wie jede Query. Anonym heißt: die öffentlichen Graphen.
 * Rate-Limit und Ergebnisgrenzen gelten wie für jeden anonymen Zugriff.
 */

import { NextResponse } from 'next/server';
import { getRequestGraph } from '@/lib/graph/server/context';
import { buildVoidDescription, voidQuads } from '@/lib/graph/projection/void';
import { serializeRdf } from '@/lib/graph/serialize/io';
import { negotiate } from '@/lib/graph/sparql/protocol';
import { publicRateLimit } from '@/lib/graph/authz/public-limits';

export const dynamic = 'force-dynamic';

const TYPES = ['text/turtle', 'application/ld+json', 'application/json'];

export async function GET(request: Request): Promise<Response> {
    try {
        const { store, iri, grant, identity } = await getRequestGraph();
        const limited = publicRateLimit(request, identity.authenticated ? grant.identity : null);
        if (limited) return limited;

        const description = await buildVoidDescription(store, iri, grant.readableGraphs);
        const media = negotiate(request.headers.get('accept'), TYPES, 'text/turtle');
        if (media === 'application/json') {
            return NextResponse.json(description);
        }
        const body = serializeRdf(voidQuads(description, '/api/graph/federation/sparql'), media);
        return new Response(body, {
            headers: {
                'Content-Type': `${media}; charset=utf-8`,
                'Access-Control-Allow-Origin': '*',
                Vary: 'Accept, Authorization',
            },
        });
    } catch (error) {
        console.error('VoID Error:', error);
        return NextResponse.json({ error: 'VoID-Beschreibung nicht ermittelbar.' }, { status: 500 });
    }
}
