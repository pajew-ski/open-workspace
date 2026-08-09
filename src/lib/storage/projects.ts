/**
 * Projekte — Fassade über den Store-first-Schreibpfad (Abschluss
 * SPEC §12.4): Wahrheit ist der RDF-Store, `data/tasks/projects.json` ist
 * Projektion. Die Projekt-Farbe lebt als Präsentationswert in
 * `graph/<u>/presentation` (Invariante 2).
 */

import { getWorkspaceContext } from '@/lib/graph/server/instance';
import * as crud from '@/lib/graph/workspace/crud';

export type ProjectStatus = 'planning' | 'active' | 'completed' | 'archived';

export interface Project {
    id: string;
    title: string;
    description?: string;
    prefix: string; // e.g. "OWS"
    status: ProjectStatus;
    color: string;
    createdAt: string;
    updatedAt: string;
}

export interface ProjectsData {
    projects: Project[];
    version: number;
}

export async function listProjects(): Promise<Project[]> {
    return crud.listProjects(await getWorkspaceContext());
}

export async function getProject(id: string): Promise<Project | null> {
    return crud.getProject(await getWorkspaceContext(), id);
}

export async function createProject(input: {
    title: string;
    description?: string;
    prefix: string;
    status?: ProjectStatus;
    color?: string;
}): Promise<Project> {
    return crud.createProject(await getWorkspaceContext(), input);
}

export async function updateProject(id: string, input: Partial<Omit<Project, 'id' | 'createdAt'>>): Promise<Project | null> {
    return crud.updateProject(await getWorkspaceContext(), id, input);
}

export async function deleteProject(id: string): Promise<boolean> {
    return crud.deleteProject(await getWorkspaceContext(), id);
}
