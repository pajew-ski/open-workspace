import { NextRequest, NextResponse } from 'next/server';
import { loadConnections, createConnection, deleteConnection } from '@/lib/connections/manager';
import { CreateConnectionRequest } from '@/lib/connections/types';

export async function GET() {
    // Return connections WITHOUT decrypting secrets for list view
    // Ideally we should mask secrets here to be safe
    const connections = await loadConnections();
    const safeConnections = connections.map(c => ({
        ...c,
        auth: {
            ...c.auth,
            token: c.auth.token ? '***' : undefined,
            password: c.auth.password ? '***' : undefined,
            apiKey: c.auth.apiKey ? '***' : undefined,
        }
    }));
    return NextResponse.json({ connections: safeConnections });
}

export async function POST(request: NextRequest) {
    try {
        const body: CreateConnectionRequest = await request.json();
        if (!body.name || !body.type) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        const connection = await createConnection(body);
        return NextResponse.json({ connection });
    } catch (e) {
        return NextResponse.json({ error: 'Failed to create connection' }, { status: 500 });
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
    } catch (e) {
        return NextResponse.json({ error: 'Failed to delete connection' }, { status: 500 });
    }
}
