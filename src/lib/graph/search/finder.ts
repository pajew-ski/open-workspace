/**
 * Graph-gestützter Kern des Global Finders (SPEC §7.7, M8).
 *
 * Der bestehende `workspace_finder` wird auf den Graphen UMGESTELLT, nicht
 * ersetzt: Das Fuzzy-Verhalten (Tippfehler-Toleranz, Präfix-Ranking)
 * bleibt — es lebt jetzt im Volltext-Index über ALLE Literale des
 * Wissens-Datasets. Damit findet der Finder auch Frontmatter-Werte,
 * Tag-Namen und Dokument-Körper, die die alte Titel-+Body-Suche nicht sah.
 *
 * Dieses Modul deckt die Graph-Bürger ab (Dokumente, Aufgaben, Projekte).
 * Chats und Kalender-Termine sind noch KEINE Graph-Bürger (Conversation/
 * Event kommen mit M9+) — die Finder-Route ergänzt sie weiterhin ehrlich
 * aus ihren Storages, statt so zu tun, als kämen sie aus dem Graphen.
 */

import type { IriFactory } from '../iri';
import type { WorkspaceSnapshotInput } from '../migrate/from-files';
import type { FulltextIndex } from './fulltext';

export interface FinderHit {
    type: 'doc' | 'task' | 'project';
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

interface ParsedEntity {
    kind: 'doc' | 'task' | 'project';
    id: string;
}

/** IRI → Entitäts-Typ/-ID (Umkehrung von IriFactory.entity). */
export function parseEntityIri(iri: IriFactory, value: string): ParsedEntity | null {
    for (const kind of ['doc', 'task', 'project'] as const) {
        const prefix = iri.entity(kind, '');
        if (value.startsWith(prefix)) {
            const id = decodeURIComponent(value.slice(prefix.length));
            if (id !== '' && !id.includes('/')) return { kind, id };
        }
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
    workspace: Pick<WorkspaceSnapshotInput, 'docs' | 'tasks' | 'projects'>,
    query: string,
    typeFilter?: string | null,
): FinderHit[] {
    const hits = index.search(query, { limit: 100 });
    const docsById = new Map(workspace.docs.map(d => [d.id, d]));
    const tasksById = new Map(workspace.tasks.map(t => [t.id, t]));
    const projectsById = new Map(workspace.projects.map(p => [p.id, p]));
    const projectTitles = new Map(workspace.projects.map(p => [p.id, p.title]));

    const wantDocs = !typeFilter || typeFilter === 'doc' || typeFilter === 'note';
    const wantTasks = !typeFilter || typeFilter === 'task';
    const wantProjects = !typeFilter || typeFilter === 'project';

    const results: FinderHit[] = [];
    for (const hit of hits) {
        const entity = parseEntityIri(iri, hit.iri);
        if (!entity) continue;
        const matchScore = LABEL_MATCH_SCORE[hit.labelMatch] ?? 1;
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
