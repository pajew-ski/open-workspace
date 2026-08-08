import { NextRequest, NextResponse } from 'next/server';
import { parseBody, updateProviderSchema } from '@/lib/api/validation';
import { deleteProvider, updateProvider } from '@/lib/ai/store.server';

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
        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json(
            { error: 'Provider konnte nicht gelöscht werden', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 }
        );
    }
}
