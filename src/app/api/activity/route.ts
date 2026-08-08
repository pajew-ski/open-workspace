import { NextRequest, NextResponse } from 'next/server';
import { getActivities } from '@/lib/activity';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const limitParam = Number(searchParams.get('limit'));
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 20;
        const activities = await getActivities(limit);
        return NextResponse.json({ activities });
    } catch (error) {
        console.error('Activity GET error:', error);
        return NextResponse.json({ error: 'Aktivitäten konnten nicht geladen werden.' }, { status: 500 });
    }
}
