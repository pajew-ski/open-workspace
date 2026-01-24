import { NextRequest, NextResponse } from 'next/server';
import {
    listCanvases,
    getCanvas,
    createCanvas,
    updateCanvasMeta,
    deleteCanvas,
    createCard,
    updateCard,
    deleteCard,
    createConnection,
    updateConnection,
    deleteConnection,
    updateViewport,
} from '@/lib/storage';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');

        if (id) {
            const canvas = await getCanvas(id);
            if (!canvas) {
                return NextResponse.json({ error: 'Canvas nicht gefunden' }, { status: 404 });
            }
            return NextResponse.json(canvas);
        }

        const canvases = await listCanvases();
        return NextResponse.json({ canvases });
    } catch (error) {
        console.error('Canvas get error:', error);
        return NextResponse.json({ error: 'Fehler beim Laden' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { action, canvasId } = body;

        switch (action) {
            // Canvas CRUD
            case 'create': {
                const canvas = await createCanvas(body.name, body.description);
                return NextResponse.json({ canvas }, { status: 201 });
            }

            case 'updateMeta': {
                const canvas = await updateCanvasMeta(canvasId, { name: body.name, description: body.description });
                if (!canvas) return NextResponse.json({ error: 'Canvas nicht gefunden' }, { status: 404 });
                return NextResponse.json({ canvas });
            }

            case 'delete': {
                const success = await deleteCanvas(body.id);
                if (!success) return NextResponse.json({ error: 'Canvas nicht gefunden' }, { status: 404 });
                return NextResponse.json({ success: true });
            }

            // Card CRUD
            case 'createCard': {
                const card = await createCard(canvasId, {
                    type: body.type,
                    title: body.title || 'Neue Karte',
                    content: body.content,
                    x: body.x ?? 100,
                    y: body.y ?? 100,
                    width: body.width,
                    height: body.height,
                    color: body.color,
                });
                if (!card) return NextResponse.json({ error: 'Canvas nicht gefunden' }, { status: 404 });
                return NextResponse.json({ card }, { status: 201 });
            }

            case 'updateCard': {
                const card = await updateCard(canvasId, body.cardId, body.updates);
                if (!card) return NextResponse.json({ error: 'Karte nicht gefunden' }, { status: 404 });
                return NextResponse.json({ card });
            }

            case 'deleteCard': {
                const success = await deleteCard(canvasId, body.cardId);
                if (!success) return NextResponse.json({ error: 'Karte nicht gefunden' }, { status: 404 });
                return NextResponse.json({ success: true });
            }

            // Connection CRUD
            case 'createConnection': {
                const connection = await createConnection(canvasId, body.fromId, body.toId, body.type || 'directional', body.label);
                if (!connection) return NextResponse.json({ error: 'Karten nicht gefunden' }, { status: 404 });
                return NextResponse.json({ connection }, { status: 201 });
            }

            case 'updateConnection': {
                const connection = await updateConnection(canvasId, body.connectionId, body.updates);
                if (!connection) return NextResponse.json({ error: 'Verbindung nicht gefunden' }, { status: 404 });
                return NextResponse.json({ connection });
            }

            case 'deleteConnection': {
                const success = await deleteConnection(canvasId, body.connectionId);
                if (!success) return NextResponse.json({ error: 'Verbindung nicht gefunden' }, { status: 404 });
                return NextResponse.json({ success: true });
            }

            case 'updateViewport': {
                await updateViewport(canvasId, body.viewport);
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
