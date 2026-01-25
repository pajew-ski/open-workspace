import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getActivities } from '@/lib/activity';
import { listDocs, listTasks, listCanvases } from '@/lib/storage';

const DASHBOARD_FILE = path.join(process.cwd(), 'data', 'dashboard.json');

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
                    artifacts: 0 // Placeholder
                }
            });
        }

        // Activities action
        if (action === 'activities') {
            const activities = await getActivities(50);
            return NextResponse.json({ activities });
        }

        // Default: Load layout
        let dashboardData: { layout: any[] } = { layout: [] };
        try {
            const data = await fs.readFile(DASHBOARD_FILE, 'utf-8');
            dashboardData = JSON.parse(data);
        } catch (error) {
            // Use default if missing
            dashboardData = {
                layout: [
                    { "id": "welcome-1", "type": "welcome", "content": "<h2>Willkommen im Open Workspace</h2><p>Dein zentraler Arbeitsbereich für AI-gestützte Produktivität.</p>", "order": 0 },
                    { "id": "stats-1", "type": "stats", "order": 1 },
                    { "id": "activity-1", "type": "activity", "title": "Letzte Aktivitäten", "order": 2 }
                ]
            };
        }

        return NextResponse.json(dashboardData);
    } catch (error) {
        console.error('Dashboard API error:', error);
        return NextResponse.json({ error: 'Fehler beim Laden' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();

        if (body.layout) {
            await fs.writeFile(DASHBOARD_FILE, JSON.stringify({ layout: body.layout }, null, 2));
            return NextResponse.json({ success: true });
        }

        return NextResponse.json({ error: 'Ungültige Daten' }, { status: 400 });
    } catch (error) {
        console.error('Dashboard save error:', error);
        return NextResponse.json({ error: 'Speichern fehlgeschlagen' }, { status: 500 });
    }
}
