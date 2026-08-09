/**
 * Retrieval-Profile (SPEC §7.5, M8): gespeicherte Parametersätze als
 * ow:RetrievalProfile-Entitäten in graph/meta.
 *
 * GET  /api/graph/retrieval-profiles       → Liste
 * POST /api/graph/retrieval-profiles      → anlegen
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerGraph, persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { createRetrievalProfile, listRetrievalProfiles } from '@/lib/graph/search/profiles';

const createSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    config: z.record(z.string(), z.unknown()).default({}),
}).strict();

export async function GET(): Promise<Response> {
    try {
        const handle = await getServerGraph();
        return NextResponse.json({ profiles: await listRetrievalProfiles(handle) });
    } catch (error) {
        console.error('Retrieval Profiles Error:', error);
        return NextResponse.json({ error: 'Profile konnten nicht gelesen werden.' }, { status: 500 });
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
        const handle = await getServerGraph();
        const profile = await createRetrievalProfile(handle, {
            name: parsed.name,
            description: parsed.description,
            config: parsed.config,
        });
        await persistServerGraphSnapshot();
        return NextResponse.json({ profile }, { status: 201 });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Profil konnte nicht angelegt werden.';
        const status = message.includes('existiert bereits') ? 409 : 500;
        if (status === 500) console.error('Retrieval Profile Create Error:', error);
        return NextResponse.json({ error: message }, { status });
    }
}
