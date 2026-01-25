'use client';

import { ReactNode } from 'react';
import { Card, CardHeader, CardContent, Button } from '@/components/ui';
import { Trash2, GripVertical, Edit2 } from 'lucide-react';
import styles from './WidgetWrapper.module.css';

interface WidgetWrapperProps {
    id: string;
    title?: string;
    children: ReactNode;
    isEditing: boolean;
    onDelete: (id: string) => void;
    onEdit?: () => void;
    className?: string; // Additional classes
}

export function WidgetWrapper({ id, title, children, isEditing, onDelete, onEdit, className }: WidgetWrapperProps) {
    return (
        <Card className={`${styles.widget} ${className || ''} ${isEditing ? styles.editing : ''}`}>
            {(title || isEditing) && (
                <CardHeader className={styles.header}>
                    <div className={styles.headerLeft}>
                        {isEditing && <GripVertical className={styles.dragHandle} size={20} />}
                        {title && <h3>{title}</h3>}
                    </div>
                    {isEditing && (
                        <div className={styles.controls}>
                            {onEdit && (
                                <button onClick={onEdit} className={styles.iconBtn} title="Bearbeiten">
                                    <Edit2 size={16} />
                                </button>
                            )}
                            <button onClick={() => onDelete(id)} className={styles.iconBtn} title="Entfernen">
                                <Trash2 size={16} />
                            </button>
                        </div>
                    )}
                </CardHeader>
            )}
            <CardContent>
                {children}
            </CardContent>
        </Card>
    );
}
