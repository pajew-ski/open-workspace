/**
 * Project Storage - JSON files
 */

import path from 'path';
import { readJsonSafe, withFileLock, writeJsonAtomic } from './atomic';

const DATA_DIR = path.join(process.cwd(), 'data', 'tasks');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

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

/**
 * Read projects data (missing/corrupt file falls back to empty data)
 */
async function readProjectsData(): Promise<ProjectsData> {
    return readJsonSafe<ProjectsData>(PROJECTS_FILE, { projects: [], version: 1 });
}

/**
 * Write projects data atomically
 */
async function writeProjectsData(data: ProjectsData): Promise<void> {
    await writeJsonAtomic(PROJECTS_FILE, data);
}

/**
 * Generate unique ID
 */
function generateId(): string {
    return `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * List all projects
 */
export async function listProjects(): Promise<Project[]> {
    const data = await readProjectsData();
    return data.projects.sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
}

/**
 * Get project by ID
 */
export async function getProject(id: string): Promise<Project | null> {
    const data = await readProjectsData();
    return data.projects.find(p => p.id === id) || null;
}

/**
 * Create project
 */
export async function createProject(input: {
    title: string;
    description?: string;
    prefix: string;
    status?: ProjectStatus;
    color?: string;
}): Promise<Project> {
    return withFileLock(PROJECTS_FILE, async () => {
        const data = await readProjectsData();
        const now = new Date().toISOString();

        const project: Project = {
            id: generateId(),
            title: input.title,
            description: input.description,
            prefix: input.prefix.toUpperCase(),
            status: input.status || 'planning',
            color: input.color || '#00674F',
            createdAt: now,
            updatedAt: now,
        };

        data.projects.push(project);
        await writeProjectsData(data);

        return project;
    });
}

/**
 * Update project
 */
export async function updateProject(id: string, input: Partial<Omit<Project, 'id' | 'createdAt'>>): Promise<Project | null> {
    return withFileLock(PROJECTS_FILE, async () => {
        const data = await readProjectsData();
        const index = data.projects.findIndex(p => p.id === id);

        if (index === -1) return null;

        const updated: Project = {
            ...data.projects[index],
            ...input,
            updatedAt: new Date().toISOString(),
        };

        data.projects[index] = updated;
        await writeProjectsData(data);

        return updated;
    });
}

/**
 * Delete project
 */
export async function deleteProject(id: string): Promise<boolean> {
    return withFileLock(PROJECTS_FILE, async () => {
        const data = await readProjectsData();
        const index = data.projects.findIndex(p => p.id === id);

        if (index === -1) return false;

        data.projects.splice(index, 1);
        await writeProjectsData(data);

        return true;
    });
}
