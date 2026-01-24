'use client';

import { useState, useEffect } from 'react';
import { Button, Input, Card, CardHeader, CardContent } from '@/components/ui';
import styles from './TaskModal.module.css';

interface Task {
    id?: string;
    title: string;
    description?: string;
    status: string;
    priority: string;
    type: string;
    projectId?: string;
    dueDate?: string;
    startDate?: string;
    deferredUntil?: string;
    tags: string[];
}

interface Project {
    id: string;
    title: string;
}

interface TaskModalProps {
    task?: Task;
    onClose: () => void;
    onSave: (task: any) => Promise<void>;
    onDelete?: (id: string) => Promise<void>;
}

export function TaskModal({ task, onClose, onSave, onDelete }: TaskModalProps) {
    const [formData, setFormData] = useState<Task>(task || {
        title: '',
        description: '',
        status: 'todo',
        priority: 'medium',
        type: 'task',
        tags: []
    });
    const [projects, setProjects] = useState<Project[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [activeTab, setActiveTab] = useState<'general' | 'timing' | 'deps'>('general');

    useEffect(() => {
        fetch('/api/projects').then(r => r.json()).then(data => setProviders(data.projects || []));
    }, []);

    // Placeholder for setProviders - should be setProjects but API returns { projects: [] } 
    const setProviders = (p: Project[]) => setProjects(p);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formData.title) return;
        setIsLoading(true);
        try {
            await onSave(formData);
            onClose();
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className={styles.overlay} onClick={onClose}>
            <div className={styles.modal} onClick={e => e.stopPropagation()}>
                <div className={styles.header}>
                    <h2>{task ? 'Aufgabe bearbeiten' : 'Neue Aufgabe'}</h2>
                    <button className={styles.closeBtn} onClick={onClose}>×</button>
                </div>

                <div className={styles.tabs}>
                    <button className={activeTab === 'general' ? styles.activeTab : ''} onClick={() => setActiveTab('general')}>Allgemein</button>
                    <button className={activeTab === 'timing' ? styles.activeTab : ''} onClick={() => setActiveTab('timing')}>Zeitplanung</button>
                    <button className={activeTab === 'deps' ? styles.activeTab : ''} onClick={() => setActiveTab('deps')}>Abhängigkeiten</button>
                </div>

                <form onSubmit={handleSubmit} className={styles.form}>
                    {activeTab === 'general' && (
                        <div className={styles.tabContent}>
                            <div className={styles.field}>
                                <label>Titel *</label>
                                <Input
                                    value={formData.title}
                                    onChange={e => setFormData({ ...formData, title: e.target.value })}
                                    placeholder="Was ist zu tun?"
                                    required
                                />
                            </div>
                            <div className={styles.field}>
                                <label>Beschreibung</label>
                                <textarea
                                    className={styles.textarea}
                                    value={formData.description}
                                    onChange={e => setFormData({ ...formData, description: e.target.value })}
                                    placeholder="Details zur Aufgabe..."
                                />
                            </div>
                            <div className={styles.grid}>
                                <div className={styles.field}>
                                    <label>Typ</label>
                                    <select value={formData.type} onChange={e => setFormData({ ...formData, type: e.target.value })}>
                                        <option value="task">Aufgabe</option>
                                        <option value="bug">Fehler / Bug</option>
                                        <option value="feature">Feature</option>
                                        <option value="milestone">Meilenstein</option>
                                    </select>
                                </div>
                                <div className={styles.field}>
                                    <label>Priorität</label>
                                    <select value={formData.priority} onChange={e => setFormData({ ...formData, priority: e.target.value })}>
                                        <option value="low">Niedrig</option>
                                        <option value="medium">Mittel</option>
                                        <option value="high">Hoch</option>
                                        <option value="urgent">Dringend</option>
                                    </select>
                                </div>
                            </div>
                            <div className={styles.field}>
                                <label>Projekt</label>
                                <select value={formData.projectId || ''} onChange={e => setFormData({ ...formData, projectId: e.target.value || undefined })}>
                                    <option value="">Kein Projekt</option>
                                    {projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                                </select>
                            </div>
                        </div>
                    )}

                    {activeTab === 'timing' && (
                        <div className={styles.tabContent}>
                            <div className={styles.field}>
                                <label>Geplanter Start</label>
                                <Input type="date" value={formData.startDate ? formData.startDate.split('T')[0] : ''} onChange={e => setFormData({ ...formData, startDate: e.target.value ? new Date(e.target.value).toISOString() : undefined })} />
                            </div>
                            <div className={styles.field}>
                                <label>Fälligkeitsdatum</label>
                                <Input type="date" value={formData.dueDate ? formData.dueDate.split('T')[0] : ''} onChange={e => setFormData({ ...formData, dueDate: e.target.value ? new Date(e.target.value).toISOString() : undefined })} />
                            </div>
                            <div className={styles.field}>
                                <label>Aufschieben bis (Parking)</label>
                                <Input type="date" value={formData.deferredUntil ? formData.deferredUntil.split('T')[0] : ''} onChange={e => setFormData({ ...formData, deferredUntil: e.target.value ? new Date(e.target.value).toISOString() : undefined })} />
                            </div>
                        </div>
                    )}

                    {activeTab === 'deps' && (
                        <div className={styles.tabContent}>
                            <p className={styles.placeholder}>Abhängigkeits-Management folgt...</p>
                        </div>
                    )}

                    <div className={styles.footer}>
                        {task?.id && (
                            <Button type="button" variant="ghost" onClick={() => onDelete?.(task.id!)} className={styles.deleteBtn}>Löschen</Button>
                        )}
                        <div className={styles.rightButtons}>
                            <Button type="button" variant="ghost" onClick={onClose}>Abbrechen</Button>
                            <Button type="submit" variant="primary" disabled={isLoading}>
                                {isLoading ? 'Speichern...' : (task ? 'Aktualisieren' : 'Erstellen')}
                            </Button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
}
