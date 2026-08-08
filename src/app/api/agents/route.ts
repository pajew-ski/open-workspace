import { NextRequest, NextResponse } from 'next/server';
import { loadAgents, createAgent, deleteAgent, updateAgent } from '@/lib/agents/storage';
import { Agent } from '@/lib/agents/types';
import { createAgentSchema, parseBody, updateAgentSchema } from '@/lib/api/validation';

export async function GET() {
    try {
        const agents = await loadAgents();
        return NextResponse.json({ agents });
    } catch (error) {
        console.error('Agents list error:', error);
        return NextResponse.json({ error: 'Failed to load agents' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const parsed = await parseBody(createAgentSchema, request);
        if (!parsed.ok) return parsed.response;

        const agent = await createAgent(parsed.data);
        return NextResponse.json({ agent });
    } catch (error) {
        console.error('Agent create error:', error);
        return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
    }
}

export async function PUT(request: NextRequest) {
    try {
        const parsed = await parseBody(updateAgentSchema, request);
        if (!parsed.ok) return parsed.response;

        const { id, connectionId, ...rest } = parsed.data;
        const updates: Partial<Agent> = { ...rest };
        if (connectionId !== undefined) {
            // null explicitly clears the linked connection
            updates.connectionId = connectionId ?? undefined;
        }

        const agent = await updateAgent(id, updates);
        if (!agent) {
            return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
        }

        return NextResponse.json({ agent });
    } catch (error) {
        console.error('Agent update error:', error);
        return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 });
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
    } catch (error) {
        console.error('Agent delete error:', error);
        return NextResponse.json({ error: 'Failed to delete agent' }, { status: 500 });
    }
}
