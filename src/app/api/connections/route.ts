import { NextRequest, NextResponse } from 'next/server';
import {
    loadConnections,
    createConnection,
    updateConnection,
    deleteConnection,
    MASKED_SECRET,
} from '@/lib/connections/manager';
import { Connection } from '@/lib/connections/types';
import { createConnectionSchema, parseBody, updateConnectionSchema } from '@/lib/api/validation';

/** Never expose stored (encrypted) secrets to clients. */
function maskConnection(connection: Connection): Connection {
    return {
        ...connection,
        auth: {
            ...connection.auth,
            token: connection.auth.token ? MASKED_SECRET : undefined,
            password: connection.auth.password ? MASKED_SECRET : undefined,
            apiKey: connection.auth.apiKey ? MASKED_SECRET : undefined,
        },
    };
}

export async function GET() {
    try {
        const connections = await loadConnections();
        return NextResponse.json({ connections: connections.map(maskConnection) });
    } catch (error) {
        console.error('Connections list error:', error);
        return NextResponse.json({ error: 'Failed to load connections' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const parsed = await parseBody(createConnectionSchema, request);
        if (!parsed.ok) return parsed.response;

        const connection = await createConnection(parsed.data);
        return NextResponse.json({ connection: maskConnection(connection) });
    } catch (error) {
        console.error('Connection create error:', error);
        return NextResponse.json({ error: 'Failed to create connection' }, { status: 500 });
    }
}

export async function PUT(request: NextRequest) {
    try {
        const parsed = await parseBody(updateConnectionSchema, request);
        if (!parsed.ok) return parsed.response;

        const { id, ...updates } = parsed.data;
        const connection = await updateConnection(id, updates);
        if (!connection) {
            return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
        }

        return NextResponse.json({ connection: maskConnection(connection) });
    } catch (error) {
        console.error('Connection update error:', error);
        return NextResponse.json({ error: 'Failed to update connection' }, { status: 500 });
    }
}

export async function DELETE(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');

        if (!id) {
            return NextResponse.json({ error: 'Missing id' }, { status: 400 });
        }

        await deleteConnection(id);
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Connection delete error:', error);
        return NextResponse.json({ error: 'Failed to delete connection' }, { status: 500 });
    }
}
