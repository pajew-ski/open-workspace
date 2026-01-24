'use client';

import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { Card, CardContent } from '@/components/ui';
import styles from './TaskCard.module.css';

export interface Task {
    id: string;
    title: string;
    description?: string;
    status: string;
    priority: 'low' | 'medium' | 'high' | 'urgent';
    type: 'task' | 'bug' | 'feature' | 'milestone';
    dueDate?: string;
    startDate?: string;
    deferredUntil?: string;
    projectId?: string;
    tags: string[];
}

interface TaskCardProps {
    task: Task;
    onClick: () => void;
    onMoveStatus?: (newStatus: string) => void;
}

const PRIORITY_LABELS: Record<string, string> = {
    low: 'Niedrig',
    medium: 'Mittel',
    high: 'Hoch',
    urgent: 'Dringend'
};

const TYPE_ICONS: Record<string, string> = {
    task: '✅',
    bug: '🐛',
    feature: '✨',
    milestone: '🚩'
};

const NEXT_STATUS: Record<string, string | null> = {
    'backlog': 'todo',
    'todo': 'in-progress',
    'in-progress': 'review',
    'review': 'done',
    'done': null
};

const PREV_STATUS: Record<string, string | null> = {
    'backlog': null,
    'todo': 'backlog',
    'in-progress': 'todo',
    'review': 'in-progress',
    'done': 'review'
};

export function TaskCard({ task, onClick, onMoveStatus }: TaskCardProps) {
    const isOverdue = task.dueDate && new Date(task.dueDate) < new Date() && task.status !== 'done';
    const isDeferred = task.status === 'on-hold' && task.deferredUntil;

    return (
        <div className={styles.cardContainer} onClick={onClick}>
            <Card className={`${styles.card} ${styles[task.priority]}`}>
                <div className={styles.statusActions} onClick={e => e.stopPropagation()}>
                    {PREV_STATUS[task.status] && (
                        <button className={styles.statusBtn} onClick={() => onMoveStatus?.(PREV_STATUS[task.status]!)}>←</button>
                    )}
                    {NEXT_STATUS[task.status] && (
                        <button className={styles.statusBtn} onClick={() => onMoveStatus?.(NEXT_STATUS[task.status]!)}>→</button>
                    )}
                </div>
                <CardContent className={styles.content}>
                    <div className={styles.header}>
                        <span className={styles.typeIcon}>{TYPE_ICONS[task.type] || '📄'}</span>
                        <span className={styles.title}>{task.title}</span>
                    </div>

                    {task.description && (
                        <p className={styles.description}>{task.description.substring(0, 60)}{task.description.length > 60 ? '...' : ''}</p>
                    )}

                    <div className={styles.meta}>
                        <div className={styles.badges}>
                            <span className={`${styles.badge} ${styles[`priority-${task.priority}`]}`}>
                                {PRIORITY_LABELS[task.priority]}
                            </span>
                            {task.tags.map(tag => (
                                <span key={tag} className={styles.tag}>#{tag}</span>
                            ))}
                        </div>

                        <div className={styles.dates}>
                            {task.dueDate && (
                                <span className={`${styles.date} ${isOverdue ? styles.overdue : ''}`}>
                                    📅 {format(new Date(task.dueDate), 'd. MMM', { locale: de })}
                                </span>
                            )}
                            {isDeferred && (
                                <span className={styles.deferred}>
                                    ⏳ Bis {format(new Date(task.deferredUntil!), 'd. MMM', { locale: de })}
                                </span>
                            )}
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
