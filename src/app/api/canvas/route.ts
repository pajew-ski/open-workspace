import { NextRequest, NextResponse } from 'next/server';
import { getCanvas, createCard, updateCard, deleteCard, createConnection, deleteConnection, updateViewport } from '@/lib/storage';

export async function GET() {
    try {
        const canvas = await getCanvas();
        return NextResponse.json(canvas);
    } catch (error) {
        console.error('Canvas get error:', error);
        return NextResponse.json({ error: 'Canvas konnte nicht geladen werden' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { action } = body;

        switch (action) {
            case 'createCard': {
                const card = await createCard({
                    type: body.type,
                    title: body.title || 'Neue Karte',
                    content: body.content,
                    x: body.x ?? 100,
                    y: body.y ?? 100,
                    width: body.width,
                    height: body.height,
                    color: body.color,
                });
                return NextResponse.json({ card }, { status: 201 });
            }

            case 'updateCard': {
                const card = await updateCard(body.id, body.updates);
                if (!card) {
                    return NextResponse.json({ error: 'Karte nicht gefunden' }, { status: 404 });
                }
                return NextResponse.json({ card });
            }

            case 'deleteCard': {
                const success = await deleteCard(body.id);
                if (!success) {
                    return NextResponse.json({ error: 'Karte nicht gefunden' }, { status: 404 });
                }
                return NextResponse.json({ success: true });
            }

            case 'createConnection': {
                const connection = await createConnection(body.fromId, body.toId, body.label);
                if (!connection) {
                    return NextResponse.json({ error: 'Karten nicht gefunden' }, { status: 404 });
                }
                return NextResponse.json({ connection }, { status: 201 });
            }

            case 'deleteConnection': {
                const success = await deleteConnection(body.id);
                if (!success) {
                    return NextResponse.json({ error: 'Verbindung nicht gefunden' }, { status: 404 });
                }
                return NextResponse.json({ success: true });
            }

            case 'updateViewport': {
                await updateViewport(body.viewport);
                return NextResponse.json({ success: true });
            }

            default:
                return NextResponse.json({ error: 'Unbekannte Aktion' }, { status: 400 });
        }
    } catch (error) {
        console.error('Canvas action error:', error);
        return NextResponse.json({ error: 'Aktion fehlgeschlagen' }, { status: 500 });
    }
}
