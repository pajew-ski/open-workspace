import { NextRequest, NextResponse } from 'next/server';
import { listDocs, createDoc } from '@/lib/storage/docs';

export async function GET() {
    try {
        const docs = await listDocs();
        return NextResponse.json({ docs });
    } catch (error) {
        console.error('Docs list error:', error);
        return NextResponse.json(
            { error: 'Dokumente konnten nicht geladen werden' },
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

        const doc = await createDoc({
            title: body.title,
            content: body.content || '',
            category: body.category,
            tags: body.tags || [],
            type: body.type, // Polymorphism support
        });

        const { logActivity } = await import('@/lib/activity');
        await logActivity('doc_created', doc.id, `Dokument erstellt: ${doc.title}`);

        return NextResponse.json({ doc }, { status: 201 });
    } catch (error) {
        console.error('Doc create error:', error);
        return NextResponse.json(
            { error: 'Dokument konnte nicht erstellt werden' },
            { status: 500 }
        );
    }
}
