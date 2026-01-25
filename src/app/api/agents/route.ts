import { NextRequest, NextResponse } from 'next/server';
import { loadAgents, createAgent, deleteAgent, updateAgent } from '@/lib/agents/storage';
import { CreateAgentRequest } from '@/lib/agents/types';

export async function GET() {
    const agents = await loadAgents();
    return NextResponse.json({ agents });
}

export async function POST(request: NextRequest) {
    try {
        const body: CreateAgentRequest = await request.json();
        if (!body.name || !body.type) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        const agent = await createAgent(body);
        return NextResponse.json({ agent });
    } catch (e) {
        return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
    }
}

export async function DELETE(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');

        if (!id) {
            return NextResponse.json({ error: 'Missing id' }, { status: 400 });
        }

        await deleteAgent(id);
        return NextResponse.json({ success: true });
    } catch (e) {
        return NextResponse.json({ error: 'Failed to delete agent' }, { status: 500 });
    }
}
