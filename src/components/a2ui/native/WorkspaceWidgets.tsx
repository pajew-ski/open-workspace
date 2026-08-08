'use client';

/**
 * Native workspace widgets for the generative surface.
 *
 * These are not static A2UI primitives: each widget hydrates itself from
 * the workspace APIs via React Query. The model only declares intent
 * ("show open tasks", "show this week") — data binding, loading and
 * refresh are owned by the native layer. This is what makes the surface
 * an emergent view of real workspace state instead of a snapshot the
 * model happened to copy into text.
 */

import React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import './WorkspaceWidgets.css';

// ------------------------------------------------------------
// Shared bits
// ------------------------------------------------------------

function WidgetFrame({ title, moreHref, moreLabel, children }: {
    title: string;
    moreHref?: string;
    moreLabel?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="ws-widget">
            <div className="ws-widget-header">
                <span className="ws-widget-title">{title}</span>
                {moreHref && (
                    <Link className="ws-widget-more" href={moreHref}>
                        {moreLabel || 'Öffnen'}
                    </Link>
                )}
            </div>
            {children}
        </div>
    );
}

function WidgetState({ text }: { text: string }) {
    return <p className="ws-widget-state">{text}</p>;
}

// ------------------------------------------------------------
// WorkspaceTasks — live task list
// ------------------------------------------------------------

export interface WorkspaceTasksProps {
    /** Filter by status: todo | in-progress | done (unset = all) */
    status?: string;
    projectId?: string;
    limit?: number;
    title?: string;
}

interface TaskItem {
    id: string;
    title: string;
    status: string;
    priority?: string;
    dueDate?: string;
    projectId?: string;
}

const STATUS_LABELS: Record<string, string> = {
    'todo': 'Offen',
    'open': 'Offen',
    'in-progress': 'In Arbeit',
    'done': 'Erledigt',
};

