import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { getActivities } from '@/lib/activity';
import { listDocs, listTasks, listCanvases } from '@/lib/storage';
import { readJsonSafe, withFileLock, writeJsonAtomic } from '@/lib/storage/atomic';
import { dashboardLayoutSchema, parseBody } from '@/lib/api/validation';
import { z } from 'zod';

const DASHBOARD_FILE = path.join(process.cwd(), 'data', 'dashboard.json');

type DashboardData = z.output<typeof dashboardLayoutSchema>;

const DEFAULT_DASHBOARD: DashboardData = {
    layout: [
        { id: 'welcome-1', type: 'welcome', content: '<h2>Willkommen im Open Workspace</h2><p>Dein zentraler Arbeitsbereich für AI-gestützte Produktivität.</p>', order: 0 },
        { id: 'stats-1', type: 'stats', order: 1 },
        { id: 'activity-1', type: 'activity', title: 'Letzte Aktivitäten', order: 2 },
    ],
};

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const action = searchParams.get('action');

        // Stats action
        if (action === 'stats') {
            const [docs, tasks, canvases] = await Promise.all([
                listDocs(),
                listTasks({}),
                listCanvases()
            ]);

            return NextResponse.json({
                stats: {
                    docs: docs.length,
                    tasks: tasks.length,
                    canvases: canvases.length,
                }
            });
        }

        // Activities action
        if (action === 'activities') {
            const activities = await getActivities(50);
            return NextResponse.json({ activities });
        }

        // Default: Load layout (missing/corrupt file falls back to default)
        const dashboardData = await readJsonSafe<DashboardData>(DASHBOARD_FILE, DEFAULT_DASHBOARD);

        return NextResponse.json(dashboardData);
    } catch (error) {
        console.error('Dashboard API error:', error);
        return NextResponse.json({ error: 'Fehler beim Laden' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        // Only known widget types/fields are accepted; unknown keys are stripped
        const parsed = await parseBody(dashboardLayoutSchema, request);
        if (!parsed.ok) return parsed.response;

        await withFileLock(DASHBOARD_FILE, async () => {
            await writeJsonAtomic(DASHBOARD_FILE, { layout: parsed.data.layout });
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Dashboard save error:', error);
        return NextResponse.json({ error: 'Speichern fehlgeschlagen' }, { status: 500 });
    }
}
