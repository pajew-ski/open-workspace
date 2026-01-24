import fs from 'fs/promises';
import path from 'path';

const ACTIVITY_FILE = path.join(process.cwd(), 'data', 'activity.json');

export type ActivityType =
    | 'note_created' | 'note_updated' | 'note_deleted'
    | 'task_created' | 'task_updated' | 'task_completed' | 'task_deleted'
    | 'project_created'
    | 'canvas_created' | 'canvas_updated' | 'canvas_deleted'
    | 'agent_created';

export interface ActivityEvent {
    id: string;
    type: ActivityType;
    entityId: string;
    title: string;
    timestamp: string;
    metadata?: Record<string, any>;
}

export async function logActivity(
    type: ActivityType,
    entityId: string,
    title: string,
    metadata?: Record<string, any>
) {
    try {
        let activities: ActivityEvent[] = [];
        try {
            const data = await fs.readFile(ACTIVITY_FILE, 'utf-8');
            activities = JSON.parse(data);
        } catch (error) {
            // File might not exist or be empty, start fresh
        }

        const newEvent: ActivityEvent = {
            id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type,
            entityId,
            title,
            timestamp: new Date().toISOString(),
            metadata
        };

        // Prepend new event
        activities.unshift(newEvent);

        // Keep last 100 events
        if (activities.length > 100) {
            activities = activities.slice(0, 100);
        }

        await fs.writeFile(ACTIVITY_FILE, JSON.stringify(activities, null, 2));
        return newEvent;
    } catch (error) {
        console.error('Failed to log activity:', error);
        return null; // Don't block main flow
    }
}

export async function getActivities(limit = 20): Promise<ActivityEvent[]> {
    try {
        const data = await fs.readFile(ACTIVITY_FILE, 'utf-8');
        const activities: ActivityEvent[] = JSON.parse(data);
        return activities.slice(0, limit);
    } catch (error) {
        return [];
    }
}
