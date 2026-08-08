import { NextRequest, NextResponse } from 'next/server';
import { parseBody, updateSkillSchema } from '@/lib/api/validation';
import { deleteSkill, updateSkill } from '@/lib/skills/store.server';

interface RouteContext {
    params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    const parsed = await parseBody(updateSkillSchema, request);
    if (!parsed.ok) return parsed.response;

    try {
        const skill = await updateSkill(id, parsed.data);
        if (!skill) {
            return NextResponse.json({ error: 'Skill nicht gefunden' }, { status: 404 });
        }
        return NextResponse.json({ skill });
    } catch (error) {
        return NextResponse.json(
            { error: 'Skill konnte nicht aktualisiert werden', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 }
        );
    }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
    const { id } = await context.params;
    try {
        await deleteSkill(id);
        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json(
            { error: 'Skill konnte nicht gelöscht werden', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 }
        );
    }
}
