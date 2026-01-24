'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/layout';
import { Button, IconButton } from '@/components/ui';
import styles from './page.module.css';

// Types
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
    type: 'simple' | 'directional' | 'bidirectional';
    label?: string;
}

type ConnectionMode = 'none' | 'connecting';
type ResizeDirection = 'se' | 'sw' | 'ne' | 'nw' | 'e' | 'w' | 'n' | 's' | null;

const CARD_COLORS = ['#00674F', '#2563eb', '#7c3aed', '#dc2626', '#ea580c', '#65a30d'];
const MIN_CARD_SIZE = { width: 150, height: 100 };
const GRID_SIZE = 20;

// Simple Markdown parser for card content
function parseMarkdown(md: string): string {
    if (!md) return '';
    return md
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/^### (.+)$/gm, '<h4>$1</h4>')
        .replace(/^## (.+)$/gm, '<h3>$1</h3>')
        .replace(/^# (.+)$/gm, '<h2>$1</h2>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^- (.+)$/gm, '• $1')
        .replace(/\n/g, '<br />');
}

export default function CanvasPage() {
    const router = useRouter();

    // State
    const [cards, setCards] = useState<CanvasCard[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
    const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });

    // Interaction state
    const [dragState, setDragState] = useState<{ cardId: string | null; offsetX: number; offsetY: number }>({ cardId: null, offsetX: 0, offsetY: 0 });
    const [resizeState, setResizeState] = useState<{ cardId: string | null; direction: ResizeDirection; startX: number; startY: number; startWidth: number; startHeight: number }>({ cardId: null, direction: null, startX: 0, startY: 0, startWidth: 0, startHeight: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const [panStart, setPanStart] = useState({ x: 0, y: 0 });

    // Connection mode
    const [connectionMode, setConnectionMode] = useState<ConnectionMode>('none');
    const [connectionStart, setConnectionStart] = useState<string | null>(null);
    const [connectionType, setConnectionType] = useState<CanvasConnection['type']>('directional');
    const [pendingConnection, setPendingConnection] = useState<{ x: number; y: number } | null>(null);

    // Edit state
    const [editingCardId, setEditingCardId] = useState<string | null>(null);
    const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
    const [snapToGrid, setSnapToGrid] = useState(true);

    // Refs
    const canvasRef = useRef<HTMLDivElement>(null);

    // Fetch canvas data
    useEffect(() => {
        fetchCanvas();
    }, []);

    // Keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (editingCardId || editingConnectionId) return;
                selectedCards.forEach(id => deleteCard(id));
                setSelectedCards(new Set());
            }
            if (e.key === 'Escape') {
                setConnectionMode('none');
                setConnectionStart(null);
                setPendingConnection(null);
                setSelectedCards(new Set());
            }
            if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                setSelectedCards(new Set(cards.map(c => c.id)));
            }
            if (e.key === 'g' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                setSnapToGrid(!snapToGrid);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedCards, cards, editingCardId, editingConnectionId, snapToGrid]);

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

    const snapValue = (value: number) => snapToGrid ? Math.round(value / GRID_SIZE) * GRID_SIZE : value;

    const createCard = async (x: number, y: number) => {
        const snappedX = snapValue((x - viewport.x) / viewport.zoom);
        const snappedY = snapValue((y - viewport.y) / viewport.zoom);
        try {
            const response = await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'createCard', title: 'Neue Karte', x: snappedX, y: snappedY, width: 240, height: 180 }),
            });
            const data = await response.json();
            setCards([...cards, data.card]);
            setSelectedCards(new Set([data.card.id]));
            setEditingCardId(data.card.id);
        } catch (error) {
            console.error('Fehler beim Erstellen:', error);
        }
    };

    const updateCard = useCallback(async (id: string, updates: Partial<CanvasCard>) => {
        setCards(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
        try {
            await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'updateCard', id, updates }),
            });
        } catch (error) {
            console.error('Fehler beim Aktualisieren:', error);
        }
    }, []);

    const deleteCard = async (id: string) => {
        setCards(prev => prev.filter(c => c.id !== id));
        setConnections(prev => prev.filter(c => c.fromId !== id && c.toId !== id));
        try {
            await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'deleteCard', id }),
            });
        } catch (error) {
            console.error('Fehler beim Löschen:', error);
        }
    };

    const createConnection = async (fromId: string, toId: string) => {
        if (fromId === toId) return;
        // Check if connection already exists
        if (connections.some(c => (c.fromId === fromId && c.toId === toId) || (c.fromId === toId && c.toId === fromId))) return;

        try {
            const response = await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'createConnection', fromId, toId, type: connectionType }),
            });
            const data = await response.json();
            setConnections([...connections, data.connection]);
        } catch (error) {
            console.error('Fehler beim Verbinden:', error);
        }
    };

    const updateConnection = async (id: string, updates: Partial<CanvasConnection>) => {
        setConnections(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
        try {
            await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'updateConnection', id, updates }),
            });
        } catch (error) {
            console.error('Fehler beim Aktualisieren:', error);
        }
    };

    const deleteConnection = async (id: string) => {
        setConnections(prev => prev.filter(c => c.id !== id));
        try {
            await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'deleteConnection', id }),
            });
        } catch (error) {
            console.error('Fehler beim Löschen:', error);
        }
    };

    // Mouse handlers
    const handleCardMouseDown = useCallback((e: React.MouseEvent, cardId: string) => {
        e.stopPropagation();

        if (connectionMode === 'connecting') {
            if (connectionStart) {
                createConnection(connectionStart, cardId);
                setConnectionStart(null);
                setPendingConnection(null);
                setConnectionMode('none');
            } else {
                setConnectionStart(cardId);
            }
            return;
        }

        const card = cards.find(c => c.id === cardId);
        if (!card) return;

        const rect = (e.target as HTMLElement).closest(`.${styles.card}`)?.getBoundingClientRect();
        if (!rect) return;

        // Multi-select with shift
        if (e.shiftKey) {
            setSelectedCards(prev => {
                const next = new Set(prev);
                if (next.has(cardId)) next.delete(cardId);
                else next.add(cardId);
                return next;
            });
        } else if (!selectedCards.has(cardId)) {
            setSelectedCards(new Set([cardId]));
        }

        setDragState({ cardId, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top });
    }, [cards, connectionMode, connectionStart, selectedCards, createConnection]);

    const handleResizeMouseDown = useCallback((e: React.MouseEvent, cardId: string, direction: ResizeDirection) => {
        e.stopPropagation();
        const card = cards.find(c => c.id === cardId);
        if (!card) return;
        setResizeState({ cardId, direction, startX: e.clientX, startY: e.clientY, startWidth: card.width, startHeight: card.height });
    }, [cards]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        // Connection drawing
        if (connectionMode === 'connecting' && connectionStart) {
            const canvasRect = canvasRef.current?.getBoundingClientRect();
            if (canvasRect) {
                setPendingConnection({
                    x: (e.clientX - canvasRect.left - viewport.x) / viewport.zoom,
                    y: (e.clientY - canvasRect.top - viewport.y) / viewport.zoom,
                });
            }
        }

        // Resize
        if (resizeState.cardId && resizeState.direction) {
            const deltaX = (e.clientX - resizeState.startX) / viewport.zoom;
            const deltaY = (e.clientY - resizeState.startY) / viewport.zoom;

            let newWidth = resizeState.startWidth;
            let newHeight = resizeState.startHeight;

            if (resizeState.direction.includes('e')) newWidth = Math.max(MIN_CARD_SIZE.width, resizeState.startWidth + deltaX);
            if (resizeState.direction.includes('w')) newWidth = Math.max(MIN_CARD_SIZE.width, resizeState.startWidth - deltaX);
            if (resizeState.direction.includes('s')) newHeight = Math.max(MIN_CARD_SIZE.height, resizeState.startHeight + deltaY);
            if (resizeState.direction.includes('n')) newHeight = Math.max(MIN_CARD_SIZE.height, resizeState.startHeight - deltaY);

            setCards(prev => prev.map(c => c.id === resizeState.cardId ? { ...c, width: snapValue(newWidth), height: snapValue(newHeight) } : c));
            return;
        }

        // Drag
        if (dragState.cardId) {
            const canvasRect = canvasRef.current?.getBoundingClientRect();
            if (!canvasRect) return;

            const newX = snapValue((e.clientX - canvasRect.left - dragState.offsetX - viewport.x) / viewport.zoom);
            const newY = snapValue((e.clientY - canvasRect.top - dragState.offsetY - viewport.y) / viewport.zoom);

            const card = cards.find(c => c.id === dragState.cardId);
            if (!card) return;

            const deltaX = newX - card.x;
            const deltaY = newY - card.y;

            // Move all selected cards
            setCards(prev => prev.map(c => {
                if (c.id === dragState.cardId || selectedCards.has(c.id)) {
                    return { ...c, x: c.x + deltaX, y: c.y + deltaY };
                }
                return c;
            }));
            return;
        }

        // Pan
        if (isPanning) {
            setViewport(prev => ({
                ...prev,
                x: prev.x + (e.clientX - panStart.x),
                y: prev.y + (e.clientY - panStart.y),
            }));
            setPanStart({ x: e.clientX, y: e.clientY });
        }
    }, [dragState, resizeState, cards, isPanning, panStart, viewport, connectionMode, connectionStart, selectedCards, snapValue]);

    const handleMouseUp = useCallback(() => {
        if (dragState.cardId) {
            // Save positions for all moved cards
            cards.filter(c => c.id === dragState.cardId || selectedCards.has(c.id)).forEach(card => {
                updateCard(card.id, { x: card.x, y: card.y });
            });
        }
        if (resizeState.cardId) {
            const card = cards.find(c => c.id === resizeState.cardId);
            if (card) updateCard(card.id, { width: card.width, height: card.height });
        }
        setDragState({ cardId: null, offsetX: 0, offsetY: 0 });
        setResizeState({ cardId: null, direction: null, startX: 0, startY: 0, startWidth: 0, startHeight: 0 });
        setIsPanning(false);
    }, [dragState, resizeState, cards, selectedCards, updateCard]);

    const handleCanvasMouseDown = (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest(`.${styles.card}`)) return;
        if ((e.target as HTMLElement).closest(`.${styles.connectionLine}`)) return;

        setSelectedCards(new Set());
        setEditingCardId(null);
        setEditingConnectionId(null);

        if (connectionMode === 'connecting') {
            setConnectionStart(null);
            setPendingConnection(null);
        } else {
            setIsPanning(true);
            setPanStart({ x: e.clientX, y: e.clientY });
        }
    };

    const handleDoubleClick = (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest(`.${styles.card}`)) return;
        const rect = canvasRef.current?.getBoundingClientRect();
        if (rect) createCard(e.clientX - rect.left, e.clientY - rect.top);
    };

    const handleWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        setViewport(prev => ({ ...prev, zoom: Math.min(Math.max(prev.zoom * delta, 0.25), 3) }));
    };

    // Render connection with arrow
    const renderConnection = useCallback((conn: CanvasConnection) => {
        const from = cards.find(c => c.id === conn.fromId);
        const to = cards.find(c => c.id === conn.toId);
        if (!from || !to) return null;

        const x1 = from.x + from.width / 2;
        const y1 = from.y + from.height / 2;
        const x2 = to.x + to.width / 2;
        const y2 = to.y + to.height / 2;
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;

        // Calculate arrow angle
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const arrowLength = 12;
        const arrowAngle = Math.PI / 6;

        const isSelected = editingConnectionId === conn.id;

        return (
            <g key={conn.id} className={styles.connectionGroup}>
                {/* Clickable area */}
                <line
                    x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke="transparent"
                    strokeWidth={20}
                    className={styles.connectionHitArea}
                    onClick={() => setEditingConnectionId(conn.id)}
                />

                {/* Main line */}
                <line
                    x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke={isSelected ? 'var(--color-primary)' : 'var(--color-text-tertiary)'}
                    strokeWidth={isSelected ? 3 : 2}
                    strokeDasharray={conn.type === 'simple' ? '5,5' : 'none'}
                    className={styles.connectionLine}
                />

                {/* Arrows */}
                {(conn.type === 'directional' || conn.type === 'bidirectional') && (
                    <polygon
                        points={`
              ${x2 - arrowLength * Math.cos(angle - arrowAngle)},${y2 - arrowLength * Math.sin(angle - arrowAngle)}
              ${x2},${y2}
              ${x2 - arrowLength * Math.cos(angle + arrowAngle)},${y2 - arrowLength * Math.sin(angle + arrowAngle)}
            `}
                        fill={isSelected ? 'var(--color-primary)' : 'var(--color-text-tertiary)'}
                    />
                )}
                {conn.type === 'bidirectional' && (
                    <polygon
                        points={`
              ${x1 + arrowLength * Math.cos(angle - arrowAngle)},${y1 + arrowLength * Math.sin(angle - arrowAngle)}
              ${x1},${y1}
              ${x1 + arrowLength * Math.cos(angle + arrowAngle)},${y1 + arrowLength * Math.sin(angle + arrowAngle)}
            `}
                        fill={isSelected ? 'var(--color-primary)' : 'var(--color-text-tertiary)'}
                    />
                )}

                {/* Label */}
                {conn.label && (
                    <text
                        x={midX}
                        y={midY - 8}
                        textAnchor="middle"
                        fill="var(--color-text-secondary)"
                        fontSize="12"
                        className={styles.connectionLabel}
                    >
                        {conn.label}
                    </text>
                )}
            </g>
        );
    }, [cards, editingConnectionId]);

    // Pending connection line
    const renderPendingConnection = useMemo(() => {
        if (!connectionStart || !pendingConnection) return null;
        const from = cards.find(c => c.id === connectionStart);
        if (!from) return null;

        const x1 = from.x + from.width / 2;
        const y1 = from.y + from.height / 2;

        return (
            <line
                x1={x1}
                y1={y1}
                x2={pendingConnection.x}
                y2={pendingConnection.y}
                stroke="var(--color-primary)"
                strokeWidth={2}
                strokeDasharray="5,5"
            />
        );
    }, [connectionStart, pendingConnection, cards]);

    // Minimap
    const minimapScale = 0.05;
    const minimapBounds = useMemo(() => {
        if (cards.length === 0) return { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
        const xs = cards.flatMap(c => [c.x, c.x + c.width]);
        const ys = cards.flatMap(c => [c.y, c.y + c.height]);
        return {
            minX: Math.min(...xs) - 100,
            minY: Math.min(...ys) - 100,
            maxX: Math.max(...xs) + 100,
            maxY: Math.max(...ys) + 100,
        };
    }, [cards]);

    return (
        <AppShell title="Canvas">
            <div className={styles.container}>
                {/* Toolbar */}
                <div className={styles.toolbar}>
                    <div className={styles.toolGroup}>
                        <IconButton
                            icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>}
                            onClick={() => router.push('/')}
                            label="Zurück"
                        />
                        <div className={styles.divider} />
                        <Button variant={connectionMode === 'none' ? 'ghost' : 'primary'} size="sm" onClick={() => {
                            if (connectionMode === 'connecting') {
                                setConnectionMode('none');
                                setConnectionStart(null);
                                setPendingConnection(null);
                            } else {
                                setConnectionMode('connecting');
                            }
                        }}>
                            {connectionMode === 'connecting' ? '✓ Verbinden' : '🔗 Verbinden'}
                        </Button>
                        {connectionMode === 'connecting' && (
                            <select
                                className={styles.select}
                                value={connectionType}
                                onChange={(e) => setConnectionType(e.target.value as CanvasConnection['type'])}
                            >
                                <option value="directional">→ Gerichtet</option>
                                <option value="bidirectional">↔ Bidirektional</option>
                                <option value="simple">— Einfach</option>
                            </select>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => {
                            const rect = canvasRef.current?.getBoundingClientRect();
                            if (rect) createCard(rect.width / 2, rect.height / 2);
                        }}>+ Karte</Button>
                    </div>

                    <div className={styles.toolGroup}>
                        <Button variant={snapToGrid ? 'secondary' : 'ghost'} size="sm" onClick={() => setSnapToGrid(!snapToGrid)}>
                            ⊞ Raster
                        </Button>
                        <div className={styles.divider} />
                        <Button variant="ghost" size="sm" onClick={() => setViewport(prev => ({ ...prev, zoom: Math.max(prev.zoom * 0.8, 0.25) }))}>−</Button>
                        <span className={styles.zoomLevel}>{Math.round(viewport.zoom * 100)}%</span>
                        <Button variant="ghost" size="sm" onClick={() => setViewport(prev => ({ ...prev, zoom: Math.min(prev.zoom * 1.2, 3) }))}>+</Button>
                        <Button variant="ghost" size="sm" onClick={() => setViewport({ x: 0, y: 0, zoom: 1 })}>Reset</Button>
                    </div>
                </div>

                {/* Connection editor */}
                {editingConnectionId && (
                    <div className={styles.connectionEditor}>
                        <input
                            type="text"
                            placeholder="Label..."
                            value={connections.find(c => c.id === editingConnectionId)?.label || ''}
                            onChange={(e) => updateConnection(editingConnectionId, { label: e.target.value })}
                            className={styles.connectionLabelInput}
                        />
                        <select
                            value={connections.find(c => c.id === editingConnectionId)?.type || 'directional'}
                            onChange={(e) => updateConnection(editingConnectionId, { type: e.target.value as CanvasConnection['type'] })}
                            className={styles.select}
                        >
                            <option value="directional">→ Gerichtet</option>
                            <option value="bidirectional">↔ Bidirektional</option>
                            <option value="simple">— Einfach</option>
                        </select>
                        <Button variant="ghost" size="sm" onClick={() => deleteConnection(editingConnectionId)}>Löschen</Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditingConnectionId(null)}>✕</Button>
                    </div>
                )}

                {/* Canvas */}
                <div
                    ref={canvasRef}
                    className={`${styles.canvas} ${connectionMode === 'connecting' ? styles.connectingMode : ''}`}
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
                        {/* Connections */}
                        <svg className={styles.connections}>
                            {connections.map(renderConnection)}
                            {renderPendingConnection}
                        </svg>

                        {/* Cards */}
                        {cards.map(card => (
                            <div
                                key={card.id}
                                className={`${styles.card} ${selectedCards.has(card.id) ? styles.selected : ''} ${connectionMode === 'connecting' ? styles.connectable : ''}`}
                                style={{
                                    left: card.x,
                                    top: card.y,
                                    width: card.width,
                                    height: card.height,
                                    borderColor: card.color || 'var(--color-border)',
                                }}
                                onMouseDown={(e) => handleCardMouseDown(e, card.id)}
                                onDoubleClick={(e) => { e.stopPropagation(); setEditingCardId(card.id); }}
                            >
                                <div className={styles.cardHeader} style={{ backgroundColor: card.color ? `${card.color}20` : undefined }}>
                                    {editingCardId === card.id ? (
                                        <input
                                            className={styles.cardTitleInput}
                                            value={card.title}
                                            onChange={(e) => updateCard(card.id, { title: e.target.value })}
                                            onBlur={() => setEditingCardId(null)}
                                            onKeyDown={(e) => e.key === 'Enter' && setEditingCardId(null)}
                                            onMouseDown={(e) => e.stopPropagation()}
                                            autoFocus
                                        />
                                    ) : (
                                        <span className={styles.cardTitle}>{card.title}</span>
                                    )}
                                    <button className={styles.cardDelete} onClick={() => deleteCard(card.id)} onMouseDown={(e) => e.stopPropagation()}>×</button>
                                </div>

                                <div className={styles.cardBody}>
                                    {editingCardId === card.id ? (
                                        <textarea
                                            className={styles.cardContentEdit}
                                            value={card.content || ''}
                                            onChange={(e) => updateCard(card.id, { content: e.target.value })}
                                            onMouseDown={(e) => e.stopPropagation()}
                                            placeholder="Markdown schreiben..."
                                        />
                                    ) : (
                                        <div
                                            className={styles.cardContent}
                                            dangerouslySetInnerHTML={{ __html: parseMarkdown(card.content || '') }}
                                        />
                                    )}
                                </div>

                                <div className={styles.cardFooter}>
                                    {CARD_COLORS.map(color => (
                                        <button
                                            key={color}
                                            className={`${styles.colorDot} ${card.color === color ? styles.colorActive : ''}`}
                                            style={{ backgroundColor: color }}
                                            onClick={() => updateCard(card.id, { color })}
                                            onMouseDown={(e) => e.stopPropagation()}
                                        />
                                    ))}
                                </div>

                                {/* Resize handles */}
                                <div className={`${styles.resizeHandle} ${styles.resizeSE}`} onMouseDown={(e) => handleResizeMouseDown(e, card.id, 'se')} />
                                <div className={`${styles.resizeHandle} ${styles.resizeSW}`} onMouseDown={(e) => handleResizeMouseDown(e, card.id, 'sw')} />
                                <div className={`${styles.resizeHandle} ${styles.resizeNE}`} onMouseDown={(e) => handleResizeMouseDown(e, card.id, 'ne')} />
                                <div className={`${styles.resizeHandle} ${styles.resizeNW}`} onMouseDown={(e) => handleResizeMouseDown(e, card.id, 'nw')} />
                                <div className={`${styles.resizeHandle} ${styles.resizeE}`} onMouseDown={(e) => handleResizeMouseDown(e, card.id, 'e')} />
                                <div className={`${styles.resizeHandle} ${styles.resizeW}`} onMouseDown={(e) => handleResizeMouseDown(e, card.id, 'w')} />
                                <div className={`${styles.resizeHandle} ${styles.resizeN}`} onMouseDown={(e) => handleResizeMouseDown(e, card.id, 'n')} />
                                <div className={`${styles.resizeHandle} ${styles.resizeS}`} onMouseDown={(e) => handleResizeMouseDown(e, card.id, 's')} />
                            </div>
                        ))}
                    </div>

                    {/* Empty state */}
                    {cards.length === 0 && (
                        <div className={styles.emptyState}>
                            <h3>Leeres Canvas</h3>
                            <p>Doppelklicke, um eine Karte zu erstellen</p>
                        </div>
                    )}

                    {/* Minimap */}
                    <div className={styles.minimap}>
                        <svg width="100%" height="100%" viewBox={`${minimapBounds.minX} ${minimapBounds.minY} ${minimapBounds.maxX - minimapBounds.minX} ${minimapBounds.maxY - minimapBounds.minY}`}>
                            {cards.map(card => (
                                <rect
                                    key={card.id}
                                    x={card.x}
                                    y={card.y}
                                    width={card.width}
                                    height={card.height}
                                    fill={card.color || 'var(--color-primary)'}
                                    opacity={0.6}
                                />
                            ))}
                            {/* Viewport indicator */}
                            <rect
                                x={-viewport.x / viewport.zoom}
                                y={-viewport.y / viewport.zoom}
                                width={(canvasRef.current?.clientWidth || 800) / viewport.zoom}
                                height={(canvasRef.current?.clientHeight || 600) / viewport.zoom}
                                fill="none"
                                stroke="var(--color-primary)"
                                strokeWidth={4 / minimapScale}
                            />
                        </svg>
                    </div>
                </div>

                {/* Help */}
                <div className={styles.help}>
                    <span>Doppelklick: Neue Karte</span>
                    <span>Shift+Klick: Mehrfachauswahl</span>
                    <span>Delete: Löschen</span>
                    <span>Esc: Abbrechen</span>
                    <span>⌘G: Raster an/aus</span>
                </div>
            </div>
        </AppShell>
    );
}
