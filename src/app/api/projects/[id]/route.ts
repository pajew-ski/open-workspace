import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateProject, deleteProject } from '@/lib/storage';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const { id } = await params;
        const project = await getProject(id);

        if (!project) {
            return NextResponse.json(
                { error: 'Projekt nicht gefunden' },
                { status: 404 }
            );
        }

        return NextResponse.json({ project });
    } catch (error) {
        console.error('Project get error:', error);
        return NextResponse.json(
            { error: 'Projekt konnte nicht geladen werden' },
            { status: 500 }
        );
    }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
    try {
        const { id } = await params;
        const body = await request.json();

        const project = await updateProject(id, body);

        if (!project) {
            return NextResponse.json(
                { error: 'Projekt nicht gefunden' },
                { status: 404 }
            );
        }

        return NextResponse.json({ project });
    } catch (error) {
        console.error('Project update error:', error);
        return NextResponse.json(
            { error: 'Projekt konnte nicht aktualisiert werden' },
            { status: 500 }
        );
    }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const { id } = await params;
        const success = await deleteProject(id);

        if (!success) {
            return NextResponse.json(
                { error: 'Projekt nicht gefunden' },
                { status: 404 }
            );
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Project delete error:', error);
        return NextResponse.json(
            { error: 'Projekt konnte nicht gelöscht werden' },
            { status: 500 }
        );
    }
}
