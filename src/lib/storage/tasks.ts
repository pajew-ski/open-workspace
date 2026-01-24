/**
 * Task Storage - JSON files
 * 
 * Tasks are stored as JSON for structured data
 * Designed for future migration to database
 */

import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data', 'tasks');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

export type TaskStatus = 'open' | 'in-progress' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface Task {
    id: string;
    title: string;
    description?: string;
    status: TaskStatus;
    priority: TaskPriority;
    dueDate?: string;
    projectId?: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
}

export interface TasksData {
    tasks: Task[];
    version: number;
}

/**
 * Ensure data directory and file exist
 */
async function ensureDataFile(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });

    try {
        await fs.access(TASKS_FILE);
    } catch {
        await fs.writeFile(TASKS_FILE, JSON.stringify({ tasks: [], version: 1 }, null, 2));
    }
}

/**
 * Read tasks data
 */
async function readTasksData(): Promise<TasksData> {
    await ensureDataFile();
    const content = await fs.readFile(TASKS_FILE, 'utf-8');
    return JSON.parse(content);
}

/**
 * Write tasks data
 */
async function writeTasksData(data: TasksData): Promise<void> {
    await fs.writeFile(TASKS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Generate unique ID
 */
function generateId(): string {
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * List all tasks
 */
export async function listTasks(filter?: {
    status?: TaskStatus;
    projectId?: string;
}): Promise<Task[]> {
    const data = await readTasksData();
    let tasks = data.tasks;

    if (filter?.status) {
        tasks = tasks.filter(t => t.status === filter.status);
    }
    if (filter?.projectId) {
        tasks = tasks.filter(t => t.projectId === filter.projectId);
    }

    return tasks.sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
}

/**
 * Get task by ID
 */
export async function getTask(id: string): Promise<Task | null> {
    const data = await readTasksData();
    return data.tasks.find(t => t.id === id) || null;
}

/**
 * Create task
 */
export async function createTask(input: {
    title: string;
    description?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    dueDate?: string;
    projectId?: string;
    tags?: string[];
}): Promise<Task> {
    const data = await readTasksData();
    const now = new Date().toISOString();

    const task: Task = {
        id: generateId(),
        title: input.title,
        description: input.description,
        status: input.status || 'open',
        priority: input.priority || 'medium',
        dueDate: input.dueDate,
        projectId: input.projectId,
        tags: input.tags || [],
        createdAt: now,
        updatedAt: now,
    };

    data.tasks.push(task);
    await writeTasksData(data);

    return task;
}

/**
 * Update task
 */
export async function updateTask(id: string, input: Partial<Omit<Task, 'id' | 'createdAt'>>): Promise<Task | null> {
    const data = await readTasksData();
    const index = data.tasks.findIndex(t => t.id === id);

    if (index === -1) return null;

    const updated: Task = {
        ...data.tasks[index],
        ...input,
        updatedAt: new Date().toISOString(),
    };

    data.tasks[index] = updated;
    await writeTasksData(data);

    return updated;
}

/**
 * Delete task
 */
export async function deleteTask(id: string): Promise<boolean> {
    const data = await readTasksData();
    const index = data.tasks.findIndex(t => t.id === id);

    if (index === -1) return false;

    data.tasks.splice(index, 1);
    await writeTasksData(data);

    return true;
}

/**
 * Get tasks grouped by status (for Kanban)
 */
export async function getTasksByStatus(): Promise<Record<TaskStatus, Task[]>> {
    const tasks = await listTasks();

    return {
        'open': tasks.filter(t => t.status === 'open'),
        'in-progress': tasks.filter(t => t.status === 'in-progress'),
        'done': tasks.filter(t => t.status === 'done'),
    };
}
