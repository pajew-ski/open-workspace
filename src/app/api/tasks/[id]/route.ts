import { NextRequest, NextResponse } from 'next/server';
import { getTask, updateTask, deleteTask } from '@/lib/storage';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const { id } = await params;
        const task = await getTask(id);

        if (!task) {
            return NextResponse.json(
                { error: 'Aufgabe nicht gefunden' },
                { status: 404 }
            );
        }

        return NextResponse.json({ task });
    } catch (error) {
        console.error('Task get error:', error);
        return NextResponse.json(
            { error: 'Aufgabe konnte nicht geladen werden' },
            { status: 500 }
        );
    }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
    try {
        const { id } = await params;
        const body = await request.json();

        const task = await updateTask(id, body);

        if (!task) {
            return NextResponse.json(
                { error: 'Aufgabe nicht gefunden' },
                { status: 404 }
            );
        }

        return NextResponse.json({ task });
    } catch (error) {
        console.error('Task update error:', error);
        return NextResponse.json(
            { error: 'Aufgabe konnte nicht aktualisiert werden' },
            { status: 500 }
        );
    }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const { id } = await params;
        const success = await deleteTask(id);

        if (!success) {
            return NextResponse.json(
                { error: 'Aufgabe nicht gefunden' },
                { status: 404 }
            );
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Task delete error:', error);
        return NextResponse.json(
            { error: 'Aufgabe konnte nicht gelöscht werden' },
            { status: 500 }
        );
    }
}
