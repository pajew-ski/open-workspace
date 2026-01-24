'use client';

import { useState, useEffect } from 'react';
import { WidgetWrapper } from './WidgetWrapper';
import { MarkdownEditor } from '@/components/markdown';
import styles from './Widgets.module.css';

interface WelcomeWidgetProps {
    id: string;
    content: string;
    isEditing: boolean;
    onDelete: (id: string) => void;
    onUpdate: (id: string, updates: any) => void;
}

export function WelcomeWidget({ id, content, isEditing, onDelete, onUpdate }: WelcomeWidgetProps) {
    const [isEditingContent, setIsEditingContent] = useState(false);
    const [tempContent, setTempContent] = useState(content);

    const handleSave = () => {
        onUpdate(id, { content: tempContent });
        setIsEditingContent(false);
    };

    if (isEditingContent) {
        return (
            <WidgetWrapper id={id} title="Willkommens-Text bearbeiten" isEditing={false} onDelete={() => { }}>
                <textarea
                    className={styles.textarea}
                    value={tempContent}
                    onChange={(e) => setTempContent(e.target.value)}
                />
                <div className={styles.actions}>
                    <button onClick={() => setIsEditingContent(false)}>Abbrechen</button>
                    <button onClick={handleSave} className={styles.primary}>Speichern</button>
                </div>
            </WidgetWrapper>
        );
    }

    return (
        <WidgetWrapper
            id={id}
            isEditing={isEditing}
            onDelete={onDelete}
            onEdit={() => setIsEditingContent(true)}
            className={styles.welcomeWidget}
        >
            <div dangerouslySetInnerHTML={{ __html: content }} />
        </WidgetWrapper>
    );
}
