'use client';

import { useState, useEffect } from 'react';
import { Button, Input, Card, CardContent } from '@/components/ui';
import styles from './CalendarSettings.module.css';

interface CalendarProvider {
    id: string;
    name: string;
    url: string;
    color: string;
    enabled: boolean;
    lastSync: string | null;
}

// Achromatische Voreinstellungen — Provider dürfen jede Farbe liefern,
// die App selbst bietet nur Graustufen an (kein Farbton im UI).
const PRESET_COLORS = ['#1a1a1a', '#3d3d3d', '#5c5c5c', '#7a7a7a', '#999999', '#b8b8b8', '#d6d6d6'];

export function CalendarSettings() {
    const [providers, setProviders] = useState<CalendarProvider[]>([]);
    const [isAdding, setIsAdding] = useState(false);
    const [newName, setNewName] = useState('');
    const [newUrl, setNewUrl] = useState('');
    const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
    const [isLoading, setIsLoading] = useState(false);

    const fetchProviders = async () => {
        try {
            const res = await fetch('/api/calendar');
            const data = await res.json();
            setProviders(data.providers || []);
        } catch (e) {
            console.error(e);
        }
    };

    useEffect(() => {
        fetchProviders();
    }, []);


    const handleAdd = async () => {
        if (!newName || !newUrl) return;
        setIsLoading(true);
        try {
            const res = await fetch('/api/calendar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'addProvider', name: newName, url: newUrl, color: newColor }),
            });
            if (res.ok) {
                setNewName('');
                setNewUrl('');
                setIsAdding(false);
                fetchProviders();
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Kalender wirklich löschen?')) return;
        try {
            await fetch('/api/calendar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'deleteProvider', id }),
            });
            fetchProviders();
        } catch (e) {
            console.error(e);
        }
    };

    const handleSync = async (id: string) => {
        try {
            await fetch('/api/calendar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'syncProvider', id }),
            });
            fetchProviders();
            alert('Kalender erfolgreich synchronisiert!');
        } catch (e) {
            console.error(e);
            alert('Fehler beim Synchronisieren');
        }
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.info}>
                    <span className={styles.label}>Kalender-Feeds</span>
                    <span className={styles.description}>
                        Abonniere externe ICS/iCal Kalender (z.B. Google Calendar, Outlook)
                    </span>
                </div>
                {!isAdding && (
                    <Button variant="primary" size="sm" onClick={() => setIsAdding(true)}>+ Hinzufügen</Button>
                )}
            </div>

            {isAdding && (
                <Card className={styles.addForm}>
                    <CardContent>
                        <div className={styles.formGrid}>
                            <Input
                                placeholder="Name (z.B. Arbeit)"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                            />
                            <Input
                                placeholder="https://..."
                                value={newUrl}
                                onChange={(e) => setNewUrl(e.target.value)}
                            />
                            <div className={styles.colorPicker}>
                                {PRESET_COLORS.map(c => (
                                    <button
                                        key={c}
                                        className={`${styles.colorDot} ${newColor === c ? styles.active : ''}`}
                                        style={{ backgroundColor: c }}
                                        onClick={() => setNewColor(c)}
                                    />
                                ))}
                            </div>
                            <div className={styles.formActions}>
                                <Button variant="ghost" onClick={() => setIsAdding(false)}>Abbrechen</Button>
                                <Button variant="primary" onClick={handleAdd} disabled={!newName || !newUrl || isLoading}>
                                    {isLoading ? '...' : 'Speichern'}
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}

            <div className={styles.list}>
                {providers.length === 0 && !isAdding && (
                    <div className={styles.empty}>Keine Kalender verbunden</div>
                )}
                {providers.map(provider => (
                    <div key={provider.id} className={styles.providerItem}>
                        <div className={styles.providerInfo}>
                            <div className={styles.providerName}>
                                <span className={styles.providerColor} style={{ backgroundColor: provider.color }} />
                                {provider.name}
                            </div>
                            <div className={styles.providerMeta}>
                                {provider.url} • Synced: {provider.lastSync ? new Date(provider.lastSync).toLocaleString('de-DE') : 'Never'}
                            </div>
                        </div>
                        <div className={styles.providerActions}>
                            <Button variant="ghost" size="sm" onClick={() => handleSync(provider.id)}>Sync</Button>
                            <Button variant="ghost" size="sm" onClick={() => handleDelete(provider.id)}>Löschen</Button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
