'use client';

import { useState, useEffect, useMemo } from 'react';
import { AppShell } from '@/components/layout';
import { Button, Card, CardHeader, CardContent } from '@/components/ui';
import { TaskCard, Task } from '@/components/tasks/TaskCard';
import { TaskModal } from '@/components/tasks/TaskModal';
import { ProjectForm } from '@/components/tasks/ProjectForm';
import { useToast } from '@/components/ui/Toast';
import styles from './page.module.css';

interface Project {
    id: string;
    title: string;
    prefix: string;
    color: string;
    status: 'planning' | 'active' | 'completed' | 'archived';
}

const STATUS_COLUMNS = [
    { id: 'backlog', label: 'Backlog' },
    { id: 'todo', label: 'Zu erledigen' },
    { id: 'in-progress', label: 'Wird bearbeitet' },
    { id: 'review', label: 'Review' },
    { id: 'done', label: 'Erledigt' }
];

export default function TasksPage() {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [projects, setProjects] = useState<Project[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const [editingProject, setEditingProject] = useState<Project | null>(null);
    const [isAddingTask, setIsAddingTask] = useState(false);
    const [isAddingProject, setIsAddingProject] = useState(false);
    const { success, error } = useToast();

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        setIsLoading(true);
        try {
            const [tasksRes, projectsRes] = await Promise.all([
                fetch('/api/tasks'),
                fetch('/api/projects')
            ]);
            const [tasksData, projectsData] = await Promise.all([
                tasksRes.json(),
                projectsRes.json()
            ]);
            setTasks(tasksData.tasks || []);
            setProjects(projectsData.projects || []);
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSaveTask = async (taskData: any) => {
        const isUpdate = !!taskData.id;
        const url = isUpdate ? `/api/tasks/${taskData.id}` : '/api/tasks';
        const method = isUpdate ? 'PUT' : 'POST';

        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(taskData)
        });

        if (res.ok) {
            fetchData();
            success(`Aufgabe ${isUpdate ? 'aktualisiert' : 'erstellt'}`);
        } else {
            error('Aufgabe konnte nicht gespeichert werden');
        }
    };

    const handleMoveTask = async (taskId: string, newStatus: string) => {
        const oldTask = tasks.find(t => t.id === taskId);
        if (!oldTask) return;

        // Optimistic update
        const previousTasks = [...tasks];
        setTasks(tasks.map(t => t.id === taskId ? { ...t, status: newStatus } : t));

        const res = await fetch(`/api/tasks/${taskId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });

        if (!res.ok) {
            setTasks(previousTasks);
            error('Status konnte nicht geändert werden');
        } else {
            success('Status geändert', () => handleMoveTask(taskId, oldTask.status));
        }
    };

    // Group tasks by project
    const groupedTasks = useMemo(() => {
        const groups: Record<string, Task[]> = {};
        tasks.forEach(task => {
            const pid = task.projectId || 'unassigned';
            if (!groups[pid]) groups[pid] = [];
            groups[pid].push(task);
        });
        return groups;
    }, [tasks]);

    const activeSwimlanes = useMemo(() => {
        const swimlanes = [...projects];
        // Only add unassigned if there are tasks
        if (groupedTasks['unassigned']) {
            swimlanes.push({ id: 'unassigned', title: 'Ohne Projekt', prefix: '', color: '#ccc', status: 'active' });
        }
        return swimlanes;
    }, [projects, groupedTasks]);

    return (
        <AppShell title="Aufgaben">
            <div className={styles.container}>
                <div className={styles.topActions}>
                    <Button variant="secondary" onClick={() => setIsAddingProject(true)}>+ Projekt</Button>
                    <Button variant="primary" onClick={() => setIsAddingTask(true)}>+ Neue Aufgabe</Button>
                </div>

                <div className={styles.boardWrapper}>
                    <div className={styles.columnsHeader}>
                        {STATUS_COLUMNS.map(col => (
                            <div key={col.id} className={styles.columnLabel}>{col.label}</div>
                        ))}
                    </div>

                    <div className={styles.swimlanes}>
                        {activeSwimlanes.map(project => (
                            <div key={project.id} className={styles.swimlane}>
                                <div className={styles.projectHeader} style={{ borderLeftColor: project.color }}>
                                    <h3>{project.title}</h3>
                                    {project.prefix && <span className={styles.prefix}>{project.prefix}</span>}
                                    {project.id !== 'unassigned' && (
                                        <button className={styles.editProjBtn} onClick={() => setEditingProject(project)}>✎</button>
                                    )}
                                </div>

                                <div className={styles.gridRow}>
                                    {STATUS_COLUMNS.map(col => (
                                        <div key={col.id} className={styles.cell}>
                                            {(groupedTasks[project.id] || [])
                                                .filter(t => t.status === col.id)
                                                .map(task => (
                                                    <TaskCard
                                                        key={task.id}
                                                        task={task}
                                                        onClick={() => setEditingTask(task)}
                                                        onMoveStatus={(newStatus) => handleMoveTask(task.id, newStatus)}
                                                    />
                                                ))
                                            }
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {isLoading && tasks.length === 0 && (
                    <div className={styles.loading}>Lade Aufgaben...</div>
                )}
            </div>

            {(isAddingTask || editingTask) && (
                <TaskModal
                    task={editingTask || undefined}
                    onClose={() => { setEditingTask(null); setIsAddingTask(false); }}
                    onSave={handleSaveTask}
                />
            )}

            {(isAddingProject || editingProject) && (
                <ProjectForm
                    project={editingProject || undefined}
                    onClose={() => { setEditingProject(null); setIsAddingProject(false); }}
                    onSave={fetchData}
                />
            )}
        </AppShell>
    );
}
