'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, Button, Input } from '@/components/ui';
import styles from './ConnectionManager.module.css';

export function ConnectionManager() {
    const [connections, setConnections] = useState<any[]>([]);
    const [isAdding, setIsAdding] = useState(false);

    // Form State
    const [name, setName] = useState('');
    const [baseUrl, setBaseUrl] = useState('');
    const [authType, setAuthType] = useState('bearer');
    const [token, setToken] = useState('');
    const [isEnv, setIsEnv] = useState(false); // Toggle between regular value and ENV ref

    useEffect(() => {
        fetchConnections();
    }, []);

    const fetchConnections = async () => {
        const res = await fetch('/api/connections');
        const data = await res.json();
        setConnections(data.connections || []);
    };

    const handleSave = async () => {
        const payload = {
            name,
            type: 'rest',
            baseUrl,
            auth: {
                type: authType,
                // Prefix with ENV: if isEnv is true
                token: isEnv ? `ENV:${token}` : token,
            }
        };

        await fetch('/api/connections', {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' }
        });

        setIsAdding(false);
        resetForm();
        fetchConnections();
    };

    const resetForm = () => {
        setName('');
        setBaseUrl('');
        setToken('');
        setIsEnv(false);
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.info}>
                    <span className={styles.label}>Verbindungen</span>
                    <span className={styles.description}>
                        Verwalte Zugangsdaten und Basis-URLs zentral.
                    </span>
                </div>
                <Button variant="primary" size="sm" onClick={() => setIsAdding(true)}>+ Verbindung</Button>
            </div>

            {isAdding && (
                <Card className={styles.editCard}>
                    <CardContent>
                        <div className={styles.formGrid}>
                            <div className={styles.field}>
                                <label>Name</label>
                                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="z.B. OpenAI GitHub" />
                            </div>
                            <div className={styles.field}>
                                <label>Base URL</label>
                                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" />
                            </div>
                            <div className={styles.field}>
                                <label>Auth Typ</label>
                                <select className={styles.select} value={authType} onChange={(e) => setAuthType(e.target.value)}>
                                    <option value="bearer">Bearer Token</option>
                                    <option value="apikey">API Key</option>
                                    <option value="none">Keine</option>
                                </select>
                            </div>
                            {authType !== 'none' && (
                                <div className={styles.field}>
                                    <div className={styles.labelRow}>
                                        <label>Secret / Token</label>
                                        <label className={styles.checkbox}>
                                            <input type="checkbox" checked={isEnv} onChange={(e) => setIsEnv(e.target.checked)} />
                                            Nutze ENV Variable
                                        </label>
                                    </div>
                                    <Input
                                        value={token}
                                        onChange={(e) => setToken(e.target.value)}
                                        placeholder={isEnv ? "MY_API_KEY" : "sk-..."}
                                        type={isEnv ? "text" : "password"}
                                    />
                                </div>
                            )}
                            <div className={styles.actions}>
                                <Button variant="ghost" onClick={() => setIsAdding(false)}>Abbrechen</Button>
                                <Button variant="primary" onClick={handleSave}>Speichern</Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}

            <div className={styles.list}>
                {connections.map(conn => (
                    <div key={conn.id} className={styles.item}>
                        <div className={styles.itemInfo}>
                            <strong>{conn.name}</strong>
                            <span className={styles.meta}>{conn.baseUrl} • {conn.auth.type}</span>
                        </div>
                        <div className={styles.tags}>
                            {conn.auth.token && conn.auth.token === '***' && <span className={styles.secureTag}>Encrypted</span>}
                        </div>
                    </div>
                ))}
                {connections.length === 0 && !isAdding && (
                    <div className={styles.empty}>Keine Verbindungen vorhanden.</div>
                )}
            </div>
        </div>
    );
}
