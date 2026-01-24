'use client';

import { useState } from 'react';
import styles from './NotificationBell.module.css';

interface Notification {
    id: string;
    title: string;
    message: string;
    timestamp: Date;
    read: boolean;
    type: 'info' | 'success' | 'warning' | 'error';
}

// Demo notifications - will be replaced with real data
const demoNotifications: Notification[] = [
    {
        id: '1',
        title: 'Willkommen',
        message: 'AI Workspace ist bereit für die Nutzung.',
        timestamp: new Date(),
        read: false,
        type: 'info',
    },
];

export function NotificationBell() {
    const [isOpen, setIsOpen] = useState(false);
    const [notifications] = useState<Notification[]>(demoNotifications);

    const unreadCount = notifications.filter((n) => !n.read).length;

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
                                <button className={styles.markRead}>Alle als gelesen markieren</button>
                            )}
                        </div>

                        <div className={styles.list}>
                            {notifications.length === 0 ? (
                                <p className={styles.empty}>Keine Benachrichtigungen</p>
                            ) : (
                                notifications.map((notification) => (
                                    <div
                                        key={notification.id}
                                        className={`${styles.item} ${!notification.read ? styles.unread : ''}`}
                                    >
                                        <div className={styles.itemContent}>
                                            <span className={styles.itemTitle}>{notification.title}</span>
                                            <span className={styles.itemMessage}>{notification.message}</span>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
