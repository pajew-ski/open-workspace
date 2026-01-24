import { NextRequest, NextResponse } from 'next/server';
import { getNote, updateNote, deleteNote } from '@/lib/storage';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const { id } = await params;
        const note = await getNote(id);

        if (!note) {
            return NextResponse.json(
                { error: 'Notiz nicht gefunden' },
                { status: 404 }
            );
        }

        return NextResponse.json({ note });
    } catch (error) {
        console.error('Note get error:', error);
        return NextResponse.json(
            { error: 'Notiz konnte nicht geladen werden' },
            { status: 500 }
        );
    }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
    try {
        const { id } = await params;
        const body = await request.json();

        const note = await updateNote(id, {
            title: body.title,
            content: body.content,
            category: body.category,
            tags: body.tags,
        });

        if (!note) {
            return NextResponse.json(
                { error: 'Notiz nicht gefunden' },
                { status: 404 }
            );
        }

        return NextResponse.json({ note });
    } catch (error) {
        console.error('Note update error:', error);
        return NextResponse.json(
            { error: 'Notiz konnte nicht aktualisiert werden' },
            { status: 500 }
        );
    }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const { id } = await params;
        const success = await deleteNote(id);

        if (!success) {
            return NextResponse.json(
                { error: 'Notiz nicht gefunden' },
                { status: 404 }
            );
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Note delete error:', error);
        return NextResponse.json(
            { error: 'Notiz konnte nicht gelöscht werden' },
            { status: 500 }
        );
    }
}
