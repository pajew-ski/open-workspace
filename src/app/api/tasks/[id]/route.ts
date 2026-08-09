import { NextRequest, NextResponse } from 'next/server';
import { getTask, updateTask, deleteTask } from '@/lib/storage';
import { parseBody, shaclErrorResponse, updateTaskSchema } from '@/lib/api/validation';

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
        const parsed = await parseBody(updateTaskSchema, request);
        if (!parsed.ok) return parsed.response;

        const task = await updateTask(id, parsed.data);

        if (!task) {
            return NextResponse.json(
                { error: 'Aufgabe nicht gefunden' },
                { status: 404 }
            );
        }

        const { logActivity } = await import('@/lib/activity');
        await logActivity('task_updated', task.id, `Aufgabe aktualisiert: ${task.title}`);

        return NextResponse.json({ task });
    } catch (error) {
        const shacl = shaclErrorResponse(error);
        if (shacl) return shacl;
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
        const task = await getTask(id);
        const success = await deleteTask(id);

        if (!success) {
            return NextResponse.json(
                { error: 'Aufgabe nicht gefunden' },
                { status: 404 }
            );
        }

        if (task) {
            const { logActivity } = await import('@/lib/activity');
            await logActivity('task_deleted', id, `Aufgabe gelöscht: ${task.title}`);
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
