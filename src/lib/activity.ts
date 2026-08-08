import path from 'path';
import { readJsonSafe, withFileLock, writeJsonAtomic } from '@/lib/storage/atomic';

const ACTIVITY_FILE = path.join(process.cwd(), 'data', 'activity.json');

export type ActivityType =
    | 'note_created' | 'note_updated' | 'note_deleted'
    | 'doc_created' | 'doc_updated' | 'doc_deleted'
    | 'task_created' | 'task_updated' | 'task_completed' | 'task_deleted'
    | 'project_created' | 'project_updated' | 'project_deleted'
    | 'canvas_created' | 'canvas_updated' | 'canvas_deleted'
    | 'agent_created';

export interface ActivityEvent {
    id: string;
    type: ActivityType;
    entityId: string;
    title: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
}

export async function logActivity(
    type: ActivityType,
    entityId: string,
    title: string,
    metadata?: Record<string, unknown>
) {
    try {
        return await withFileLock(ACTIVITY_FILE, async () => {
            let activities = await readJsonSafe<ActivityEvent[]>(ACTIVITY_FILE, []);

            const newEvent: ActivityEvent = {
                id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
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

            await writeJsonAtomic(ACTIVITY_FILE, activities);
            return newEvent;
        });
    } catch (error) {
        console.error('Failed to log activity:', error);
        return null; // Don't block main flow
    }
}

export async function getActivities(limit = 20): Promise<ActivityEvent[]> {
    const activities = await readJsonSafe<ActivityEvent[]>(ACTIVITY_FILE, []);
    return activities.slice(0, limit);
}
