import { NextRequest, NextResponse } from 'next/server';
import {
    listProviders,
    addProvider,
    updateProvider,
    deleteProvider,
    syncProvider,
    getEvents
} from '@/lib/storage/calendar';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const action = searchParams.get('action');

        if (action === 'events') {
            const start = searchParams.get('start') || undefined;
            const end = searchParams.get('end') || undefined;
            const events = await getEvents(start, end);
            return NextResponse.json({ events });
        }

        // Default: list providers
        const providers = await listProviders();
        return NextResponse.json({ providers });
    } catch (error) {
        console.error('Calendar GET error:', error);
        return NextResponse.json({ error: 'Fehler beim Laden' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { action } = body;

        switch (action) {
            case 'addProvider': {
                const provider = await addProvider(body.name, body.url, body.color);
                return NextResponse.json({ provider }, { status: 201 });
            }

            case 'updateProvider': {
                const provider = await updateProvider(body.id, body.updates);
                if (!provider) return NextResponse.json({ error: 'Provider nicht gefunden' }, { status: 404 });
                return NextResponse.json({ provider });
            }

            case 'deleteProvider': {
                const success = await deleteProvider(body.id);
                if (!success) return NextResponse.json({ error: 'Provider nicht gefunden' }, { status: 404 });
                return NextResponse.json({ success: true });
            }

            case 'syncProvider': {
                const count = await syncProvider(body.id);
                return NextResponse.json({ success: true, count });
            }

            default:
                return NextResponse.json({ error: 'Unbekannte Aktion' }, { status: 400 });
        }
    } catch (error) {
        console.error('Calendar POST error:', error);
        return NextResponse.json({ error: 'Aktion fehlgeschlagen', details: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
}
