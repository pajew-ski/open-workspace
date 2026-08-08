/**
 * Task Storage - JSON files
 * 
 * Tasks are stored as JSON for structured data
 * Designed for future migration to database
 */

import path from 'path';
import { readJsonSafe, withFileLock, writeJsonAtomic } from './atomic';

const DATA_DIR = path.join(process.cwd(), 'data', 'tasks');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

export type TaskStatus = 'backlog' | 'todo' | 'in-progress' | 'review' | 'done' | 'on-hold';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskType = 'task' | 'bug' | 'feature' | 'milestone';

export interface TaskDependency {
    id: string;
    type: 'FS' | 'SS' | 'FF' | 'SF'; // Finish-to-Start, Start-to-Start, etc.
}

export interface Task {
    id: string;
    projectId?: string;
    title: string;
    description?: string;
    status: TaskStatus;
    priority: TaskPriority;
    type: TaskType;
    startDate?: string;
    dueDate?: string;
    deferredUntil?: string;
    estimatedEffort?: number; // hours
    actualEffort?: number;    // hours
    dependencies: TaskDependency[];
    tags: string[];
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
}

export interface TasksData {
    tasks: Task[];
    version: number;
}

/**
 * Read tasks data (missing/corrupt file falls back to empty data)
 */
async function readTasksData(): Promise<TasksData> {
    return readJsonSafe<TasksData>(TASKS_FILE, { tasks: [], version: 1 });
}

/**
 * Write tasks data atomically
 */
async function writeTasksData(data: TasksData): Promise<void> {
    await writeJsonAtomic(TASKS_FILE, data);
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
    type?: TaskType;
    startDate?: string;
    dueDate?: string;
    deferredUntil?: string;
    estimatedEffort?: number;
    projectId?: string;
    tags?: string[];
    dependencies?: TaskDependency[];
}): Promise<Task> {
    return withFileLock(TASKS_FILE, async () => {
        const data = await readTasksData();
        const now = new Date().toISOString();

        const task: Task = {
            id: generateId(),
            title: input.title,
            description: input.description,
            status: input.status || 'todo',
            priority: input.priority || 'medium',
            type: input.type || 'task',
            startDate: input.startDate,
            dueDate: input.dueDate,
            deferredUntil: input.deferredUntil,
            estimatedEffort: input.estimatedEffort,
            projectId: input.projectId,
            tags: input.tags || [],
            dependencies: input.dependencies || [],
            createdAt: now,
            updatedAt: now,
        };

        data.tasks.push(task);
        await writeTasksData(data);

        return task;
    });
}

/**
 * Update task
 */
export async function updateTask(id: string, input: Partial<Omit<Task, 'id' | 'createdAt'>>): Promise<Task | null> {
    return withFileLock(TASKS_FILE, async () => {
        const data = await readTasksData();
        const index = data.tasks.findIndex(t => t.id === id);

        if (index === -1) return null;

        const now = new Date().toISOString();
        const completedAt = input.status === 'done' && data.tasks[index].status !== 'done'
            ? now
            : (input.status && input.status !== 'done' ? undefined : data.tasks[index].completedAt);

        const updated: Task = {
            ...data.tasks[index],
            ...input,
            completedAt: completedAt || data.tasks[index].completedAt,
            updatedAt: now,
        };

        data.tasks[index] = updated;
        await writeTasksData(data);

        return updated;
    });
}

/**
 * Delete task
 */
export async function deleteTask(id: string): Promise<boolean> {
    return withFileLock(TASKS_FILE, async () => {
        const data = await readTasksData();
        const index = data.tasks.findIndex(t => t.id === id);

        if (index === -1) return false;

        data.tasks.splice(index, 1);
        await writeTasksData(data);

        return true;
    });
}

/**
 * Get tasks grouped by status (for Kanban)
 */
export async function getTasksByStatus(): Promise<Record<string, Task[]>> {
    const tasks = await listTasks();

    return {
        'backlog': tasks.filter(t => t.status === 'backlog'),
        'todo': tasks.filter(t => t.status === 'todo'),
        'in-progress': tasks.filter(t => t.status === 'in-progress'),
        'review': tasks.filter(t => t.status === 'review'),
        'done': tasks.filter(t => t.status === 'done'),
        'on-hold': tasks.filter(t => t.status === 'on-hold'),
    };
}
