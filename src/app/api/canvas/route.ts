import { NextRequest, NextResponse } from 'next/server';
import {
    listCanvases,
    getCanvas,
    createCanvas,
    importCanvas,
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
import { canvasActionSchema, parseBody, shaclErrorResponse } from '@/lib/api/validation';
import { parseJsonCanvas } from '@/lib/graph/connectors/json-canvas/format';
import { jsonCanvasToNative } from '@/lib/graph/connectors/json-canvas/native';

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

            // Import einer .canvas-Datei (JSON Canvas 1.0, SPEC §9 / M5).
            // Fehlertolerant: ungültige Einträge werden übersprungen und
            // gemeldet; nur eine komplett leere Quelle ist ein Fehler.
            case 'import': {
                const parsed = parseJsonCanvas(body.json, `${body.name}.canvas`);
                if (parsed.canvas.nodes.length === 0 && parsed.issues.length > 0) {
                    return NextResponse.json(
                        {
                            error: 'Datei konnte nicht als JSON Canvas 1.0 gelesen werden',
                            details: parsed.issues.map(issue => `${issue.source}: ${issue.reason}`),
                        },
                        { status: 400 },
                    );
                }
                const native = jsonCanvasToNative(parsed.canvas);
                const canvas = await importCanvas({
                    name: body.name,
                    cards: native.cards,
                    connections: native.connections,
                });
                const { logActivity } = await import('@/lib/activity');
                await logActivity('canvas_created', canvas.id, `Canvas importiert: ${canvas.name}`);
                return NextResponse.json(
                    {
                        canvas,
                        skipped: parsed.issues.map(issue => `${issue.source}: ${issue.reason}`),
                    },
                    { status: 201 },
                );
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
        const shacl = shaclErrorResponse(error);
        if (shacl) return shacl;
        console.error('Canvas action error:', error);
        return NextResponse.json({ error: 'Aktion fehlgeschlagen' }, { status: 500 });
    }
}
