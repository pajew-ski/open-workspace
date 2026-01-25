import { NextRequest, NextResponse } from 'next/server';
import { listProjects, createProject } from '@/lib/storage';

export async function GET() {
    try {
        const projects = await listProjects();
        return NextResponse.json({ projects });
    } catch (error) {
        console.error('Projects list error:', error);
        return NextResponse.json(
            { error: 'Projekte konnten nicht geladen werden' },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();

        if (!body.title || !body.prefix) {
            return NextResponse.json(
                { error: 'Titel und Präfix sind erforderlich' },
                { status: 400 }
            );
        }

        const project = await createProject({
            title: body.title,
            description: body.description,
            prefix: body.prefix,
            status: body.status,
            color: body.color,
        });

        const { logActivity } = await import('@/lib/activity');
        await logActivity('project_created', project.id, `Projekt erstellt: ${project.title}`);

        return NextResponse.json({ project }, { status: 201 });
    } catch (error) {
        console.error('Project create error:', error);
        return NextResponse.json(
            { error: 'Projekt konnte nicht erstellt werden' },
            { status: 500 }
        );
    }
}
