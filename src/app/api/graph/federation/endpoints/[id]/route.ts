/**
 * Einzelner föderierter Endpoint (SPEC §7.4, M11).
 *
 * GET    /api/graph/federation/endpoints/[id] → lesen
 * PATCH  /api/graph/federation/endpoints/[id] → ändern (u. a. Vertrauensstufe)
 * DELETE /api/graph/federation/endpoints/[id] → entfernen
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerGraph, persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import {
    deleteFederatedEndpoint,
    getFederatedEndpoint,
    updateFederatedEndpoint,
    TRUST_LEVELS,
} from '@/lib/graph/federation/registry';

interface RouteContext {
    params: Promise<{ id: string }>;
}

const patchSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    url: z.string().min(1).max(2000).optional(),
    trustLevel: z.enum(TRUST_LEVELS).optional(),
    description: z.string().max(2000).nullable().optional(),
}).strict();

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const endpoint = await getFederatedEndpoint(await getServerGraph(), id);
        if (!endpoint) {
            return NextResponse.json({ error: `Endpoint "${id}" existiert nicht.` }, { status: 404 });
        }
        return NextResponse.json({ endpoint });
    } catch (error) {
        console.error('Federation Endpoint Error:', error);
        return NextResponse.json({ error: 'Endpoint konnte nicht gelesen werden.' }, { status: 500 });
    }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    let parsed: z.infer<typeof patchSchema>;
    try {
        parsed = patchSchema.parse(await request.json());
    } catch (error) {
        const message = error instanceof z.ZodError
            ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
            : 'Ungültiger Request-Body.';
        return NextResponse.json({ error: message }, { status: 400 });
    }
    try {
        const endpoint = await updateFederatedEndpoint(await getServerGraph(), id, parsed);
        if (!endpoint) {
            return NextResponse.json({ error: `Endpoint "${id}" existiert nicht.` }, { status: 404 });
        }
        await persistServerGraphSnapshot();
        return NextResponse.json({ endpoint });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Endpoint konnte nicht geändert werden.';
        const status = /Ungültige|blockiert|erlaubt/.test(message) ? 400 : 500;
        if (status === 500) console.error('Federation Endpoint Update Error:', error);
        return NextResponse.json({ error: message }, { status });
    }
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const removed = await deleteFederatedEndpoint(await getServerGraph(), id);
        if (!removed) {
            return NextResponse.json({ error: `Endpoint "${id}" existiert nicht.` }, { status: 404 });
        }
        await persistServerGraphSnapshot();
        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error('Federation Endpoint Delete Error:', error);
        return NextResponse.json({ error: 'Endpoint konnte nicht gelöscht werden.' }, { status: 500 });
    }
}
