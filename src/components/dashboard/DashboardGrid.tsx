'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui';
import { WelcomeWidget } from './WelcomeWidget';
import { StatsWidget } from './StatsWidget';
import { ActivityWidget } from './ActivityWidget';
import { ImageWidget } from './ImageWidget';
import { Plus, Save, RotateCcw } from 'lucide-react';
import styles from './DashboardGrid.module.css';

interface Widget {
    id: string;
    type: 'welcome' | 'stats' | 'activity' | 'image' | 'quick-access';
    order: number;
    [key: string]: any;
}

export function DashboardGrid() {
    const [widgets, setWidgets] = useState<Widget[]>([]);
    const [isEditing, setIsEditing] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadDashboard();
    }, []);

    const loadDashboard = async () => {
        try {
            const res = await fetch('/api/dashboard');
            const data = await res.json();
            if (data.layout) {
                setWidgets(data.layout.sort((a: any, b: any) => a.order - b.order));
            }
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const saveDashboard = async () => {
        try {
            // Update orders based on current array index
            const updatedWidgets = widgets.map((w, i) => ({ ...w, order: i }));

            await fetch('/api/dashboard', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ layout: updatedWidgets })
            });
            setIsEditing(false);
        } catch (e) {
            console.error(e);
        }
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

    const removeWidget = (id: string) => {
        setWidgets(widgets.filter(w => w.id !== id));
    };

    const updateWidget = (id: string, updates: any) => {
        setWidgets(widgets.map(w => w.id === id ? { ...w, ...updates } : w));
    };

    const moveWidget = (index: number, direction: 'up' | 'down') => {
        if (direction === 'up' && index === 0) return;
        if (direction === 'down' && index === widgets.length - 1) return;

        const newWidgets = [...widgets];
        const swapIndex = direction === 'up' ? index - 1 : index + 1;
        [newWidgets[index], newWidgets[swapIndex]] = [newWidgets[swapIndex], newWidgets[index]];
        setWidgets(newWidgets);
    };

    if (loading) return <div>Lade Dashboard...</div>;

    return (
        <div className={styles.container}>
            <div className={styles.toolbar}>
                <div className={styles.left}>
                    {isEditing && (
                        <div className={styles.addButtons}>
                            <Button variant="secondary" size="sm" onClick={() => addWidget('welcome')}>+ Text</Button>
                            <Button variant="secondary" size="sm" onClick={() => addWidget('image')}>+ Bild</Button>
                            <Button variant="secondary" size="sm" onClick={() => addWidget('stats')}>+ Stats</Button>
                            <Button variant="secondary" size="sm" onClick={() => addWidget('activity')}>+ Activity</Button>
                        </div>
                    )}
                </div>
                <div className={styles.right}>
                    {isEditing ? (
                        <>
                            <Button variant="ghost" onClick={() => { setIsEditing(false); loadDashboard(); }}>
                                Abbrechen
                            </Button>
                            <Button variant="primary" onClick={saveDashboard}>
                                <Save size={16} style={{ marginRight: 8 }} /> Speichern
                            </Button>
                        </>
                    ) : (
                        <Button variant="secondary" onClick={() => setIsEditing(true)}>
                            Layout bearbeiten
                        </Button>
                    )}
                </div>
            </div>

            <div className={`${styles.grid} ${isEditing ? styles.editingGrid : ''}`}>
                {widgets.map((widget, index) => (
                    <div key={widget.id} className={styles.gridItem}>
                        {isEditing && (
                            <div className={styles.reorderControls}>
                                <button onClick={() => moveWidget(index, 'up')} disabled={index === 0}>↑</button>
                                <button onClick={() => moveWidget(index, 'down')} disabled={index === widgets.length - 1}>↓</button>
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
