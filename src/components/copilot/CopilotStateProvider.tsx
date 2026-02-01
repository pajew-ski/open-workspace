'use client';

import { useCopilotReadable, useCopilotAction } from "@copilotkit/react-core";
import { usePathname, useRouter } from "next/navigation";
import { useAssistantContext } from "@/lib/assistant/context";
import { ReactNode } from "react";

/**
 * Module context mapping for human-readable descriptions
 */
const MODULE_CONTEXT: Record<string, { name: string; description: string }> = {
    '/': { name: 'Dashboard', description: 'Ubersicht und Schnellzugriff' },
    '/docs': { name: 'Dokumente', description: 'Notizen und Dokumente (Wissensbasis)' },
    '/canvas': { name: 'Canvas', description: 'Visuelle Planung (Pinnwand)' },
    '/tasks': { name: 'Aufgaben', description: 'Projekt- und Aufgabenverwaltung' },
    '/calendar': { name: 'Kalender', description: 'Termine und Zeitplanung' },
    '/agents': { name: 'Agenten', description: 'A2A Agent-Konfiguration' },
    '/communication': { name: 'Kommunikation', description: 'Matrix Chat' },
    '/settings': { name: 'Einstellungen', description: 'App-Konfiguration' },
    '/graph': { name: 'Ontologie-Graph', description: 'Wissensvisualisierung' },
};

/**
 * CopilotStateProvider
 * 
 * Exposes application state to CopilotKit agents via useCopilotReadable hooks.
 * This enables agents to understand the current context of the application.
 */
export function CopilotStateProvider({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const router = useRouter();
    const { viewState } = useAssistantContext();

    // Determine current module from pathname
    const getCurrentModule = () => {
        const routes = Object.keys(MODULE_CONTEXT).sort((a, b) => b.length - a.length);
        const match = routes.find(r => pathname === r || (r !== '/' && pathname.startsWith(r)));
        return match ? MODULE_CONTEXT[match] : MODULE_CONTEXT['/'];
    };

    const currentModule = getCurrentModule();

    // Expose current route and module
    useCopilotReadable({
        description: "Current page path the user is viewing in the workspace",
        value: pathname
    });

    useCopilotReadable({
        description: "Current module name and description",
        value: currentModule
    });

    // Expose dynamic view state (module-specific data)
    useCopilotReadable({
        description: "Current view state showing what the user sees on screen - includes active documents, selected items, visible content",
        value: viewState
    });

    // === ACTIONS ===

    // Navigation action
    useCopilotAction({
        name: "navigate",
        description: "Navigate to a different page in the workspace. Available pages: /, /docs, /canvas, /tasks, /calendar, /agents, /settings, /graph",
        parameters: [
            {
                name: "path",
                type: "string",
                description: "Path to navigate to (e.g., /tasks, /docs, /canvas)"
            }
        ],
        handler: async ({ path }) => {
            router.push(path);
            return `Navigated to ${path}`;
        }
    });

    // Create task action
    useCopilotAction({
        name: "createTask",
        description: "Create a new task in the task management system",
        parameters: [
            { name: "title", type: "string", description: "Task title" },
            { name: "priority", type: "string", description: "Priority: low, medium, high", required: false },
            { name: "projectId", type: "string", description: "Project ID to assign task to", required: false }
        ],
        handler: async ({ title, priority, projectId }) => {
            const res = await fetch('/api/tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    priority: priority || 'medium',
                    projectId,
                    status: 'todo'
                })
            });
            if (res.ok) {
                const data = await res.json();
                return `Task "${title}" created successfully with ID: ${data.task?.id || 'unknown'}`;
            }
            return "Failed to create task";
        }
    });

    // Update task action
    useCopilotAction({
        name: "updateTask",
        description: "Update an existing task's properties",
        parameters: [
            { name: "taskId", type: "string", description: "ID of the task to update" },
            { name: "title", type: "string", description: "New task title", required: false },
            { name: "status", type: "string", description: "New status: todo, in-progress, done", required: false },
            { name: "priority", type: "string", description: "New priority: low, medium, high", required: false }
        ],
        handler: async ({ taskId, title, status, priority }) => {
            const updates: Record<string, string> = {};
            if (title) updates.title = title;
            if (status) updates.status = status;
            if (priority) updates.priority = priority;

            const res = await fetch(`/api/tasks?id=${taskId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates)
            });
            return res.ok ? `Task ${taskId} updated successfully` : "Failed to update task";
        }
    });

    // Search documents action
    useCopilotAction({
        name: "searchDocuments",
        description: "Search through the knowledge base documents",
        parameters: [
            { name: "query", type: "string", description: "Search query" }
        ],
        handler: async ({ query }) => {
            const res = await fetch(`/api/docs/search?q=${encodeURIComponent(query)}`);
            if (res.ok) {
                const data = await res.json();
                return JSON.stringify(data.results || []);
            }
            return "Search failed";
        }
    });

    // Create canvas card action
    useCopilotAction({
        name: "createCanvasCard",
        description: "Create a new card on the canvas/pinnwand",
        parameters: [
            { name: "title", type: "string", description: "Card title" },
            { name: "content", type: "string", description: "Card content", required: false },
            { name: "color", type: "string", description: "Card color", required: false }
        ],
        handler: async ({ title, content, color }) => {
            const res = await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    content: content || '',
                    color: color || 'default',
                    position: { x: 100, y: 100 }
                })
            });
            return res.ok ? `Canvas card "${title}" created` : "Failed to create card";
        }
    });

    return <>{children}</>;
}
