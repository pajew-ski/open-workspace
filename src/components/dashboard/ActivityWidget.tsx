'use client';

import { useEffect, useState } from 'react';
import { WidgetWrapper } from './WidgetWrapper';
import { ActivityEvent } from '@/lib/activity';
import { FileText, CheckSquare, Layout, Box } from 'lucide-react';
import type { BaseWidgetProps } from './types';
import styles from './Widgets.module.css';

export function ActivityWidget({ id, title, isEditing, onDelete }: BaseWidgetProps) {
    const [activities, setActivities] = useState<ActivityEvent[]>([]);

    useEffect(() => {
        fetch('/api/dashboard?action=activities')
            .then(res => res.json())
            .then(data => setActivities(data.activities || []))
            .catch(console.error);
    }, []);

    const getIcon = (type: string) => {
        if (type.startsWith('note') || type.startsWith('doc')) return <FileText size={16} />;
        if (type.startsWith('task')) return <CheckSquare size={16} />;
        if (type.startsWith('canvas')) return <Layout size={16} />;
        return <Box size={16} />;
    };

    const formatTime = (iso: string) => {
        return new Date(iso).toLocaleDateString('de-DE', {
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
        });
    };

    return (
        <WidgetWrapper id={id} title={title || "Aktivitäten"} isEditing={isEditing} onDelete={onDelete}>
            {/* Scrollbare Region: fokussierbar, damit Tastaturnutzer scrollen können */}
            <div className={styles.activityList} tabIndex={0} role="region" aria-label="Aktivitäten">
                {activities.length === 0 ? (
                    <p className={styles.empty}>Keine Aktivitäten</p>
                ) : (
                    activities.map(act => (
                        <div key={act.id} className={styles.activityItem}>
                            <div className={styles.actIcon}>{getIcon(act.type)}</div>
                            <div className={styles.actContent}>
                                <div className={styles.actTitle}>{act.title}</div>
                                <div className={styles.actTime}>{formatTime(act.timestamp)}</div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </WidgetWrapper>
    );
}
