/**
 * Graph-gestützter Kern des Global Finders (SPEC §7.7, M8).
 *
 * Der bestehende `workspace_finder` wird auf den Graphen UMGESTELLT, nicht
 * ersetzt: Das Fuzzy-Verhalten (Tippfehler-Toleranz, Präfix-Ranking)
 * bleibt — es lebt jetzt im Volltext-Index über ALLE Literale des
 * Wissens-Datasets. Damit findet der Finder auch Frontmatter-Werte,
 * Tag-Namen und Dokument-Körper, die die alte Titel-+Body-Suche nicht sah.
 *
 * Seit M15 deckt es ALLE Graph-Bürger des Workspace ab: Dokumente,
 * Aufgaben, Projekte — und Kalender-Termine sowie Chats, die bis dahin
 * an der Finder-Route vorbei aus ihren Storages kamen. Damit gilt für
 * sie dasselbe Fuzzy-Verhalten wie für alles andere, und eine
 * Chat-Nachricht führt zu ihrer Unterhaltung (der Index kennt jedes
 * Literal, auch den Nachrichtentext).
 */

import type { IriFactory } from '../iri';
import type { WorkspaceSnapshotInput } from '../migrate/from-files';
import type { FulltextIndex } from './fulltext';

export interface FinderHit {
    type: 'doc' | 'task' | 'project' | 'chat' | 'calendar';
    id: string;
    title: string;
    subtitle: string;
    url: string;
    /** 3 = Titel-Präfix, 2 = Titel-Treffer, 1 = Inhalt/Fuzzy (Alt-Verhalten). */
    matchScore: number;
    /** Volltext-Score für stabile Feinsortierung innerhalb eines Ranges. */
    score: number;
}

export type FinderTypeFilter = 'doc' | 'note' | 'task' | 'project' | 'chat' | 'calendar';

type EntityKind = 'doc' | 'task' | 'project' | 'event' | 'conversation' | 'message';

interface ParsedEntity {
    kind: EntityKind;
    id: string;
}

const ENTITY_KINDS: readonly EntityKind[] = ['doc', 'task', 'project', 'event', 'conversation', 'message'];

/**
 * IRI → Entitäts-Typ/-ID (Umkehrung von IriFactory.entity). Nur
 * Nachrichten tragen eine zusammengesetzte ID (`<dialog>/<nachricht>`) —
 * bei allen anderen Arten schließt ein Schrägstrich einen Treffer aus,
 * damit Unter-Entitäten (Karten) nicht als Hauptentität erscheinen.
 */
export function parseEntityIri(iri: IriFactory, value: string): ParsedEntity | null {
    for (const kind of ENTITY_KINDS) {
        const prefix = iri.entity(kind, '');
        if (!value.startsWith(prefix)) continue;
        const id = decodeURIComponent(value.slice(prefix.length));
        if (id === '') return null;
        if (kind === 'message') return id.includes('/') ? { kind, id } : null;
        return id.includes('/') ? null : { kind, id };
    }
    return null;
}

const LABEL_MATCH_SCORE: Record<string, number> = {
    prefix: 3,
    contains: 2,
    token: 2,
    fuzzy: 1,
    none: 1,
};

function formatDate(iso: string): string {
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString('de-DE');
}

/**
 * Suche über die Graph-Bürger des Workspace. `workspace` liefert die
 * Anzeige-Metadaten (Status, Projektzuordnung, Datum) — dieselbe
 * Store-first-Quelle, aus der auch die Fassaden lesen.
 */
