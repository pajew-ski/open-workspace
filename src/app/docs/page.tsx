'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { AppShell } from '@/components/layout';
import { Card, CardContent, Button, Input, FloatingActionButton } from '@/components/ui';
import { MarkdownEditor } from '@/components/markdown';
import { JsonLdScript } from '@/components/seo/JsonLdScript';
import { generateDocJsonLd } from '@/lib/ontology/generator';
import { Doc } from '@/types/doc';
import styles from './page.module.css';

export default function DocsPage() {
    const [docs, setDocs] = useState<Doc[]>([]);
    const [selectedDoc, setSelectedDoc] = useState<Doc | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isCreating, setIsCreating] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [renameId, setRenameId] = useState<string | null>(null);
    const [renameTitle, setRenameTitle] = useState('');
    const [hasChanges, setHasChanges] = useState(false);

    // Fetch docs on mount
    useEffect(() => {
        fetchDocs();
    }, []);

    const fetchDocs = async () => {
        try {
            const response = await fetch('/api/docs');
            const data = await response.json();
            setDocs(data.docs || []);
        } catch (error) {
            console.error('Fehler beim Laden der Dokumente:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSelectDoc = (doc: Doc) => {
        if (hasChanges && selectedDoc) {
            // Auto-save current doc
            handleSaveDoc();
        }
        setSelectedDoc(doc);
        setHasChanges(false);
    };

    const handleContentChange = useCallback((content: string) => {
        if (selectedDoc) {
            setSelectedDoc({ ...selectedDoc, content });
            setHasChanges(true);
        }
    }, [selectedDoc]);

    const handleSaveDoc = async () => {
        if (!selectedDoc) return;

        try {
            await fetch(`/api/docs/${selectedDoc.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: selectedDoc.title,
                    content: selectedDoc.content,
                    category: selectedDoc.category,
                    tags: selectedDoc.tags,
                }),
            });
            setHasChanges(false);
            fetchDocs();
        } catch (error) {
            console.error('Fehler beim Speichern:', error);
        }
    };

    const handleRenameSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!renameId || !renameTitle.trim()) return;

        try {
            const docToUpdate = docs.find(n => n.id === renameId);
            if (!docToUpdate) return;

            await fetch(`/api/docs/${renameId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...docToUpdate, title: renameTitle }),
            });

            setRenameId(null);
            fetchDocs();
            if (selectedDoc?.id === renameId) {
                setSelectedDoc({ ...selectedDoc!, title: renameTitle });
            }
        } catch (error) {
            console.error('Fehler beim Umbenennen:', error);
        }
    };

    const handleCreateDoc = async () => {
        if (!newTitle.trim()) return;

        try {
            const response = await fetch('/api/docs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: newTitle,
                    content: `# ${newTitle}\n\nSchreibe hier deinen Inhalt...`,
                }),
            });
            const data = await response.json();
            setNewTitle('');
            setIsCreating(false);
            await fetchDocs();
            setSelectedDoc(data.doc);
        } catch (error) {
            console.error('Fehler beim Erstellen:', error);
        }
    };

    const handleDeleteDoc = async () => {
        if (!selectedDoc) return;
        if (!confirm('Möchtest du dieses Dokument wirklich löschen?')) return;

        try {
            await fetch(`/api/docs/${selectedDoc.id}`, { method: 'DELETE' });
            setSelectedDoc(null);
            fetchDocs();
        } catch (error) {
            console.error('Fehler beim Löschen:', error);
        }
    };

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleDateString('de-DE', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
        });
    };

    // Generate JSON-LD
    const jsonLdData = useMemo(() => {
        if (!selectedDoc) return null;
        return generateDocJsonLd(selectedDoc);
    }, [selectedDoc]);

    return (
        <AppShell
            title="Dokumente"
            actions={
                <FloatingActionButton
                    icon={<span style={{ fontSize: '24px' }}>+</span>}
                    onClick={() => setIsCreating(true)}
                    label="Neues Dokument"
                />
            }
        >
            <JsonLdScript data={jsonLdData} />
            <div className={styles.container}>
                {/* Sidebar with doc list */}
                <div className={styles.sidebar}>
                    <div className={styles.sidebarHeader}>
                        <h3>Dokumente</h3>
                        <Button variant="primary" size="sm" onClick={() => setIsCreating(true)}>
                            +
                        </Button>
                    </div>

                    {isCreating && (
                        <div className={styles.createForm}>
                            <Input
                                placeholder="Titel des neuen Dokuments..."
                                value={newTitle}
                                onChange={(e) => setNewTitle(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleCreateDoc()}
                            />
                            <div className={styles.createActions}>
                                <Button variant="ghost" size="sm" onClick={() => setIsCreating(false)}>
                                    Abbrechen
                                </Button>
                                <Button variant="primary" size="sm" onClick={handleCreateDoc}>
                                    Erstellen
                                </Button>
                            </div>
                        </div>
                    )}

                    <div className={styles.noteList}>
                        {isLoading ? (
                            <p className={styles.loading}>Laden...</p>
                        ) : docs.length === 0 ? (
                            <p className={styles.empty}>Keine Dokumente vorhanden</p>
                        ) : (
                            docs.map((doc) => (
                                <div key={doc.id} className={`${styles.noteItemWrapper} ${selectedDoc?.id === doc.id ? styles.active : ''}`}>
                                    {renameId === doc.id ? (
                                        <form className={styles.renameForm} onSubmit={handleRenameSubmit} onClick={e => e.stopPropagation()}>
                                            <input
                                                className={styles.renameInput}
                                                value={renameTitle}
                                                onChange={e => setRenameTitle(e.target.value)}
                                                autoFocus
                                                onBlur={() => setRenameId(null)}
                                            />
                                        </form>
                                    ) : (
                                        <div className={styles.noteItemContent} onClick={() => handleSelectDoc(doc)}>
                                            <div className={styles.noteInfo}>
                                                <span className={styles.noteTitle}>{doc.title}</span>
                                                <span className={styles.noteDate}>{formatDate(doc.updatedAt)}</span>
                                            </div>
                                            <button
                                                className={styles.renameBtn}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setRenameId(doc.id);
                                                    setRenameTitle(doc.title);
                                                }}
                                                title="Umbenennen"
                                            >
                                                ✎
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </div>

                {/* Editor area */}
                <div className={styles.editorArea}>
                    {selectedDoc ? (
                        <>
                            <div className={styles.editorHeader}>
                                <input
                                    type="text"
                                    className={styles.titleInput}
                                    value={selectedDoc.title}
                                    onChange={(e) => {
                                        setSelectedDoc({ ...selectedDoc, title: e.target.value });
                                        setHasChanges(true);
                                    }}
                                />
                                <div className={styles.editorActions}>
                                    {hasChanges && (
                                        <span className={styles.unsaved}>Ungespeichert</span>
                                    )}
                                    <Button variant="secondary" size="sm" onClick={handleSaveDoc}>
                                        Speichern
                                    </Button>
                                    <Button variant="ghost" size="sm" onClick={handleDeleteDoc}>
                                        Löschen
                                    </Button>
                                </div>
                            </div>
                            <MarkdownEditor
                                content={selectedDoc.content}
                                onChange={handleContentChange}
                                defaultMode="read"
                            />
                        </>
                    ) : (
                        <Card className={styles.emptyState}>
                            <CardContent>
                                <div className={styles.emptyContent}>
                                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                        <polyline points="14 2 14 8 20 8" />
                                        <line x1="16" y1="13" x2="8" y2="13" />
                                        <line x1="16" y1="17" x2="8" y2="17" />
                                        <polyline points="10 9 9 9 8 9" />
                                    </svg>
                                    <h3>Kein Dokument ausgewählt</h3>
                                    <p>Wähle ein Dokument aus der Liste oder erstelle ein neues.</p>
                                    <Button variant="primary" onClick={() => setIsCreating(true)}>
                                        Neues Dokument erstellen
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>
                    )}
                </div>
            </div>
        </AppShell>
    );
}
