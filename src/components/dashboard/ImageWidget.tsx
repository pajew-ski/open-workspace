'use client';

import { useState } from 'react';
import { WidgetWrapper } from './WidgetWrapper';
import { Upload, ImageIcon } from 'lucide-react';
import styles from './Widgets.module.css';

interface ImageWidgetProps {
    id: string;
    url?: string;
    isEditing: boolean;
    onDelete: (id: string) => void;
    onUpdate: (id: string, updates: any) => void;
}

export function ImageWidget({ id, url, isEditing, onDelete, onUpdate }: ImageWidgetProps) {
    const [isUploading, setIsUploading] = useState(false);

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsUploading(true);
        const formData = new FormData();
        formData.append('file', file);

        try {
            const res = await fetch('/api/images', {
                method: 'POST',
                body: formData
            });
            const data = await res.json();
            if (data.url) {
                onUpdate(id, { url: data.url });
            }
        } catch (error) {
            console.error('Upload failed', error);
        } finally {
            setIsUploading(false);
        }
    };

    return (
        <WidgetWrapper id={id} isEditing={isEditing} onDelete={onDelete} className={styles.imageWidget}>
            {url ? (
                <div className={styles.imageContainer}>
                    <img src={url} alt="Dashboard Widget" className={styles.widgetImage} />
                    {isEditing && (
                        <label className={styles.uploadOverlay}>
                            <input type="file" accept="image/*" onChange={handleUpload} hidden />
                            <span>Bild ändern</span>
                        </label>
                    )}
                </div>
            ) : (
                <label className={styles.uploadPlaceholder}>
                    <input type="file" accept="image/*" onChange={handleUpload} hidden />
                    <Upload size={32} />
                    <span>{isUploading ? 'Lädt hoch...' : 'Bild hochladen'}</span>
                </label>
            )}
        </WidgetWrapper>
    );
}
