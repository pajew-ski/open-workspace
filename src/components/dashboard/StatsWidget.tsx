'use client';

import { useEffect, useState } from 'react';
import { WidgetWrapper } from './WidgetWrapper';
import styles from './Widgets.module.css';

export function StatsWidget({ id, isEditing, onDelete }: any) {
    const [stats, setStats] = useState<any>({ docs: 0, tasks: 0, canvases: 0 });

    useEffect(() => {
        fetch('/api/dashboard?action=stats')
            .then(res => res.json())
            .then(data => setStats(data.stats))
            .catch(console.error);
    }, []);

    return (
        <WidgetWrapper id={id} title="Schnellübersicht" isEditing={isEditing} onDelete={onDelete}>
            <div className={styles.statGrid}>
                <div className={styles.stat}>
                    <span className={styles.statValue}>{stats.docs}</span>
                    <span className={styles.statLabel}>Dokumente</span>
                </div>
                <div className={styles.stat}>
                    <span className={styles.statValue}>{stats.tasks}</span>
                    <span className={styles.statLabel}>Aufgaben</span>
                </div>
                <div className={styles.stat}>
                    <span className={styles.statValue}>{stats.canvases}</span>
                    <span className={styles.statLabel}>Canvas</span>
                </div>
            </div>
        </WidgetWrapper>
    );
}
