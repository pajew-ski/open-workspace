import { NextRequest, NextResponse } from 'next/server';
import { parseBody, updateProviderSchema } from '@/lib/api/validation';
import { deleteProvider, updateProvider } from '@/lib/ai/store.server';
import { refreshAiMirrorAfterMutation } from '@/lib/graph/server/instance';

interface RouteContext {
    params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    const parsed = await parseBody(updateProviderSchema, request);
    if (!parsed.ok) return parsed.response;

    try {
        const provider = await updateProvider(id, parsed.data);
        if (!provider) {
            return NextResponse.json({ error: 'Provider nicht gefunden' }, { status: 404 });
        }
        await refreshAiMirrorAfterMutation('Inference-Provider aktualisiert');
        return NextResponse.json({ provider });
    } catch (error) {
        return NextResponse.json(
            { error: 'Provider konnte nicht aktualisiert werden', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 }
        );
    }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    try {
        await deleteProvider(id);
        await refreshAiMirrorAfterMutation('Inference-Provider gelöscht');
        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json(
            { error: 'Provider konnte nicht gelöscht werden', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 }
        );
    }
}
