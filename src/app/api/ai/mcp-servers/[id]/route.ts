import { NextRequest, NextResponse } from 'next/server';
import { parseBody, updateMcpServerSchema } from '@/lib/api/validation';
import { deleteMcpServer, updateMcpServer } from '@/lib/ai/store.server';
import { refreshAiMirrorAfterMutation } from '@/lib/graph/server/instance';

interface RouteContext {
    params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    const parsed = await parseBody(updateMcpServerSchema, request);
    if (!parsed.ok) return parsed.response;

    try {
        const server = await updateMcpServer(id, parsed.data);
        if (!server) {
            return NextResponse.json({ error: 'MCP-Server nicht gefunden' }, { status: 404 });
        }
        await refreshAiMirrorAfterMutation('MCP-Server aktualisiert');
        return NextResponse.json({ server });
    } catch (error) {
        return NextResponse.json(
            { error: 'MCP-Server konnte nicht aktualisiert werden', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 }
        );
    }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    try {
        await deleteMcpServer(id);
        await refreshAiMirrorAfterMutation('MCP-Server gelöscht');
        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json(
            { error: 'MCP-Server konnte nicht gelöscht werden', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 }
        );
    }
}
