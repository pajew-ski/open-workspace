/**
 * Dereferenzierbare Entitäts-IRIs (SPEC §17.5, M13).
 *
 * „Entitäts-IRIs im öffentlichen Teil müssen dereferenzieren: `GET <iri>`
 * mit Content Negotiation liefert `DESCRIBE`-Ergebnis in Turtle/JSON-LD/
 * HTML." Genau das ist diese Route: Der Pfad `u/<userId>/<type>/<id>`
 * ist die Fortsetzung der Instanz-Base aus §3.2 — steht `OW_INSTANCE_BASE`
 * auf der eigenen Adresse, ist jede Entitäts-IRI damit eine echte URL.
 *
 * **Ehrliche Grenze**: Ohne HTTP-Instanz-Base (Default `urn:ow:<uuid>:`)
 * sind die IRIs URNs und *nicht* dereferenzierbar. Die Route antwortet
 * dann mit 404 und dem Hinweis, statt eine Auflösbarkeit vorzuspielen,
 * die die IRIs nicht haben.
 *
 * Das Dataset kommt aus dem Grant — anonym also aus den öffentlichen
 * Graphen. Ein Knoten außerhalb des Datasets ist leer, und leer sieht aus
 * wie „gibt es nicht" (§17.3: keine Existenzbestätigung).
 */

import { NextResponse } from 'next/server';
import { getRequestGraph } from '@/lib/graph/server/context';
import { negotiate } from '@/lib/graph/sparql/protocol';
import { describeEntity, entityHtml } from '@/lib/graph/projection/dereference';
import { publicRateLimit } from '@/lib/graph/authz/public-limits';

export const dynamic = 'force-dynamic';

const TYPES = ['text/turtle', 'application/ld+json', 'text/html'];

interface RouteContext {
    params: Promise<{ userId: string; type: string; id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
    const { userId, type, id } = await context.params;
    try {
        const { store, iri, grant, identity } = await getRequestGraph();
        const limited = publicRateLimit(request, identity.authenticated ? grant.identity : null);
        if (limited) return limited;

        if (!iri.instanceBase.startsWith('http')) {
            return NextResponse.json(
                {
                    error: 'Diese Installation benutzt URN-Entitäts-IRIs und ist nicht dereferenzierbar.',
                    hint: 'Setze OW_INSTANCE_BASE auf die öffentliche Adresse dieser Installation (SPEC §3.2).',
                },
                { status: 404 },
            );
        }

        const entityIri = `${iri.instanceBase}u/${encodeURIComponent(userId)}/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
        const quads = await describeEntity(store, entityIri, grant.readableGraphs);
        const media = negotiate(request.headers.get('accept'), TYPES, 'text/turtle');
        if (!media) {
            return new Response(`Nicht verhandelbar. Unterstützt: ${TYPES.join(', ')}\n`, { status: 406 });
        }

        const headers = {
            'Content-Type': `${media}; charset=utf-8`,
            'Access-Control-Allow-Origin': '*',
            Vary: 'Accept, Authorization',
            Link: `<${entityIri}>; rel="canonical"`,
        };
        if (media === 'text/html') {
            return new Response(entityHtml(entityIri, quads), { headers });
        }
        const { serializeRdf } = await import('@/lib/graph/serialize/io');
        return new Response(serializeRdf(quads, media), { headers });
    } catch (error) {
        console.error('Dereference Error:', error);
        return NextResponse.json({ error: 'Entität nicht auflösbar.' }, { status: 500 });
    }
}
