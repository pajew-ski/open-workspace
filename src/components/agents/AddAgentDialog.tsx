'use client';

import { useState, useEffect } from 'react';
import { Button, Input, Card, CardContent } from '@/components/ui';
import styles from './AddAgentDialog.module.css';

interface AddAgentDialogProps {
    onClose: () => void;
    onAdd: (data: any) => Promise<void>;
}

export function AddAgentDialog({ onClose, onAdd }: AddAgentDialogProps) {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [type, setType] = useState('local');
    const [connectionId, setConnectionId] = useState('');
    const [systemPrompt, setSystemPrompt] = useState('');

    const [connections, setConnections] = useState<any[]>([]);

    useEffect(() => {
        fetchConnections();
    }, []);

    const fetchConnections = async () => {
        try {
            const res = await fetch('/api/connections');
            const data = await res.json();
            setConnections(data.connections || []);
        } catch (e) { console.error(e); }
    };

    const handleSubmit = async () => {
        if (!name) return;
        await onAdd({
            name,
            description,
            type,
            connectionId: type === 'remote_a2a' ? connectionId : undefined,
            config: {
                systemPrompt
            }
        });
        onClose();
    };

    return (
        <div className={styles.overlay}>
            <Card className={styles.dialog}>
                <CardContent>
                    <h3>Neuer Agent</h3>
                    <div className={styles.formGrid}>
                        <div className={styles.field}>
                            <label>Name</label>
                            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="z.B. Research Agent" />
                        </div>
                        <div className={styles.field}>
                            <label>Beschreibung</label>
                            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Verantwortlich für..." />
                        </div>
                        <div className={styles.field}>
                            <label>Typ</label>
                            <select className={styles.select} value={type} onChange={(e) => setType(e.target.value)}>
                                <option value="local">Lokal (System Prompt)</option>
                                <option value="remote_a2a">Remote (A2A Protocol)</option>
                            </select>
                        </div>

                        {type === 'remote_a2a' && (
                            <div className={styles.field}>
                                <label>Verbindung</label>
                                <select className={styles.select} value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                                    <option value="">Wähle eine Verbindung...</option>
                                    {connections.map(c => (
                                        <option key={c.id} value={c.id}>{c.name} ({c.baseUrl})</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {type === 'local' && (
                            <div className={styles.field}>
                                <label>System Prompt</label>
                                <textarea
                                    className={styles.textarea}
                                    value={systemPrompt}
                                    onChange={(e) => setSystemPrompt(e.target.value)}
                                    placeholder="Du bist ein..."
                                    rows={4}
                                />
                            </div>
                        )}

                        <div className={styles.actions}>
                            <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
                            <Button variant="primary" onClick={handleSubmit} disabled={!name}>Erstellen</Button>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
