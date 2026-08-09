import { NextRequest, NextResponse } from 'next/server';
import { loadTools, createTool, deleteTool } from '@/lib/tools/storage';
import { createToolSchema, parseBody } from '@/lib/api/validation';
import { refreshAiMirrorAfterMutation } from '@/lib/graph/server/instance';

export async function GET() {
    try {
        const tools = await loadTools();
        return NextResponse.json({ tools });
    } catch (error) {
        console.error('Tools list error:', error);
        return NextResponse.json({ error: 'Failed to load tools' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const parsed = await parseBody(createToolSchema, request);
        if (!parsed.ok) return parsed.response;

        const tool = await createTool(parsed.data);
        await refreshAiMirrorAfterMutation('Werkzeug angelegt');
        return NextResponse.json({ tool });
    } catch (error) {
        console.error('Tool create error:', error);
        return NextResponse.json({ error: 'Failed to create tool' }, { status: 500 });
    }
}

export async function DELETE(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');

        if (!id) {
            return NextResponse.json({ error: 'Missing id' }, { status: 400 });
        }

        await deleteTool(id);
        await refreshAiMirrorAfterMutation('Werkzeug gelöscht');
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Tool delete error:', error);
        return NextResponse.json({ error: 'Failed to delete tool' }, { status: 500 });
    }
}
