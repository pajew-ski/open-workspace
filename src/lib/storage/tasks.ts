/**
 * Aufgaben — Fassade über den Store-first-Schreibpfad (Abschluss
 * SPEC §12.4): Wahrheit ist der RDF-Store, `data/tasks/tasks.json` ist
 * Projektion. Typen bleiben hier definiert, damit bestehende Importe
 * stabil sind.
 */

import { getWorkspaceContext } from '@/lib/graph/server/instance';
import * as crud from '@/lib/graph/workspace/crud';

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

export async function listTasks(filter?: {
    status?: TaskStatus;
    projectId?: string;
}): Promise<Task[]> {
    return crud.listTasks(await getWorkspaceContext(), filter);
}

export async function getTask(id: string): Promise<Task | null> {
    return crud.getTask(await getWorkspaceContext(), id);
}

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
    return crud.createTask(await getWorkspaceContext(), input);
}

export async function updateTask(id: string, input: Partial<Omit<Task, 'id' | 'createdAt'>>): Promise<Task | null> {
    return crud.updateTask(await getWorkspaceContext(), id, input);
}

export async function deleteTask(id: string): Promise<boolean> {
    return crud.deleteTask(await getWorkspaceContext(), id);
}

/** Aufgaben nach Status gruppiert (Kanban). */
export async function getTasksByStatus(): Promise<Record<string, Task[]>> {
    return crud.getTasksByStatus(await getWorkspaceContext());
}
