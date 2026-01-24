'use client';

import { useState, useRef } from 'react';
import { WidgetWrapper } from './WidgetWrapper';
import { WelcomeWidget } from './WelcomeWidget';
import { StatsWidget } from './StatsWidget';
import { ActivityWidget } from './ActivityWidget';
import { ImageWidget } from './ImageWidget';
import { Plus, GripHorizontal } from 'lucide-react';
import { Button } from '@/components/ui';
import styles from './DashboardGrid.module.css';

export interface Widget {
    id: string;
    type: 'welcome' | 'stats' | 'activity' | 'image' | 'quick-access';
    order: number;
    content?: string;
    url?: string;
    [key: string]: any;
}

interface DashboardGridProps {
    widgets: Widget[];
    isEditing: boolean;
    setWidgets: (widgets: Widget[]) => void;
}

import { useAssistantContext } from '@/lib/assistant/context';
import { useEffect as useReactEffect } from 'react';

export function DashboardGrid({ widgets, isEditing, setWidgets }: DashboardGridProps) {
    const { setModuleState } = useAssistantContext();

    // Sync widgets to context
    useReactEffect(() => {
        setModuleState('dashboard_widgets', {
            count: widgets.length,
            items: widgets.map(w => ({
                id: w.id,
                type: w.type,
                content: w.content ? w.content.substring(0, 100) + '...' : undefined, // Truncate content
                url: w.url
            }))
        });
        return () => setModuleState('dashboard_widgets', null);
    }, [widgets, setModuleState]);
    // Keep track of the item currently being dragged
    const [draggedItemIndex, setDraggedItemIndex] = useState<number | null>(null);
    const dragNode = useRef<HTMLDivElement | null>(null);

    const onDragStart = (e: React.DragEvent, index: number) => {
        setDraggedItemIndex(index);
        dragNode.current = e.target as HTMLDivElement;
        e.dataTransfer.effectAllowed = 'move';
        // Set ghost image if needed, or rely on browser default
    };

    const onDragEnter = (e: React.DragEvent, targetIndex: number) => {
        if (!isEditing || draggedItemIndex === null || draggedItemIndex === targetIndex) return;

        // Swap locally to show preview
        const newWidgets = [...widgets];
        const draggedItem = newWidgets[draggedItemIndex];

        // Check if we already swapped (to avoid flicker) - handled by React diffing usually
        // Remove from old index
        newWidgets.splice(draggedItemIndex, 1);
        // Insert at new index
        newWidgets.splice(targetIndex, 0, draggedItem);

        // Update state
        setWidgets(newWidgets);

        // Important: Update the dragged index to match the new position
        setDraggedItemIndex(targetIndex);
    };

    const onDragEnd = () => {
        setDraggedItemIndex(null);
        dragNode.current = null;
    };

    const onDragOver = (e: React.DragEvent) => {
        e.preventDefault(); // Necessary to allow dropping
    };

    // Helpers for internal widget updates
    const removeWidget = (id: string) => {
        setWidgets(widgets.filter(w => w.id !== id));
    };

    const updateWidget = (id: string, updates: any) => {
        setWidgets(widgets.map(w => w.id === id ? { ...w, ...updates } : w));
    };

    const addWidget = (type: string) => {
        const newWidget: Widget = {
            id: `${type}-${Date.now()}`,
            type: type as any,
            order: widgets.length,
            content: type === 'welcome' ? '<h2>Neuer Text</h2><p>Bearbeite mich...</p>' : undefined
        };
        setWidgets([...widgets, newWidget]);
    };

    return (
        <div className={styles.container}>
            {isEditing && (
                <div className={styles.toolbar}>
                    <span>Widget hinzufügen:</span>
                    <div className={styles.addButtons}>
                        <Button variant="secondary" size="sm" onClick={() => addWidget('welcome')}>+ Text</Button>
                        <Button variant="secondary" size="sm" onClick={() => addWidget('image')}>+ Bild</Button>
                        <Button variant="secondary" size="sm" onClick={() => addWidget('stats')}>+ Stats</Button>
                        <Button variant="secondary" size="sm" onClick={() => addWidget('activity')}>+ Activity</Button>
                    </div>
                </div>
            )}

            <div className={styles.grid}>
                {widgets.map((widget, index) => (
                    <div
                        key={widget.id}
                        className={`${styles.gridItem} ${isEditing ? styles.draggable : ''} ${draggedItemIndex === index ? styles.beingDragged : ''}`}
                        draggable={isEditing}
                        onDragStart={(e) => onDragStart(e, index)}
                        onDragEnter={(e) => onDragEnter(e, index)}
                        onDragOver={onDragOver}
                        onDragEnd={onDragEnd}
                    >
                        {/* Overlay for Drag in Edit Mode */}
                        {isEditing && (
                            <div className={styles.dragOverlay}>
                                <GripHorizontal className={styles.dragIcon} />
                            </div>
                        )}

                        {widget.type === 'welcome' && (
                            <WelcomeWidget
                                {...widget}
                                content={widget.content || ''}
                                isEditing={isEditing}
                                onDelete={removeWidget}
                                onUpdate={updateWidget}
                            />
                        )}
                        {widget.type === 'stats' && (
                            <StatsWidget {...widget} isEditing={isEditing} onDelete={removeWidget} />
                        )}
                        {widget.type === 'activity' && (
                            <ActivityWidget {...widget} isEditing={isEditing} onDelete={removeWidget} />
                        )}
                        {widget.type === 'image' && (
                            <ImageWidget {...widget} isEditing={isEditing} onDelete={removeWidget} onUpdate={updateWidget} />
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
