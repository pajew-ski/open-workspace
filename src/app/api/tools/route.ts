import { NextRequest, NextResponse } from 'next/server';
import { loadTools, createTool, deleteTool } from '@/lib/tools/storage';
import { CreateToolRequest } from '@/lib/tools/types';

export async function GET() {
    const tools = await loadTools();
    return NextResponse.json({ tools });
}

export async function POST(request: NextRequest) {
    try {
        const body: CreateToolRequest = await request.json();
        if (!body.name || !body.type) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        const tool = await createTool(body);
        return NextResponse.json({ tool });
    } catch (e) {
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
        return NextResponse.json({ success: true });
    } catch (e) {
        return NextResponse.json({ error: 'Failed to delete tool' }, { status: 500 });
    }
}
