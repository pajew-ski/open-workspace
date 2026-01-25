'use client';

import { useState } from 'react';
import { Button, Input, Card, CardContent } from '@/components/ui';
import styles from './AddApiToolDialog.module.css';

interface AddApiToolDialogProps {
    onClose: () => void;
    onAdd: (data: any) => Promise<void>;
}

export function AddApiToolDialog({ onClose, onAdd }: AddApiToolDialogProps) {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [url, setUrl] = useState('');
    const [method, setMethod] = useState<'GET' | 'POST'>('GET');
    const [isLoading, setIsLoading] = useState(false);

    const handleSubmit = async () => {
        if (!name || !url) return;
        setIsLoading(true);
        try {
            await onAdd({
                name,
                description,
                type: 'api',
                config: {
                    url,
                    method,
                },
            });
            onClose();
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className={styles.overlay}>
            <Card className={styles.dialog}>
                <CardContent>
                    <h3>Neues API Tool</h3>
                    <div className={styles.formGrid}>
                        <div className={styles.field}>
                            <label>Name</label>
                            <Input
                                placeholder="z.B. Wetter"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                        </div>
                        <div className={styles.field}>
                            <label>Beschreibung</label>
                            <Input
                                placeholder="Was kann dieses Tool?"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                            />
                        </div>
                        <div className={styles.field}>
                            <label>URL</label>
                            <Input
                                placeholder="https://api.example.com/..."
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                            />
                        </div>
                        <div className={styles.field}>
                            <label>Methode</label>
                            <div className={styles.methodSelect}>
                                <button
                                    className={`${styles.methodBtn} ${method === 'GET' ? styles.active : ''}`}
                                    onClick={() => setMethod('GET')}
                                >GET</button>
                                <button
                                    className={`${styles.methodBtn} ${method === 'POST' ? styles.active : ''}`}
                                    onClick={() => setMethod('POST')}
                                >POST</button>
                            </div>
                        </div>
                    </div>
                    <div className={styles.actions}>
                        <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
                        <Button variant="primary" onClick={handleSubmit} disabled={!name || !url || isLoading}>
                            {isLoading ? 'Speichern...' : 'Hinzufügen'}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
