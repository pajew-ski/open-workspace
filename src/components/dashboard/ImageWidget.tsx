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
    const [showUrlInput, setShowUrlInput] = useState(false);
    const [tempUrl, setTempUrl] = useState('');
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

    const handleUrlSubmit = () => {
        if (tempUrl) {
            onUpdate(id, { url: tempUrl });
            setShowUrlInput(false);
        }
    };

    return (
        <WidgetWrapper id={id} isEditing={isEditing} onDelete={onDelete} className={styles.imageWidget}>
            {url ? (
                <div className={styles.imageContainer}>
                    <img src={url} alt="Dashboard Widget" className={styles.widgetImage} />
                    {isEditing && (
                        <div className={styles.uploadOverlay}>
                            <label className={styles.overlayBtn}>
                                <input type="file" accept="image/*" onChange={handleUpload} hidden />
                                <span>Bild hochladen</span>
                            </label>
                            <button
                                className={styles.overlayBtn}
                                onClick={() => {
                                    setShowUrlInput(true);
                                    setTempUrl(url);
                                    onUpdate(id, { url: '' }); // Reset to show input
                                }}
                            >
                                URL ändern
                            </button>
                        </div>
                    )}
                </div>
            ) : showUrlInput ? (
                <div className={styles.uploadPlaceholder}>
                    <input
                        type="text"
                        placeholder="https://example.com/image.jpg"
                        className={styles.urlInput}
                        value={tempUrl}
                        onChange={(e) => setTempUrl(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
                        autoFocus
                    />
                    <div className={styles.urlActions}>
                        <button onClick={() => setShowUrlInput(false)} className={styles.cancelBtn}>Zurück</button>
                        <button onClick={handleUrlSubmit} className={styles.saveBtn}>Speichern</button>
                    </div>
                </div>
            ) : (
                <div className={styles.uploadPlaceholder}>
                    <label className={styles.uploadBtn}>
                        <input type="file" accept="image/*" onChange={handleUpload} hidden />
                        <Upload size={32} />
                        <span>{isUploading ? 'Lädt hoch...' : 'Bild hochladen'}</span>
                    </label>
                    <div className={styles.orDivider}>oder</div>
                    <button
                        className={styles.urlBtn}
                        onClick={() => setShowUrlInput(true)}
                    >
                        <ImageIcon size={20} />
                        URL eingeben
                    </button>
                </div>
            )}
        </WidgetWrapper>
    );
}
