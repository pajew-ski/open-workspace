import { NextResponse } from 'next/server';
import { listDocs } from '@/lib/storage/docs';
import { listTasks } from '@/lib/storage/tasks';
import { listProjects } from '@/lib/storage/projects';
import { listConversations } from '@/lib/storage/chat';
import { getEvents } from '@/lib/storage/calendar';

// ... (Levenshtein headers omitted for brevity in thought, but need to be careful with replace)
// Actually I should just import listDocs and replace usages.

// Simple Levenshtein for server-side fuzzy match
const getLevenshteinDistance = (a: string, b: string): number => {
    const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
    for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
    for (let j = 1; j <= b.length; j++) {
        for (let i = 1; i <= a.length; i++) {
            const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[j][i] = Math.min(
                matrix[j][i - 1] + 1,
                matrix[j - 1][i] + 1,
                matrix[j - 1][i - 1] + indicator
            );
        }
    }
    return matrix[b.length][a.length];
};

const isFuzzyMatch = (text: string, query: string): boolean => {
    if (!text || !query) return false;
    const t = text.toLowerCase();
    const q = query.toLowerCase();

    // 1. Exact Substring (Fast)
    if (t.includes(q)) return true;

    // 2. Token Match (All query words must exist in text if multi-word)
    const tokens = q.split(/\s+/).filter(x => x.length > 2);
    if (tokens.length > 1 && tokens.every(token => t.includes(token))) return true;

    // 3. Levenshtein (Only for short titles/queries to avoid perf hit)
    // Only if query doesn't match substring but is similar length
    if (q.length > 3 && Math.abs(t.length - q.length) < 3) {
        if (getLevenshteinDistance(t, q) <= 2) return true;
    }

    return false;
};

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q')?.toLowerCase() || '';
    const typeFilter = searchParams.get('type');

    if (!query) {
        return NextResponse.json({ results: [] });
    }

    try {
        const [docs, tasks, projects, conversations, events] = await Promise.all([
            listDocs(),
            listTasks(),
            listProjects().catch(() => []), // Fallback if not impl
            listConversations().catch(() => []),
            getEvents().catch(() => [])
        ]);

        const projectMap = new Map(projects.map((p: any) => [p.id, p.title]));

        const results = [];

        // Search Docs
        if (!typeFilter || typeFilter === 'doc' || typeFilter === 'note') {
            for (const doc of docs) {
                if (isFuzzyMatch(doc.title, query) || doc.content.toLowerCase().includes(query)) {
                    results.push({
                        type: 'doc',
                        id: doc.id,
                        title: doc.title,
                        subtitle: `Dokument • ${new Date(doc.updatedAt).toLocaleDateString('de-DE')}`,
                        url: `/docs`,
                        matchScore: doc.title.toLowerCase().startsWith(query) ? 3 : (doc.title.toLowerCase().includes(query) ? 2 : 1)
                    });
                }
            }
        }

        // Search Tasks
        if (!typeFilter || typeFilter === 'task') {
            for (const task of tasks) {
                if (isFuzzyMatch(task.title, query) || task.description?.toLowerCase().includes(query)) {
                    const projectTitle = task.projectId ? projectMap.get(task.projectId) || task.projectId : 'Kein Projekt';
                    results.push({
                        type: 'task',
                        id: task.id,
                        title: task.title,
                        subtitle: `Aufgabe • ${task.status.toUpperCase()} • ${projectTitle}`,
                        url: `/tasks?id=${task.id}`,
                        matchScore: task.title.toLowerCase().startsWith(query) ? 3 : (task.title.toLowerCase().includes(query) ? 2 : 1)
                    });
                }
            }
        }

        // Search Projects (and unassigned tasks if explicit project filter)
        if (!typeFilter || typeFilter === 'project') {
            // Projects
            for (const proj of projects) {
                if (isFuzzyMatch(proj.title, query)) {
                    results.push({
                        type: 'project',
                        id: proj.id,
                        title: proj.title,
                        subtitle: 'Projekt',
                        url: `/tasks?projectId=${proj.id}`,
                        matchScore: 3
                    });
                }
            }

            // Include Unassigned Tasks ONLY if explicitly filtering by project
            if (typeFilter === 'project') {
                for (const task of tasks) {
                    if (!task.projectId && (isFuzzyMatch(task.title, query) || task.description?.toLowerCase().includes(query))) {
                        results.push({
                            type: 'task',
                            id: task.id,
                            title: task.title,
                            subtitle: 'Aufgabe (Kein Projekt)',
                            url: `/tasks?id=${task.id}`,
                            matchScore: 2
                        });
                    }
                }
            }
        }

        // Search Chats
        if (!typeFilter || typeFilter === 'chat') {
            for (const chat of conversations) {
                if (isFuzzyMatch(chat.title, query)) {
                    results.push({
                        type: 'chat',
                        id: chat.id,
                        title: chat.title,
                        subtitle: 'Konversation',
                        url: `/communication?id=${chat.id}`,
                        matchScore: 2
                    });
                }
            }
        }

        // Search Calendar
        if (!typeFilter || typeFilter === 'calendar') {
            for (const event of events) {
                if (isFuzzyMatch(event.title, query) || event.description?.toLowerCase().includes(query)) {
                    results.push({
                        type: 'calendar',
                        id: event.id,
                        title: event.title,
                        subtitle: `Termin • ${new Date(event.startDate).toLocaleDateString('de-DE')}`,
                        url: `/calendar?date=${event.startDate.split('T')[0]}`,
                        matchScore: event.title.toLowerCase().startsWith(query) ? 3 : (event.title.toLowerCase().includes(query) ? 2 : 1)
                    });
                }
            }
        }

        // Sort by match score then date
        results.sort((a, b) => b.matchScore - a.matchScore);

        return NextResponse.json({ results: results.slice(0, 50) });

    } catch (error) {
        console.error('Finder Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
