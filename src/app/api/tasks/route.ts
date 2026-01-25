import { NextRequest, NextResponse } from 'next/server';
import { listTasks, createTask, getTasksByStatus } from '@/lib/storage';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const groupBy = searchParams.get('groupBy');

        if (groupBy === 'status') {
            const grouped = await getTasksByStatus();
            return NextResponse.json({ tasks: grouped });
        }

        const status = searchParams.get('status') as 'backlog' | 'todo' | 'in-progress' | 'review' | 'done' | 'on-hold' | null;
        const projectId = searchParams.get('projectId');

        const tasks = await listTasks({
            status: status || undefined,
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
        const body = await request.json();

        if (!body.title) {
            return NextResponse.json(
                { error: 'Titel ist erforderlich' },
                { status: 400 }
            );
        }

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