export function searchWorkspaceGraph(
    index: FulltextIndex,
    iri: IriFactory,
    workspace: Pick<WorkspaceSnapshotInput, 'docs' | 'tasks' | 'projects'> &
        Partial<Pick<WorkspaceSnapshotInput, 'calendars' | 'events' | 'conversations'>>,
    query: string,
    typeFilter?: string | null,
): FinderHit[] {
    const hits = index.search(query, { limit: 100 });
    const docsById = new Map(workspace.docs.map(d => [d.id, d]));
    const tasksById = new Map(workspace.tasks.map(t => [t.id, t]));
    const projectsById = new Map(workspace.projects.map(p => [p.id, p]));
    const projectTitles = new Map(workspace.projects.map(p => [p.id, p.title]));
    const enabledCalendars = new Set((workspace.calendars ?? []).filter(c => c.enabled).map(c => c.id));
    const eventsById = new Map((workspace.events ?? []).map(e => [e.id, e]));
    const conversationsById = new Map((workspace.conversations ?? []).map(c => [c.id, c]));

    const wantDocs = !typeFilter || typeFilter === 'doc' || typeFilter === 'note';
    const wantTasks = !typeFilter || typeFilter === 'task';
    const wantProjects = !typeFilter || typeFilter === 'project';
    const wantChats = !typeFilter || typeFilter === 'chat';
    const wantEvents = !typeFilter || typeFilter === 'calendar';

    // Eine Unterhaltung kann über ihren Titel UND über mehrere
    // Nachrichten treffen — sie erscheint trotzdem einmal, mit dem
    // besten Treffer (der Index liefert absteigend sortiert).
    const seenConversations = new Set<string>();

    const results: FinderHit[] = [];
    for (const hit of hits) {
        const entity = parseEntityIri(iri, hit.iri);
        if (!entity) continue;
        const matchScore = LABEL_MATCH_SCORE[hit.labelMatch] ?? 1;
        if (entity.kind === 'event') {
            if (!wantEvents) continue;
            const event = eventsById.get(entity.id);
            // Termine abgeschalteter Kalender erscheinen nicht — dieselbe
            // Sichtbarkeitsregel wie in der Kalender-Ansicht.
            if (!event || !enabledCalendars.has(event.providerId)) continue;
            results.push({
                type: 'calendar',
                id: event.id,
                title: event.title,
                subtitle: `Termin • ${formatDate(event.startDate)}`,
                url: `/calendar?date=${event.startDate.split('T')[0]}`,
                matchScore,
                score: hit.score,
            });
            continue;
        }
        if (entity.kind === 'conversation' || entity.kind === 'message') {
            if (!wantChats) continue;
            const conversationId = entity.kind === 'message' ? entity.id.split('/')[0] : entity.id;
            const conversation = conversationsById.get(conversationId);
            if (!conversation || seenConversations.has(conversationId)) continue;
            seenConversations.add(conversationId);
            results.push({
                type: 'chat',
                id: conversation.id,
                title: conversation.title,
                subtitle: entity.kind === 'message'
                    ? `Konversation • Treffer in einer Nachricht`
                    : 'Konversation',
                url: `/assistant?id=${conversation.id}`,
                // Ein Treffer im Nachrichtentext ist ein Inhalts-Treffer,
                // kein Titel-Treffer — sonst überholte er jedes Dokument.
                matchScore: entity.kind === 'message' ? Math.min(matchScore, 1) : matchScore,
                score: hit.score,
            });
            continue;
        }
        if (entity.kind === 'doc' && wantDocs) {
            const doc = docsById.get(entity.id);
            if (!doc) continue;
            results.push({
                type: 'doc',
                id: doc.id,
                title: doc.title,
                subtitle: `Dokument • ${formatDate(doc.updatedAt)}`,
                url: '/docs',
                matchScore,
                score: hit.score,
            });
        } else if (entity.kind === 'task' && wantTasks) {
            const task = tasksById.get(entity.id);
            if (!task) continue;
            const projectTitle = task.projectId
                ? projectTitles.get(task.projectId) ?? task.projectId
                : 'Kein Projekt';
            results.push({
                type: 'task',
                id: task.id,
                title: task.title,
                subtitle: `Aufgabe • ${task.status.toUpperCase()} • ${projectTitle}`,
                url: `/tasks?id=${task.id}`,
                matchScore,
                score: hit.score,
            });
        } else if (entity.kind === 'project' && wantProjects) {
            const project = projectsById.get(entity.id);
            if (!project) continue;
            results.push({
                type: 'project',
                id: project.id,
                title: project.title,
                subtitle: 'Projekt',
                url: `/tasks?projectId=${project.id}`,
                matchScore: Math.max(matchScore, 2),
                score: hit.score,
            });
        } else if (entity.kind === 'task' && typeFilter === 'project') {
            // `@projekt` findet auch Aufgaben ohne Projektzuordnung (AGENTS.md).
            const task = tasksById.get(entity.id);
            if (!task || task.projectId) continue;
            results.push({
                type: 'task',
                id: task.id,
                title: task.title,
                subtitle: 'Aufgabe (Kein Projekt)',
                url: `/tasks?id=${task.id}`,
                matchScore: Math.min(matchScore, 2),
                score: hit.score,
            });
        }
    }
    results.sort((a, b) => b.matchScore - a.matchScore || b.score - a.score || a.title.localeCompare(b.title, 'de'));
    return results;
}
