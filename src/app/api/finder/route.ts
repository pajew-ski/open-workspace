import { NextResponse } from 'next/server';
import { listNotes } from '@/lib/storage/notes';
import { listTasks } from '@/lib/storage/tasks';
import { listProjects } from '@/lib/storage/projects';
import { listConversations } from '@/lib/storage/chat';
import { getEvents } from '@/lib/storage/calendar';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q')?.toLowerCase() || '';
    const typeFilter = searchParams.get('type');

    if (!query) {
        return NextResponse.json({ results: [] });
    }

    try {
        const [notes, tasks, projects, conversations, events] = await Promise.all([
            listNotes(),
            listTasks(),
            listProjects().catch(() => []), // Fallback if not impl
            listConversations().catch(() => []),
            getEvents().catch(() => [])
        ]);

        const projectMap = new Map(projects.map((p: any) => [p.id, p.title]));

        const results = [];

        // Search Notes
        if (!typeFilter || typeFilter === 'note') {
            for (const note of notes) {
                if (note.title.toLowerCase().includes(query) || note.content.toLowerCase().includes(query)) {
                    results.push({
                        type: 'note',
                        id: note.id,
                        title: note.title,
                        subtitle: `Notiz • ${new Date(note.updatedAt).toLocaleDateString('de-DE')}`,
                        url: `/knowledge?id=${note.id}`,
                        matchScore: note.title.toLowerCase().includes(query) ? 2 : 1
                    });
                }
            }
        }

        // Search Tasks
        if (!typeFilter || typeFilter === 'task') {
            for (const task of tasks) {
                if (task.title.toLowerCase().includes(query) || task.description?.toLowerCase().includes(query)) {
                    const projectTitle = task.projectId ? projectMap.get(task.projectId) || task.projectId : 'Kein Projekt';
                    results.push({
                        type: 'task',
                        id: task.id,
                        title: task.title,
                        subtitle: `Aufgabe • ${task.status.toUpperCase()} • ${projectTitle}`,
                        url: `/tasks?id=${task.id}`,
                        matchScore: task.title.toLowerCase().includes(query) ? 2 : 1
                    });
                }
            }
        }

        // Search Projects
        if (!typeFilter || typeFilter === 'project') {
            for (const proj of projects) {
                if (proj.title.toLowerCase().includes(query)) {
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
        }

        // Search Chats
        if (!typeFilter || typeFilter === 'chat') {
            for (const chat of conversations) {
                if (chat.title.toLowerCase().includes(query)) {
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
                if (event.title.toLowerCase().includes(query) || event.description?.toLowerCase().includes(query)) {
                    results.push({
                        type: 'calendar',
                        id: event.id,
                        title: event.title,
                        subtitle: `Termin • ${new Date(event.startDate).toLocaleDateString('de-DE')}`,
                        url: `/calendar?date=${event.startDate.split('T')[0]}`,
                        matchScore: 2
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