export function WorkspaceTasks({ props }: { props: WorkspaceTasksProps }) {
    const { status, projectId, limit = 8, title } = props || {};
    const { data, isLoading, isError } = useQuery<TaskItem[]>({
        queryKey: ['a2ui-tasks'],
        queryFn: async () => {
            const res = await fetch('/api/tasks');
            if (!res.ok) throw new Error(String(res.status));
            const json = await res.json();
            return json.tasks || [];
        },
        refetchInterval: 30_000,
    });

    if (isLoading) return <WidgetFrame title={title || 'Aufgaben'}><WidgetState text="Lade Aufgaben…" /></WidgetFrame>;
    if (isError) return <WidgetFrame title={title || 'Aufgaben'}><WidgetState text="Aufgaben konnten nicht geladen werden." /></WidgetFrame>;

    let tasks = data || [];
    if (status) tasks = tasks.filter(t => t.status === status || (status === 'open' && t.status === 'todo'));
    if (projectId) tasks = tasks.filter(t => t.projectId === projectId);
    const shown = tasks.slice(0, Math.max(1, Math.min(limit, 25)));

    return (
        <WidgetFrame title={title || 'Aufgaben'} moreHref="/tasks" moreLabel="Alle Aufgaben">
            {shown.length === 0 ? (
                <WidgetState text="Keine passenden Aufgaben." />
            ) : (
                <ul className="ws-task-list">
                    {shown.map(task => (
                        <li key={task.id} className="ws-task-item">
                            <span className={`ws-task-status ws-status-${task.status}`}>
                                {STATUS_LABELS[task.status] || task.status}
                            </span>
                            <span className="ws-task-title">{task.title}</span>
                            {task.dueDate && (
                                <span className="ws-task-due">
                                    {new Date(task.dueDate).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {tasks.length > shown.length && (
                <p className="ws-widget-state">+ {tasks.length - shown.length} weitere</p>
            )}
        </WidgetFrame>
    );
}

// ------------------------------------------------------------
// WorkspaceCalendar — upcoming events
// ------------------------------------------------------------

export interface WorkspaceCalendarProps {
    /** How many days ahead to show (default 7) */
    days?: number;
    title?: string;
}

interface CalendarEvent {
    id?: string;
    title?: string;
    summary?: string;
    start: string;
    end?: string;
    location?: string;
}

export function WorkspaceCalendar({ props }: { props: WorkspaceCalendarProps }) {
    const { days = 7, title } = props || {};
    const clampedDays = Math.max(1, Math.min(days, 60));

    const { data, isLoading, isError } = useQuery<CalendarEvent[]>({
        queryKey: ['a2ui-calendar', clampedDays],
        queryFn: async () => {
            const start = new Date();
            const end = new Date(Date.now() + clampedDays * 24 * 60 * 60 * 1000);
            const res = await fetch(
                `/api/calendar?action=events&start=${start.toISOString()}&end=${end.toISOString()}`
            );
            if (!res.ok) throw new Error(String(res.status));
            const json = await res.json();
            return json.events || [];
        },
        refetchInterval: 60_000,
    });

    const heading = title || `Termine (${clampedDays} Tage)`;
    if (isLoading) return <WidgetFrame title={heading}><WidgetState text="Lade Termine…" /></WidgetFrame>;
    if (isError) return <WidgetFrame title={heading}><WidgetState text="Termine konnten nicht geladen werden." /></WidgetFrame>;

    const events = (data || [])
        .slice()
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
        .slice(0, 12);

    return (
        <WidgetFrame title={heading} moreHref="/calendar" moreLabel="Kalender">
            {events.length === 0 ? (
                <WidgetState text="Keine Termine in diesem Zeitraum." />
            ) : (
                <ul className="ws-event-list">
                    {events.map((event, i) => {
                        const startDate = new Date(event.start);
                        return (
                            <li key={event.id || i} className="ws-event-item">
                                <span className="ws-event-date">
                                    {startDate.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}
                                </span>
                                <span className="ws-event-time">
                                    {startDate.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
                                </span>
                                <span className="ws-event-title">{event.title || event.summary || 'Ohne Titel'}</span>
                            </li>
                        );
                    })}
                </ul>
            )}
        </WidgetFrame>
    );
}

// ------------------------------------------------------------
// WorkspaceDocs — knowledge base list / search
// ------------------------------------------------------------

export interface WorkspaceDocsProps {
    /** Optional search query (fuzzy, via global finder) */
    query?: string;
    limit?: number;
    title?: string;
}

interface DocItem {
    id: string;
    slug?: string;
    title: string;
    subtitle?: string;
    url?: string;
    updatedAt?: string;
    tags?: string[];
}

export function WorkspaceDocs({ props }: { props: WorkspaceDocsProps }) {
    const { query, limit = 8, title } = props || {};

    const { data, isLoading, isError } = useQuery<DocItem[]>({
        queryKey: ['a2ui-docs', query || ''],
        queryFn: async () => {
            if (query) {
                const res = await fetch(`/api/finder?q=${encodeURIComponent(query)}&type=doc`);
                if (!res.ok) throw new Error(String(res.status));
                const json = await res.json();
                return (json.results || []).map((r: DocItem & { url?: string }) => ({ ...r }));
            }
            const res = await fetch('/api/docs');
            if (!res.ok) throw new Error(String(res.status));
            const json = await res.json();
            return json.docs || [];
        },
    });

    const heading = title || (query ? `Dokumente: „${query}"` : 'Wissensbasis');
    if (isLoading) return <WidgetFrame title={heading}><WidgetState text="Lade Dokumente…" /></WidgetFrame>;
    if (isError) return <WidgetFrame title={heading}><WidgetState text="Dokumente konnten nicht geladen werden." /></WidgetFrame>;

    const docs = (data || []).slice(0, Math.max(1, Math.min(limit, 25)));

    return (
        <WidgetFrame title={heading} moreHref="/docs" moreLabel="Wissensbasis">
            {docs.length === 0 ? (
                <WidgetState text={query ? 'Keine Treffer.' : 'Noch keine Dokumente.'} />
            ) : (
                <ul className="ws-doc-list">
                    {docs.map(doc => (
                        <li key={doc.id} className="ws-doc-item">
                            <Link href={doc.url || `/docs?id=${encodeURIComponent(doc.slug || doc.id)}`} className="ws-doc-link">
                                {doc.title}
                            </Link>
                            {doc.subtitle && <span className="ws-doc-sub">{doc.subtitle}</span>}
                        </li>
                    ))}
                </ul>
            )}
        </WidgetFrame>
    );
}

// ------------------------------------------------------------
// WorkspaceStats — workspace overview numbers
// ------------------------------------------------------------

export interface WorkspaceStatsProps {
    title?: string;
}

export function WorkspaceStats({ props }: { props: WorkspaceStatsProps }) {
    const { title } = props || {};
    const { data, isLoading } = useQuery<{ docs: number; tasks: number; canvases: number }>({
        queryKey: ['a2ui-stats'],
        queryFn: async () => {
            const res = await fetch('/api/dashboard?action=stats');
            if (!res.ok) throw new Error(String(res.status));
            const json = await res.json();
            return json.stats;
        },
    });

    return (
        <WidgetFrame title={title || 'Workspace-Überblick'}>
            {isLoading || !data ? (
                <WidgetState text="Lade…" />
            ) : (
                <div className="ws-stats-row">
                    <div className="ws-stat"><span className="ws-stat-value">{data.docs}</span><span className="ws-stat-label">Dokumente</span></div>
                    <div className="ws-stat"><span className="ws-stat-value">{data.tasks}</span><span className="ws-stat-label">Aufgaben</span></div>
                    <div className="ws-stat"><span className="ws-stat-value">{data.canvases}</span><span className="ws-stat-label">Pinnwände</span></div>
                </div>
            )}
        </WidgetFrame>
    );
}
