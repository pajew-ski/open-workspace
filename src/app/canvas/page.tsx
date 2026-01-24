'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui';
import styles from './page.module.css';

interface CanvasCard {
    id: string;
    type: 'note' | 'task' | 'link' | 'image';
    title: string;
    content?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color?: string;
}

interface CanvasConnection {
    id: string;
    fromId: string;
    toId: string;
    label?: string;
}

interface DragState {
    cardId: string | null;
    offsetX: number;
    offsetY: number;
}

const CARD_COLORS = ['#00674F', '#2563eb', '#7c3aed', '#dc2626', '#ea580c', '#65a30d'];

export default function CanvasPage() {
    const [cards, setCards] = useState<CanvasCard[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [selectedCard, setSelectedCard] = useState<string | null>(null);
    const [dragState, setDragState] = useState<DragState>({ cardId: null, offsetX: 0, offsetY: 0 });
    const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
    const [isPanning, setIsPanning] = useState(false);
    const [panStart, setPanStart] = useState({ x: 0, y: 0 });
    const canvasRef = useRef<HTMLDivElement>(null);

    // Fetch canvas data
    useEffect(() => {
        fetchCanvas();
    }, []);

    const fetchCanvas = async () => {
        try {
            const response = await fetch('/api/canvas');
            const data = await response.json();
            setCards(data.cards || []);
            setConnections(data.connections || []);
            if (data.viewport) setViewport(data.viewport);
        } catch (error) {
            console.error('Fehler beim Laden:', error);
        }
    };

    const createCard = async (x: number, y: number) => {
        try {
            const response = await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'createCard',
                    title: 'Neue Karte',
                    x: (x - viewport.x) / viewport.zoom,
                    y: (y - viewport.y) / viewport.zoom,
                }),
            });
            const data = await response.json();
            setCards([...cards, data.card]);
            setSelectedCard(data.card.id);
        } catch (error) {
            console.error('Fehler beim Erstellen:', error);
        }
    };

    const updateCard = async (id: string, updates: Partial<CanvasCard>) => {
        try {
            await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'updateCard', id, updates }),
            });
            setCards(cards.map(c => c.id === id ? { ...c, ...updates } : c));
        } catch (error) {
            console.error('Fehler beim Aktualisieren:', error);
        }
    };

    const deleteCard = async (id: string) => {
        try {
            await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'deleteCard', id }),
            });
            setCards(cards.filter(c => c.id !== id));
            setConnections(connections.filter(c => c.fromId !== id && c.toId !== id));
            if (selectedCard === id) setSelectedCard(null);
        } catch (error) {
            console.error('Fehler beim Löschen:', error);
        }
    };

    // Drag handling
    const handleMouseDown = useCallback((e: React.MouseEvent, cardId: string) => {
        e.stopPropagation();
        const card = cards.find(c => c.id === cardId);
        if (!card) return;

        const rect = (e.target as HTMLElement).closest(`.${styles.card}`)?.getBoundingClientRect();
        if (!rect) return;

        setDragState({
            cardId,
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
        });
        setSelectedCard(cardId);
    }, [cards]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (dragState.cardId) {
            const canvasRect = canvasRef.current?.getBoundingClientRect();
            if (!canvasRect) return;

            const newX = (e.clientX - canvasRect.left - dragState.offsetX - viewport.x) / viewport.zoom;
            const newY = (e.clientY - canvasRect.top - dragState.offsetY - viewport.y) / viewport.zoom;

            setCards(cards.map(c =>
                c.id === dragState.cardId ? { ...c, x: newX, y: newY } : c
            ));
        } else if (isPanning) {
            setViewport({
                ...viewport,
                x: viewport.x + (e.clientX - panStart.x),
                y: viewport.y + (e.clientY - panStart.y),
            });
            setPanStart({ x: e.clientX, y: e.clientY });
        }
    }, [dragState, cards, isPanning, panStart, viewport]);

    const handleMouseUp = useCallback(() => {
        if (dragState.cardId) {
            const card = cards.find(c => c.id === dragState.cardId);
            if (card) {
                updateCard(card.id, { x: card.x, y: card.y });
            }
        }
        setDragState({ cardId: null, offsetX: 0, offsetY: 0 });
        setIsPanning(false);
    }, [dragState, cards]);

    const handleCanvasMouseDown = (e: React.MouseEvent) => {
        if (e.target === canvasRef.current || (e.target as HTMLElement).classList.contains(styles.grid)) {
            setSelectedCard(null);
            setIsPanning(true);
            setPanStart({ x: e.clientX, y: e.clientY });
        }
    };

    const handleDoubleClick = (e: React.MouseEvent) => {
        if (e.target === canvasRef.current || (e.target as HTMLElement).classList.contains(styles.grid)) {
            const rect = canvasRef.current?.getBoundingClientRect();
            if (rect) {
                createCard(e.clientX - rect.left, e.clientY - rect.top);
            }
        }
    };

    const handleWheel = (e: React.WheelEvent) => {
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.min(Math.max(viewport.zoom * delta, 0.25), 2);
        setViewport({ ...viewport, zoom: newZoom });
    };

    const handleZoomIn = () => setViewport({ ...viewport, zoom: Math.min(viewport.zoom * 1.2, 2) });
    const handleZoomOut = () => setViewport({ ...viewport, zoom: Math.max(viewport.zoom * 0.8, 0.25) });
    const handleResetView = () => setViewport({ x: 0, y: 0, zoom: 1 });

    return (
        <AppShell title="Canvas">
            <div className={styles.container}>
                <div className={styles.toolbar}>
                    <div className={styles.toolGroup}>
                        <Button variant="ghost" size="sm" onClick={() => {
                            const rect = canvasRef.current?.getBoundingClientRect();
                            if (rect) createCard(rect.width / 2, rect.height / 2);
                        }}>
                            + Karte
                        </Button>
                    </div>
                    <div className={styles.toolGroup}>
                        <Button variant="ghost" size="sm" onClick={handleZoomOut}>−</Button>
                        <span className={styles.zoomLevel}>{Math.round(viewport.zoom * 100)}%</span>
                        <Button variant="ghost" size="sm" onClick={handleZoomIn}>+</Button>
                        <Button variant="ghost" size="sm" onClick={handleResetView}>Reset</Button>
                    </div>
                </div>

                <div
                    ref={canvasRef}
                    className={styles.canvas}
                    onMouseDown={handleCanvasMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    onDoubleClick={handleDoubleClick}
                    onWheel={handleWheel}
                >
                    <div
                        className={styles.grid}
                        style={{
                            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
                            transformOrigin: '0 0',
                        }}
                    >
                        {/* Render connections */}
                        <svg className={styles.connections}>
                            {connections.map(conn => {
                                const from = cards.find(c => c.id === conn.fromId);
                                const to = cards.find(c => c.id === conn.toId);
                                if (!from || !to) return null;

                                const x1 = from.x + from.width / 2;
                                const y1 = from.y + from.height / 2;
                                const x2 = to.x + to.width / 2;
                                const y2 = to.y + to.height / 2;

                                return (
                                    <line
                                        key={conn.id}
                                        x1={x1}
                                        y1={y1}
                                        x2={x2}
                                        y2={y2}
                                        stroke="var(--color-border)"
                                        strokeWidth={2}
                                    />
                                );
                            })}
                        </svg>

                        {/* Render cards */}
                        {cards.map(card => (
                            <div
                                key={card.id}
                                className={`${styles.card} ${selectedCard === card.id ? styles.selected : ''}`}
                                style={{
                                    left: card.x,
                                    top: card.y,
                                    width: card.width,
                                    height: card.height,
                                    borderColor: card.color || 'var(--color-border)',
                                }}
                                onMouseDown={(e) => handleMouseDown(e, card.id)}
                            >
                                <div className={styles.cardHeader}>
                                    <input
                                        className={styles.cardTitle}
                                        value={card.title}
                                        onChange={(e) => updateCard(card.id, { title: e.target.value })}
                                        onMouseDown={(e) => e.stopPropagation()}
                                    />
                                    <button
                                        className={styles.cardDelete}
                                        onClick={() => deleteCard(card.id)}
                                        onMouseDown={(e) => e.stopPropagation()}
                                    >
                                        ×
                                    </button>
                                </div>
                                <textarea
                                    className={styles.cardContent}
                                    value={card.content || ''}
                                    onChange={(e) => updateCard(card.id, { content: e.target.value })}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    placeholder="Inhalt..."
                                />
                                <div className={styles.cardColors}>
                                    {CARD_COLORS.map(color => (
                                        <button
                                            key={color}
                                            className={styles.colorDot}
                                            style={{ backgroundColor: color }}
                                            onClick={() => updateCard(card.id, { color })}
                                            onMouseDown={(e) => e.stopPropagation()}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>

                    {cards.length === 0 && (
                        <div className={styles.emptyState}>
                            <h3>Leeres Canvas</h3>
                            <p>Doppelklicke, um eine Karte zu erstellen</p>
                        </div>
                    )}
                </div>
            </div>
        </AppShell>
    );
}
