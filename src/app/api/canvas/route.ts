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
import { canvasActionSchema, parseBody } from '@/lib/api/validation';

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
        const parsed = await parseBody(canvasActionSchema, request);
        if (!parsed.ok) return parsed.response;
        const body = parsed.data;

        switch (body.action) {
            // Canvas CRUD
            case 'create': {
                const canvas = await createCanvas(body.name, body.description);
                const { logActivity } = await import('@/lib/activity');
                await logActivity('canvas_created', canvas.id, `Canvas erstellt: ${canvas.name}`);
                return NextResponse.json({ canvas }, { status: 201 });
            }

            case 'updateMeta': {
                const canvas = await updateCanvasMeta(body.canvasId, { name: body.name, description: body.description });
                if (!canvas) return NextResponse.json({ error: 'Canvas nicht gefunden' }, { status: 404 });

                const { logActivity } = await import('@/lib/activity');
                await logActivity('canvas_updated', canvas.id, `Canvas bearbeitet: ${canvas.name}`);

                return NextResponse.json({ canvas });
            }

            case 'delete': {
                const canvas = await getCanvas(body.id);
                const success = await deleteCanvas(body.id);
                if (!success) return NextResponse.json({ error: 'Canvas nicht gefunden' }, { status: 404 });

                if (canvas) {
                    const { logActivity } = await import('@/lib/activity');
                    await logActivity('canvas_deleted', body.id, `Canvas gelöscht: ${canvas.name}`);
                }

                return NextResponse.json({ success: true });
            }

            // Card CRUD
            case 'createCard': {
                const card = await createCard(body.canvasId, {
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

                const { logActivity } = await import('@/lib/activity');
                await logActivity('canvas_updated', body.canvasId, `Canvas Karte erstellt: ${card.title}`);

                return NextResponse.json({ card }, { status: 201 });
            }

            case 'updateCard': {
                const card = await updateCard(body.canvasId, body.cardId, body.updates);
                if (!card) return NextResponse.json({ error: 'Karte nicht gefunden' }, { status: 404 });
                // No logging for updates (high frequency)
                return NextResponse.json({ card });
            }

            case 'deleteCard': {
                const success = await deleteCard(body.canvasId, body.cardId);
                if (!success) return NextResponse.json({ error: 'Karte nicht gefunden' }, { status: 404 });

                const { logActivity } = await import('@/lib/activity');
                await logActivity('canvas_updated', body.canvasId, `Canvas Karte gelöscht`);

                return NextResponse.json({ success: true });
            }

            // Connection CRUD
            case 'createConnection': {
                const connection = await createConnection(body.canvasId, body.fromId, body.toId, body.type || 'directional', body.label);
                if (!connection) return NextResponse.json({ error: 'Karten nicht gefunden' }, { status: 404 });
                return NextResponse.json({ connection }, { status: 201 });
            }

            case 'updateConnection': {
                const connection = await updateConnection(body.canvasId, body.connectionId, body.updates);
                if (!connection) return NextResponse.json({ error: 'Verbindung nicht gefunden' }, { status: 404 });
                return NextResponse.json({ connection });
            }

            case 'deleteConnection': {
                const success = await deleteConnection(body.canvasId, body.connectionId);
                if (!success) return NextResponse.json({ error: 'Verbindung nicht gefunden' }, { status: 404 });
                return NextResponse.json({ success: true });
            }

            case 'updateViewport': {
                await updateViewport(body.canvasId, body.viewport);
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
