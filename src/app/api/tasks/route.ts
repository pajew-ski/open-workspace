import { NextRequest, NextResponse } from 'next/server';
import { listTasks, createTask, getTasksByStatus } from '@/lib/storage';
import { createTaskSchema, parseBody, taskStatusSchema } from '@/lib/api/validation';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const groupBy = searchParams.get('groupBy');

        if (groupBy === 'status') {
            const grouped = await getTasksByStatus();
            return NextResponse.json({ tasks: grouped });
        }

        const statusParam = searchParams.get('status');
        const status = statusParam ? taskStatusSchema.safeParse(statusParam) : null;
        if (status && !status.success) {
            return NextResponse.json({ error: 'Ungültiger Status-Filter' }, { status: 400 });
        }
        const projectId = searchParams.get('projectId');

        const tasks = await listTasks({
            status: status?.data,
            projectId: projectId || undefined,
        });

        return NextResponse.json({ tasks });
    } catch (error) {
        console.error('Tasks list error:', error);
        return NextResponse.json(
            { error: 'Aufgaben konnten nicht geladen werden' },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const parsed = await parseBody(createTaskSchema, request);
        if (!parsed.ok) return parsed.response;
        const body = parsed.data;

        const task = await createTask({
            title: body.title,
            description: body.description,
            status: body.status,
            priority: body.priority,
            type: body.type,
            startDate: body.startDate,
            dueDate: body.dueDate,
            deferredUntil: body.deferredUntil,
            estimatedEffort: body.estimatedEffort,
            projectId: body.projectId,
            tags: body.tags,
            dependencies: body.dependencies,
        });

        const { logActivity } = await import('@/lib/activity');
        await logActivity('task_created', task.id, `Aufgabe erstellt: ${task.title}`);

        return NextResponse.json({ task }, { status: 201 });
    } catch (error) {
        console.error('Task create error:', error);
        return NextResponse.json(
            { error: 'Aufgabe konnte nicht erstellt werden' },
            { status: 500 }
        );
    }
}
