'use client';

import { useState, useEffect, useCallback } from 'react';
import { AppShell } from '@/components/layout';
import { Card, CardHeader, CardContent, Button, Input } from '@/components/ui';
import { MarkdownEditor } from '@/components/markdown';
import styles from './page.module.css';

interface Note {
    id: string;
    title: string;
    content: string;
    category?: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
}

export default function KnowledgePage() {
    const [notes, setNotes] = useState<Note[]>([]);
    const [selectedNote, setSelectedNote] = useState<Note | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isCreating, setIsCreating] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [renameId, setRenameId] = useState<string | null>(null);
    const [renameTitle, setRenameTitle] = useState('');
    const [hasChanges, setHasChanges] = useState(false);

    // Fetch notes on mount
    useEffect(() => {
        fetchNotes();
    }, []);

    const fetchNotes = async () => {
        try {
            const response = await fetch('/api/notes');
            const data = await response.json();
            setNotes(data.notes || []);
        } catch (error) {
            console.error('Fehler beim Laden der Notizen:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSelectNote = (note: Note) => {
        if (hasChanges && selectedNote) {
            // Auto-save current note
            handleSaveNote();
        }
        setSelectedNote(note);
        setHasChanges(false);
    };

    const handleContentChange = useCallback((content: string) => {
        if (selectedNote) {
            setSelectedNote({ ...selectedNote, content });
            setHasChanges(true);
        }
    }, [selectedNote]);

    const handleSaveNote = async () => {
        if (!selectedNote) return;

        try {
            await fetch(`/api/notes/${selectedNote.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: selectedNote.title,
                    content: selectedNote.content,
                    category: selectedNote.category,
                    tags: selectedNote.tags,
                }),
            });
            setHasChanges(false);
            fetchNotes();
        } catch (error) {
            console.error('Fehler beim Speichern:', error);
        }
    };

    const handleRenameSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!renameId || !renameTitle.trim()) return;

        try {
            const noteToUpdate = notes.find(n => n.id === renameId);
            if (!noteToUpdate) return;

            await fetch(`/api/notes/${renameId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...noteToUpdate, title: renameTitle }),
            });

            setRenameId(null);
            fetchNotes();
            if (selectedNote?.id === renameId) {
                setSelectedNote({ ...selectedNote!, title: renameTitle });
            }
        } catch (error) {
            console.error('Fehler beim Umbenennen:', error);
        }
    };

    const handleCreateNote = async () => {
        if (!newTitle.trim()) return;

        try {
            const response = await fetch('/api/notes', {
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
            await fetchNotes();
            setSelectedNote(data.note);
        } catch (error) {
            console.error('Fehler beim Erstellen:', error);
        }
    };

    const handleDeleteNote = async () => {
        if (!selectedNote) return;
        if (!confirm('Möchtest du diese Notiz wirklich löschen?')) return;

        try {
            await fetch(`/api/notes/${selectedNote.id}`, { method: 'DELETE' });
            setSelectedNote(null);
            fetchNotes();
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

    return (
        <AppShell title="Wissensbasis">
            <div className={styles.container}>
                {/* Sidebar with note list */}
                <div className={styles.sidebar}>
                    <div className={styles.sidebarHeader}>
                        <h3>Notizen</h3>
                        <Button variant="primary" size="sm" onClick={() => setIsCreating(true)}>
                            +
                        </Button>
                    </div>

                    {isCreating && (
                        <div className={styles.createForm}>
                            <Input
                                placeholder="Titel der neuen Notiz..."
                                value={newTitle}
                                onChange={(e) => setNewTitle(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleCreateNote()}
                            />
                            <div className={styles.createActions}>
                                <Button variant="ghost" size="sm" onClick={() => setIsCreating(false)}>
                                    Abbrechen
                                </Button>
                                <Button variant="primary" size="sm" onClick={handleCreateNote}>
                                    Erstellen
                                </Button>
                            </div>
                        </div>
                    )}

                    <div className={styles.noteList}>
                        {isLoading ? (
                            <p className={styles.loading}>Laden...</p>
                        ) : notes.length === 0 ? (
                            <p className={styles.empty}>Keine Notizen vorhanden</p>
                        ) : (
                            notes.map((note) => (
                                <div key={note.id} className={`${styles.noteItemWrapper} ${selectedNote?.id === note.id ? styles.active : ''}`}>
                                    {renameId === note.id ? (
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
                                        <div className={styles.noteItemContent} onClick={() => handleSelectNote(note)}>
                                            <div className={styles.noteInfo}>
                                                <span className={styles.noteTitle}>{note.title}</span>
                                                <span className={styles.noteDate}>{formatDate(note.updatedAt)}</span>
                                            </div>
                                            <button
                                                className={styles.renameBtn}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setRenameId(note.id);
                                                    setRenameTitle(note.title);
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
                    {selectedNote ? (
                        <>
                            <div className={styles.editorHeader}>
                                <input
                                    type="text"
                                    className={styles.titleInput}
                                    value={selectedNote.title}
                                    onChange={(e) => {
                                        setSelectedNote({ ...selectedNote, title: e.target.value });
                                        setHasChanges(true);
                                    }}
                                />
                                <div className={styles.editorActions}>
                                    {hasChanges && (
                                        <span className={styles.unsaved}>Ungespeichert</span>
                                    )}
                                    <Button variant="secondary" size="sm" onClick={handleSaveNote}>
                                        Speichern
                                    </Button>
                                    <Button variant="ghost" size="sm" onClick={handleDeleteNote}>
                                        Löschen
                                    </Button>
                                </div>
                            </div>
                            <MarkdownEditor
                                content={selectedNote.content}
                                onChange={handleContentChange}
                                defaultMode="read"
                            />
                        </>
                    ) : (
                        <Card className={styles.emptyState}>
                            <CardContent>
                                <div className={styles.emptyContent}>
                                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                                        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                                    </svg>
                                    <h3>Keine Notiz ausgewählt</h3>
                                    <p>Wähle eine Notiz aus der Liste oder erstelle eine neue.</p>
                                    <Button variant="primary" onClick={() => setIsCreating(true)}>
                                        Neue Notiz erstellen
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
