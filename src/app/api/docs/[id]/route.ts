import { NextRequest, NextResponse } from 'next/server';
import { getDoc, updateDoc, deleteDoc } from '@/lib/storage/docs';

interface RouteParams {
    params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
    try {
        const { id } = await params;
        const doc = await getDoc(id);

        if (!doc) {
            return NextResponse.json(
                { error: 'Dokument nicht gefunden' },
                { status: 404 }
            );
        }

        return NextResponse.json({ doc });
    } catch (error) {
        console.error('Doc get error:', error);
        return NextResponse.json(
            { error: 'Dokument konnte nicht geladen werden' },
            { status: 500 }
        );
    }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
    try {
        const { id } = await params;
        const body = await request.json();

        const doc = await updateDoc(id, {
            title: body.title,
            content: body.content,
            category: body.category,
            tags: body.tags,
            type: body.type,
            slug: body.slug,
        });

        if (!doc) {
            return NextResponse.json(
                { error: 'Dokument nicht gefunden' },
                { status: 404 }
            );
        }

        const { logActivity } = await import('@/lib/activity');
        await logActivity('doc_updated', doc.id, `Dokument bearbeitet: ${doc.title}`);

        return NextResponse.json({ doc });
    } catch (error) {
        console.error('Doc update error:', error);
        return NextResponse.json(
            { error: 'Dokument konnte nicht aktualisiert werden' },
            { status: 500 }
        );
    }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
    try {
        const { id } = await params;
        const doc = await getDoc(id);
        const success = await deleteDoc(id);

        if (!success) {
            return NextResponse.json(
                { error: 'Dokument nicht gefunden' },
                { status: 404 }
            );
        }

        if (doc) {
            const { logActivity } = await import('@/lib/activity');
            await logActivity('doc_deleted', id, `Dokument gelöscht: ${doc.title}`);
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Doc delete error:', error);
        return NextResponse.json(
            { error: 'Dokument konnte nicht gelöscht werden' },
            { status: 500 }
        );
    }
}
