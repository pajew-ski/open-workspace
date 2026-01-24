import { NextRequest, NextResponse } from 'next/server';
import { listNotes, createNote } from '@/lib/storage';

export async function GET() {
    try {
        const notes = await listNotes();
        return NextResponse.json({ notes });
    } catch (error) {
        console.error('Notes list error:', error);
        return NextResponse.json(
            { error: 'Notizen konnten nicht geladen werden' },
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

        const note = await createNote({
            title: body.title,
            content: body.content || '',
            category: body.category,
            tags: body.tags || [],
        });

        return NextResponse.json({ note }, { status: 201 });
    } catch (error) {
        console.error('Note create error:', error);
        return NextResponse.json(
            { error: 'Notiz konnte nicht erstellt werden' },
            { status: 500 }
        );
    }
}
