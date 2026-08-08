import { NextRequest, NextResponse } from 'next/server';
import { parseBody, createSkillSchema } from '@/lib/api/validation';
import { createSkill, loadSkills } from '@/lib/skills/store.server';

export async function GET() {
    try {
        const skills = await loadSkills();
        return NextResponse.json({ skills });
    } catch (error) {
        return NextResponse.json(
            { error: 'Skills nicht ladbar', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    const parsed = await parseBody(createSkillSchema, request);
    if (!parsed.ok) return parsed.response;

    try {
        const skill = await createSkill(parsed.data);
        return NextResponse.json({ skill }, { status: 201 });
    } catch (error) {
        return NextResponse.json(
            { error: 'Skill konnte nicht angelegt werden', details: error instanceof Error ? error.message : 'unknown' },
            { status: 500 }
        );
    }
}
