'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/layout';
import { Card, CardContent, Button, Input, ConfirmDialog } from '@/components/ui';
import styles from './page.module.css';

interface CanvasItem {
    id: string;
    name: string;
    description?: string;
    cardCount: number;
    createdAt: string;
    updatedAt: string;
}

export default function CanvasOverviewPage() {
    const [canvases, setCanvases] = useState<CanvasItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isCreating, setIsCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [newDescription, setNewDescription] = useState('');
    const [deleteConfirm, setDeleteConfirm] = useState<CanvasItem | null>(null);

    useEffect(() => {
        fetchCanvases();
    }, []);

    const fetchCanvases = async () => {
        try {
            const response = await fetch('/api/canvas');
            const data = await response.json();
            setCanvases(data.canvases || []);
        } catch (error) {
            console.error('Fehler beim Laden:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const createCanvas = async () => {
        if (!newName.trim()) return;

        try {
            const response = await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'create',
                    name: newName,
                    description: newDescription,
                }),
            });
            const data = await response.json();
            setCanvases([data.canvas, ...canvases]);
            setNewName('');
            setNewDescription('');
            setIsCreating(false);
        } catch (error) {
            console.error('Fehler beim Erstellen:', error);
        }
    };

    const deleteCanvas = async (id: string) => {
        try {
            await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'delete', id }),
            });
            setCanvases(canvases.filter(c => c.id !== id));
            setDeleteConfirm(null);
        } catch (error) {
            console.error('Fehler beim Löschen:', error);
        }
    };

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleDateString('de-DE', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    return (
        <AppShell title="Canvas">
            <div className={styles.container}>
                <div className={styles.header}>
                    <div>
                        <h1>Canvas Übersicht</h1>
                        <p className={styles.subtitle}>Erstelle und verwalte deine visuellen Planungen</p>
                    </div>
                    <Button variant="primary" onClick={() => setIsCreating(true)}>
                        + Neues Canvas
                    </Button>
                </div>

                {isCreating && (
                    <Card className={styles.createForm}>
                        <CardContent>
                            <div className={styles.formFields}>
                                <Input
                                    placeholder="Name des Canvas..."
                                    value={newName}
                                    onChange={(e) => setNewName(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && createCanvas()}
                                    autoFocus
                                />
                                <Input
                                    placeholder="Beschreibung (optional)..."
                                    value={newDescription}
                                    onChange={(e) => setNewDescription(e.target.value)}
                                />
                                <div className={styles.formActions}>
                                    <Button variant="ghost" onClick={() => setIsCreating(false)}>Abbrechen</Button>
                                    <Button variant="primary" onClick={createCanvas}>Erstellen</Button>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                )}

                {isLoading ? (
                    <p className={styles.loading}>Laden...</p>
                ) : canvases.length === 0 ? (
                    <Card className={styles.emptyState}>
                        <CardContent>
                            <div className={styles.emptyContent}>
                                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <rect x="3" y="3" width="18" height="18" rx="2" />
                                    <path d="M3 9h18" />
                                    <path d="M9 21V9" />
                                </svg>
                                <h3>Noch keine Canvases</h3>
                                <p>Erstelle dein erstes Canvas für visuelle Planung</p>
                                <Button variant="primary" onClick={() => setIsCreating(true)}>
                                    + Erstes Canvas erstellen
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                ) : (
                    <div className={styles.grid}>
                        {canvases.map((canvas) => (
                            <Link key={canvas.id} href={`/canvas/${canvas.id}`} className={styles.canvasCard}>
                                <div className={styles.cardPreview}>
                                    <span className={styles.cardCount}>{canvas.cardCount} Karten</span>
                                </div>
                                <div className={styles.cardInfo}>
                                    <h3>{canvas.name}</h3>
                                    {canvas.description && <p>{canvas.description}</p>}
                                    <span className={styles.cardDate}>
                                        Aktualisiert: {formatDate(canvas.updatedAt)}
                                    </span>
                                </div>
                                <button
                                    className={styles.deleteButton}
                                    onClick={(e) => {
                                        e.preventDefault();
                                        setDeleteConfirm(canvas);
                                    }}
                                >
                                    ×
                                </button>
                            </Link>
                        ))}
                    </div>
                )}
            </div>

            <ConfirmDialog
                isOpen={deleteConfirm !== null}
                title="Canvas löschen?"
                message={`Möchtest du "${deleteConfirm?.name}" wirklich löschen? Alle Karten und Verbindungen werden unwiderruflich entfernt.`}
                confirmText="Löschen"
                cancelText="Abbrechen"
                variant="danger"
                onConfirm={() => deleteConfirm && deleteCanvas(deleteConfirm.id)}
                onCancel={() => setDeleteConfirm(null)}
            />
        </AppShell>
    );
}
