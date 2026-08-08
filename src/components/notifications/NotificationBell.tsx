'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStoredState } from '@/lib/hooks/useStoredState';
import styles from './NotificationBell.module.css';

interface ActivityEvent {
    id: string;
    type: string;
    entityId: string;
    title: string;
    timestamp: string;
}

const LAST_READ_KEY = 'open-workspace-notifications-last-read';

const TYPE_LABELS: Record<string, string> = {
    doc_created: 'Dokument erstellt',
    doc_updated: 'Dokument aktualisiert',
    doc_deleted: 'Dokument gelöscht',
    note_created: 'Notiz erstellt',
    note_updated: 'Notiz aktualisiert',
    note_deleted: 'Notiz gelöscht',
    task_created: 'Aufgabe erstellt',
    task_updated: 'Aufgabe aktualisiert',
    task_completed: 'Aufgabe erledigt',
    task_deleted: 'Aufgabe gelöscht',
    project_created: 'Projekt erstellt',
    project_updated: 'Projekt aktualisiert',
    project_deleted: 'Projekt gelöscht',
    canvas_created: 'Pinnwand erstellt',
    canvas_updated: 'Pinnwand aktualisiert',
    canvas_deleted: 'Pinnwand gelöscht',
    agent_created: 'Agent erstellt',
};

function formatRelativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return 'gerade eben';
    if (minutes < 60) return `vor ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `vor ${hours} h`;
    const days = Math.floor(hours / 24);
    return `vor ${days} d`;
}

/**
 * Notification center fed by the real workspace activity log.
 * Read state is tracked locally via a last-read timestamp.
 */
export function NotificationBell() {
    const [isOpen, setIsOpen] = useState(false);
    const [lastRead, setLastRead] = useStoredState(LAST_READ_KEY, '');

    const { data: notifications = [] } = useQuery<ActivityEvent[]>({
        queryKey: ['activity'],
        queryFn: async () => {
            const res = await fetch('/api/activity?limit=15');
            if (!res.ok) return [];
            const data = await res.json();
            return data.activities || [];
        },
        refetchInterval: 60_000,
    });

    const lastReadTime = lastRead ? new Date(lastRead).getTime() : 0;
    const unreadCount = notifications.filter(
        (n) => new Date(n.timestamp).getTime() > lastReadTime
    ).length;

    const markAllRead = () => {
        setLastRead(new Date().toISOString());
    };

    return (
        <div className={styles.container}>
            <button
                className={styles.button}
                onClick={() => setIsOpen(!isOpen)}
                aria-label={`Benachrichtigungen ${unreadCount > 0 ? `(${unreadCount} ungelesen)` : ''}`}
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
                {unreadCount > 0 && (
                    <span className={styles.badge}>{unreadCount}</span>
                )}
            </button>

            {isOpen && (
                <>
                    <div className={styles.overlay} onClick={() => setIsOpen(false)} />
                    <div className={styles.dropdown}>
                        <div className={styles.header}>
                            <span className={styles.title}>Benachrichtigungen</span>
                            {unreadCount > 0 && (
                                <button className={styles.markRead} onClick={markAllRead}>
                                    Alle als gelesen markieren
                                </button>
                            )}
                        </div>

                        <div className={styles.list}>
                            {notifications.length === 0 ? (
                                <p className={styles.empty}>Keine Benachrichtigungen</p>
                            ) : (
                                notifications.map((notification) => {
                                    const unread = new Date(notification.timestamp).getTime() > lastReadTime;
                                    return (
                                        <div
                                            key={notification.id}
                                            className={`${styles.item} ${unread ? styles.unread : ''}`}
                                        >
                                            <div className={styles.itemContent}>
                                                <span className={styles.itemTitle}>
                                                    {TYPE_LABELS[notification.type] || notification.type}
                                                </span>
                                                <span className={styles.itemMessage}>{notification.title}</span>
                                                <span className={styles.itemMessage}>
                                                    {formatRelativeTime(notification.timestamp)}
                                                </span>
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
