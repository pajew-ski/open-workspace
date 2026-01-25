'use client';

import { useState, useMemo } from 'react';
import styles from './TaskSelector.module.css';

interface Task {
    id: string;
    title: string;
    status: string;
    projectId?: string;
}

interface TaskSelectorProps {
    tasks: Task[];
    onSelect: (taskId: string) => void;
    excludeIds?: string[];
    placeholder?: string;
}

export function TaskSelector({ tasks, onSelect, excludeIds = [], placeholder = 'Aufgabe suchen...' }: TaskSelectorProps) {
    const [search, setSearch] = useState('');
    const [isOpen, setIsOpen] = useState(false);

    const filteredTasks = useMemo(() => {
        return tasks.filter(t =>
            !excludeIds.includes(t.id) &&
            t.title.toLowerCase().includes(search.toLowerCase())
        ).slice(0, 5); // Limit suggestions
    }, [tasks, search, excludeIds]);

    const handleSelect = (taskId: string) => {
        onSelect(taskId);
        setSearch('');
        setIsOpen(false);
    };

    return (
        <div className={styles.container}>
            <input
                type="text"
                className={styles.input}
                placeholder={placeholder}
                value={search}
                onChange={e => { setSearch(e.target.value); setIsOpen(true); }}
                onFocus={() => setIsOpen(true)}
                onBlur={() => setTimeout(() => setIsOpen(false), 200)} // Delay to allow click
                autoComplete="off"
            />
            {isOpen && search && (
                <div className={styles.dropdown}>
                    {filteredTasks.length > 0 ? (
                        filteredTasks.map(task => (
                            <div
                                key={task.id}
                                className={styles.item}
                                onClick={() => handleSelect(task.id)}
                            >
                                <span className={styles.title}>{task.title}</span>
                                <span className={styles.meta}>
                                    {task.status.toUpperCase()}
                                </span>
                            </div>
                        ))
                    ) : (
                        <div className={styles.empty}>Keine Aufgaben gefunden</div>
                    )}
                </div>
            )}
        </div>
    );
}
