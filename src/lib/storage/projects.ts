/**
 * Project Storage - JSON files
 */

import { promises as fs } from 'fs';
import path from 'path';

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
 * Ensure data directory and file exist
 */
async function ensureDataFile(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });

    try {
        await fs.access(PROJECTS_FILE);
    } catch {
        await fs.writeFile(PROJECTS_FILE, JSON.stringify({ projects: [], version: 1 }, null, 2));
    }
}

/**
 * Read projects data
 */
async function readProjectsData(): Promise<ProjectsData> {
    await ensureDataFile();
    const content = await fs.readFile(PROJECTS_FILE, 'utf-8');
    return JSON.parse(content);
}

/**
 * Write projects data
 */
async function writeProjectsData(data: ProjectsData): Promise<void> {
    await fs.writeFile(PROJECTS_FILE, JSON.stringify(data, null, 2));
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
}

/**
 * Update project
 */
export async function updateProject(id: string, input: Partial<Omit<Project, 'id' | 'createdAt'>>): Promise<Project | null> {
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
}

/**
 * Delete project
 */
export async function deleteProject(id: string): Promise<boolean> {
    const data = await readProjectsData();
    const index = data.projects.findIndex(p => p.id === id);

    if (index === -1) return false;

    data.projects.splice(index, 1);
    await writeProjectsData(data);

    return true;
}
