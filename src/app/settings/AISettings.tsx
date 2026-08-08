'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui';
import styles from './page.module.css';

interface HealthInfo {
    status: 'online' | 'offline' | 'error';
    models?: string[];
}

interface SettingsResponse {
    settings: {
        inference: { endpoint: string; model: string };
    };
}

/**
 * Functional inference settings: endpoint + model are persisted via
 * /api/settings and picked up server-side by the inference client.
 */
export function AISettings() {
    const queryClient = useQueryClient();
    const [endpoint, setEndpoint] = useState('');
    const [model, setModel] = useState('');
    const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

    const { data } = useQuery<SettingsResponse>({
        queryKey: ['settings'],
        queryFn: async () => {
            const res = await fetch('/api/settings');
            if (!res.ok) throw new Error('Einstellungen nicht ladbar');
            return res.json();
        },
    });

    const { data: health } = useQuery<HealthInfo>({
        queryKey: ['chat-health'],
        queryFn: async () => {
            const res = await fetch('/api/chat/health');
            return res.json();
        },
        staleTime: 10_000,
    });

    // Sync form once settings arrive
    useEffect(() => {
        if (data?.settings) {
            setEndpoint(data.settings.inference.endpoint);
            setModel(data.settings.inference.model);
        }
    }, [data]);

    const handleSave = async () => {
        setStatus('saving');
        try {
            const res = await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ inference: { endpoint, model } }),
            });
            if (!res.ok) throw new Error(String(res.status));
            setStatus('saved');
            queryClient.invalidateQueries({ queryKey: ['settings'] });
            queryClient.invalidateQueries({ queryKey: ['chat-health'] });
            setTimeout(() => setStatus('idle'), 2500);
        } catch {
            setStatus('error');
        }
    };

    const connected = health?.status === 'online';

    return (
        <>
            <div className={styles.setting}>
                <div className={styles.settingInfo}>
                    <span className={styles.settingLabel}>Inference-Endpunkt</span>
                    <span className={styles.settingDescription}>
                        URL des lokalen oder entfernten AI-Servers (Ollama oder OpenAI-kompatibel)
                    </span>
                </div>
                <div className={styles.inputGroup}>
                    <input
                        type="url"
                        className={styles.input}
                        placeholder="http://localhost:11434"
                        value={endpoint}
                        onChange={(e) => setEndpoint(e.target.value)}
                    />
                </div>
            </div>
            <div className={styles.setting}>
                <div className={styles.settingInfo}>
                    <span className={styles.settingLabel}>Modell</span>
                    <span className={styles.settingDescription}>
                        Name des zu verwendenden AI-Modells
                    </span>
                </div>
                <div className={styles.inputGroup}>
                    {health?.models?.length ? (
                        <select
                            className={styles.input}
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                        >
                            {!health.models.includes(model) && model && (
                                <option value={model}>{model}</option>
                            )}
                            {health.models.map((m) => (
                                <option key={m} value={m}>{m}</option>
                            ))}
                        </select>
                    ) : (
                        <input
                            type="text"
                            className={styles.input}
                            placeholder="gpt-oss:20b"
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                        />
                    )}
                </div>
            </div>
            <div className={styles.setting}>
                <div className={styles.settingInfo}>
                    <span className={styles.settingLabel}>Status</span>
                    <span className={styles.settingDescription}>
                        {connected
                            ? 'Verbunden — der Assistent ist einsatzbereit'
                            : 'Nicht erreichbar — prüfe, ob dein AI-Server läuft'}
                    </span>
                </div>
                <div className={styles.inputGroup}>
                    <Button variant="primary" size="sm" onClick={handleSave} disabled={status === 'saving'}>
                        {status === 'saving' ? 'Speichere…' : status === 'saved' ? 'Gespeichert ✓' : 'Speichern'}
                    </Button>
                    {status === 'error' && (
                        <span role="alert" className={styles.settingDescription}>Speichern fehlgeschlagen</span>
                    )}
                </div>
            </div>
        </>
    );
}
