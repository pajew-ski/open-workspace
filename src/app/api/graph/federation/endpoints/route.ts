/**
 * Registry föderierter SPARQL-Endpoints (SPEC §7.4, M11).
 *
 * GET  /api/graph/federation/endpoints → Liste + Runtime-Fähigkeiten
 * POST /api/graph/federation/endpoints → registrieren
 *
 * Die Einträge sind `ow:FederatedEndpoint`-Knoten in `graph/meta` — die
 * Registry IST der Graph, keine Nebenkonfiguration.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import {persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { getUserGraph } from '@/lib/graph/server/context';
import {
    createFederatedEndpoint,
    listFederatedEndpoints,
    TRUST_LEVELS,
    TRUST_LEVEL_LABELS,
} from '@/lib/graph/federation/registry';
import { createNodeRuntimeAdapter } from '@/lib/platform/runtime/server';
import { FEDERATION_DEFAULTS } from '@/lib/graph/federation/remote';

const createSchema = z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    url: z.string().min(1).max(2000),
    trustLevel: z.enum(TRUST_LEVELS).optional(),
    description: z.string().max(2000).optional(),
}).strict();

export async function GET(): Promise<Response> {
    try {
        const handle = await getUserGraph();
        const capabilities = createNodeRuntimeAdapter().capabilities;
        return NextResponse.json({
            endpoints: await listFederatedEndpoints(handle),
            trustLevels: TRUST_LEVELS.map(level => ({ level, label: TRUST_LEVEL_LABELS[level] })),
            capabilities: {
                outbound: capabilities.federationOutbound,
                inbound: capabilities.federationInbound,
            },
            inboundEndpoint: '/api/graph/federation/sparql',
            limits: {
                timeoutMs: FEDERATION_DEFAULTS.timeoutMs,
                maxRows: FEDERATION_DEFAULTS.maxRows,
                maxBindings: FEDERATION_DEFAULTS.maxBindings,
            },
        });
    } catch (error) {
        console.error('Federation Endpoints Error:', error);
        return NextResponse.json({ error: 'Endpoints konnten nicht gelesen werden.' }, { status: 500 });
    }
}

export async function POST(request: Request): Promise<Response> {
    let parsed: z.infer<typeof createSchema>;
    try {
        parsed = createSchema.parse(await request.json());
    } catch (error) {
        const message = error instanceof z.ZodError
            ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
            : 'Ungültiger Request-Body.';
        return NextResponse.json({ error: message }, { status: 400 });
    }
    try {
        const handle = await getUserGraph();
        const endpoint = await createFederatedEndpoint(handle, parsed);
        await persistServerGraphSnapshot();
        return NextResponse.json({ endpoint }, { status: 201 });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Endpoint konnte nicht angelegt werden.';
        const status = message.includes('existiert bereits') ? 409
            : /Ungültige|blockiert|erlaubt/.test(message) ? 400
                : 500;
        if (status === 500) console.error('Federation Endpoint Create Error:', error);
        return NextResponse.json({ error: message }, { status });
    }
}
