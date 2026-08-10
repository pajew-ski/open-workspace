/**
 * Einzelnes Retrieval-Profil (SPEC §7.5, M8).
 *
 * GET    /api/graph/retrieval-profiles/[id] → lesen
 * DELETE /api/graph/retrieval-profiles/[id] → löschen
 */

import { NextResponse } from 'next/server';
import {persistServerGraphSnapshot } from '@/lib/graph/server/instance';
import { getUserGraph } from '@/lib/graph/server/context';
import { deleteRetrievalProfile, getRetrievalProfile } from '@/lib/graph/search/profiles';

interface RouteContext {
    params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const handle = await getUserGraph();
        const profile = await getRetrievalProfile(handle, id);
        if (!profile) {
            return NextResponse.json({ error: `Retrieval-Profil "${id}" existiert nicht.` }, { status: 404 });
        }
        return NextResponse.json({ profile });
    } catch (error) {
        console.error('Retrieval Profile Error:', error);
        return NextResponse.json({ error: 'Profil konnte nicht gelesen werden.' }, { status: 500 });
    }
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
    const { id } = await context.params;
    try {
        const handle = await getUserGraph();
        const removed = await deleteRetrievalProfile(handle, id);
        if (!removed) {
            return NextResponse.json({ error: `Retrieval-Profil "${id}" existiert nicht.` }, { status: 404 });
        }
        await persistServerGraphSnapshot();
        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error('Retrieval Profile Delete Error:', error);
        return NextResponse.json({ error: 'Profil konnte nicht gelöscht werden.' }, { status: 500 });
    }
}
