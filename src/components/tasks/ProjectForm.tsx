'use client';

import { useState } from 'react';
import { Button, Input } from '@/components/ui';
import styles from './ProjectForm.module.css';

interface Project {
    id?: string;
    title: string;
    description?: string;
    prefix: string;
    status: 'planning' | 'active' | 'completed' | 'archived';
    color: string;
}

interface ProjectFormProps {
    project?: Project;
    onClose: () => void;
    onSave: () => void;
}

const PRESET_COLORS = ['#00674F', '#2563eb', '#7c3aed', '#dc2626', '#ea580c', '#0891b2'];

export function ProjectForm({ project, onClose, onSave }: ProjectFormProps) {
    const [formData, setFormData] = useState<Project>(project || {
        title: '',
        description: '',
        prefix: '',
        status: 'planning',
        color: PRESET_COLORS[0]
    });
    const [isLoading, setIsLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        try {
            const method = project ? 'PUT' : 'POST';
            const url = project ? `/api/projects/${project.id}` : '/api/projects';
            await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });
            onSave();
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
                    <h2>{project ? 'Projekt bearbeiten' : 'Neues Projekt'}</h2>
                    <button className={styles.closeBtn} onClick={onClose}>×</button>
                </div>

                <form onSubmit={handleSubmit} className={styles.form}>
                    <div className={styles.field}>
                        <label>Name *</label>
                        <Input
                            value={formData.title}
                            onChange={e => setFormData({ ...formData, title: e.target.value })}
                            placeholder="z.B. Open Workspace v2"
                            required
                        />
                    </div>

                    <div className={styles.grid}>
                        <div className={styles.field}>
                            <label>Präfix *</label>
                            <Input
                                value={formData.prefix}
                                onChange={e => setFormData({ ...formData, prefix: e.target.value.substring(0, 5) })}
                                placeholder="z.B. OWS"
                                required
                            />
                        </div>
                        <div className={styles.field}>
                            <label>Status</label>
                            <select value={formData.status} onChange={e => setFormData({ ...formData, status: e.target.value as any })}>
                                <option value="planning">Planung</option>
                                <option value="active">Aktiv</option>
                                <option value="completed">Abgeschlossen</option>
                                <option value="archived">Archiviert</option>
                            </select>
                        </div>
                    </div>

                    <div className={styles.field}>
                        <label>Farbe</label>
                        <div className={styles.colorPicker}>
                            {PRESET_COLORS.map(c => (
                                <button
                                    key={c}
                                    type="button"
                                    className={`${styles.colorDot} ${formData.color === c ? styles.activeColor : ''}`}
                                    style={{ backgroundColor: c }}
                                    onClick={() => setFormData({ ...formData, color: c })}
                                />
                            ))}
                        </div>
                    </div>

                    <div className={styles.footer}>
                        <Button type="button" variant="ghost" onClick={onClose}>Abbrechen</Button>
                        <Button type="submit" variant="primary" disabled={isLoading}>
                            {isLoading ? 'Speichern...' : (project ? 'Aktualisieren' : 'Erstellen')}
                        </Button>
                    </div>
                </form>
            </div>
        </div>
    );
}
