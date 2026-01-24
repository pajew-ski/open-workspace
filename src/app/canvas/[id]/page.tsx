'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { AppShell } from '@/components/layout';
import { Button, IconButton, ConfirmDialog, useToast } from '@/components/ui';
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

interface CanvasData {
    id: string;
    name: string;
    description?: string;
    cards: CanvasCard[];
    connections: CanvasConnection[];
    viewport: { x: number; y: number; zoom: number };
}

type ConnectionMode = 'none' | 'connecting';
type ResizeDirection = 'se' | 'sw' | 'ne' | 'nw' | 'e' | 'w' | 'n' | 's' | null;

const CARD_COLORS = ['#00674F', '#2563eb', '#7c3aed', '#dc2626', '#ea580c', '#65a30d'];
const MIN_CARD_SIZE = { width: 150, height: 100 };
const GRID_SIZE = 20;

function parseMarkdown(md: string): string {
    if (!md) return '';
    return md
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/^### (.+)$/gm, '<h4>$1</h4>')
        .replace(/^## (.+)$/gm, '<h3>$1</h3>')
        .replace(/^# (.+)$/gm, '<h2>$1</h2>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^- (.+)$/gm, '• $1')
        .replace(/\n/g, '<br />');
}

export default function CanvasEditorPage() {
    const router = useRouter();
    const params = useParams();
    const canvasId = params.id as string;
    const toast = useToast();

    const [canvas, setCanvas] = useState<CanvasData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [cards, setCards] = useState<CanvasCard[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
    const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });

    const [dragState, setDragState] = useState<{ cardId: string | null; offsetX: number; offsetY: number }>({ cardId: null, offsetX: 0, offsetY: 0 });
    const [resizeState, setResizeState] = useState<{ cardId: string | null; direction: ResizeDirection; startX: number; startY: number; startWidth: number; startHeight: number }>({ cardId: null, direction: null, startX: 0, startY: 0, startWidth: 0, startHeight: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const [panStart, setPanStart] = useState({ x: 0, y: 0 });

    const [connectionMode, setConnectionMode] = useState<ConnectionMode>('none');
    const [connectionStart, setConnectionStart] = useState<string | null>(null);
    const [connectionType, setConnectionType] = useState<CanvasConnection['type']>('directional');
    const [pendingConnection, setPendingConnection] = useState<{ x: number; y: number } | null>(null);

    const [editingCardId, setEditingCardId] = useState<string | null>(null);
    const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
    const [snapToGrid, setSnapToGrid] = useState(true);

    const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'card' | 'connection'; id: string; title: string } | null>(null);

    const canvasRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (canvasId) fetchCanvas();
    }, [canvasId]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (editingCardId || editingConnectionId) return;
                if (selectedCards.size > 0) {
                    const first = Array.from(selectedCards)[0];
                    const card = cards.find(c => c.id === first);
                    setDeleteConfirm({ type: 'card', id: first, title: card?.title || 'Karte' });
                }
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
            const response = await fetch(`/api/canvas?id=${canvasId}`);
            if (!response.ok) {
                router.push('/canvas');
                return;
            }
            const data = await response.json();
            setCanvas(data);
            setCards(data.cards || []);
            setConnections(data.connections || []);
            if (data.viewport) setViewport(data.viewport);
        } catch (error) {
            console.error('Fehler beim Laden:', error);
            router.push('/canvas');
        } finally {
            setIsLoading(false);
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
                body: JSON.stringify({ action: 'createCard', canvasId, title: 'Neue Karte', x: snappedX, y: snappedY, width: 240, height: 180 }),
            });
            const data = await response.json();
            setCards([...cards, data.card]);
            setSelectedCards(new Set([data.card.id]));
            setEditingCardId(data.card.id);
            toast.success('Karte erstellt');
        } catch (error) {
            toast.error('Fehler beim Erstellen');
        }
    };

    const updateCard = useCallback(async (cardId: string, updates: Partial<CanvasCard>, showToast = false) => {
        const oldCard = cards.find(c => c.id === cardId);
        setCards(prev => prev.map(c => c.id === cardId ? { ...c, ...updates } : c));

        try {
            await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'updateCard', canvasId, cardId, updates }),
            });
            if (showToast && oldCard) {
                toast.success('Gespeichert', () => {
                    // Undo
                    setCards(prev => prev.map(c => c.id === cardId ? oldCard : c));
                    fetch('/api/canvas', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'updateCard', canvasId, cardId, updates: oldCard }),
                    });
                });
            }
        } catch (error) {
            toast.error('Fehler beim Speichern');
        }
    }, [canvasId, cards, toast]);

    const confirmDeleteCard = async () => {
        if (!deleteConfirm || deleteConfirm.type !== 'card') return;
        const cardId = deleteConfirm.id;
        const oldCard = cards.find(c => c.id === cardId);
        const oldConnections = connections.filter(c => c.fromId === cardId || c.toId === cardId);

        setCards(prev => prev.filter(c => c.id !== cardId));
        setConnections(prev => prev.filter(c => c.fromId !== cardId && c.toId !== cardId));
        setSelectedCards(new Set());
        setDeleteConfirm(null);

        try {
            await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'deleteCard', canvasId, cardId }),
            });
            toast.success('Karte gelöscht', () => {
                // Undo: Recreate card and connections
                if (oldCard) {
                    setCards(prev => [...prev, oldCard]);
                    setConnections(prev => [...prev, ...oldConnections]);
                    // Note: Server-side undo would need proper implementation
                }
            });
        } catch (error) {
            toast.error('Fehler beim Löschen');
        }
    };

    const createConnection = async (fromId: string, toId: string) => {
        if (fromId === toId) return;
        if (connections.some(c => (c.fromId === fromId && c.toId === toId) || (c.fromId === toId && c.toId === fromId))) return;

        try {
            const response = await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'createConnection', canvasId, fromId, toId, type: connectionType }),
            });
            const data = await response.json();
            setConnections([...connections, data.connection]);
            toast.success('Verbindung erstellt');
        } catch (error) {
            toast.error('Fehler beim Verbinden');
        }
    };

    const updateConnection = async (connectionId: string, updates: Partial<CanvasConnection>) => {
        setConnections(prev => prev.map(c => c.id === connectionId ? { ...c, ...updates } : c));
        try {
            await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'updateConnection', canvasId, connectionId, updates }),
            });
        } catch (error) {
            toast.error('Fehler beim Aktualisieren');
        }
    };

    const confirmDeleteConnection = async () => {
        if (!deleteConfirm || deleteConfirm.type !== 'connection') return;
        const connectionId = deleteConfirm.id;
        const oldConnection = connections.find(c => c.id === connectionId);

        setConnections(prev => prev.filter(c => c.id !== connectionId));
        setEditingConnectionId(null);
        setDeleteConfirm(null);

        try {
            await fetch('/api/canvas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'deleteConnection', canvasId, connectionId }),
            });
            toast.success('Verbindung gelöscht', () => {
                if (oldConnection) setConnections(prev => [...prev, oldConnection]);
            });
        } catch (error) {
            toast.error('Fehler beim Löschen');
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
        if (e.shiftKey) {
            setSelectedCards(prev => { const next = new Set(prev); if (next.has(cardId)) next.delete(cardId); else next.add(cardId); return next; });
        } else if (!selectedCards.has(cardId)) {
            setSelectedCards(new Set([cardId]));
        }
        setDragState({ cardId, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top });
    }, [cards, connectionMode, connectionStart, selectedCards]);

    const handleResizeMouseDown = useCallback((e: React.MouseEvent, cardId: string, direction: ResizeDirection) => {
        e.stopPropagation();
        const card = cards.find(c => c.id === cardId);
        if (!card) return;
        setResizeState({ cardId, direction, startX: e.clientX, startY: e.clientY, startWidth: card.width, startHeight: card.height });
    }, [cards]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (connectionMode === 'connecting' && connectionStart) {
            const canvasRect = canvasRef.current?.getBoundingClientRect();
            if (canvasRect) {
                setPendingConnection({ x: (e.clientX - canvasRect.left - viewport.x) / viewport.zoom, y: (e.clientY - canvasRect.top - viewport.y) / viewport.zoom });
            }
        }
        if (resizeState.cardId && resizeState.direction) {
            const deltaX = (e.clientX - resizeState.startX) / viewport.zoom;
            const deltaY = (e.clientY - resizeState.startY) / viewport.zoom;
            let newWidth = resizeState.startWidth, newHeight = resizeState.startHeight;
            if (resizeState.direction.includes('e')) newWidth = Math.max(MIN_CARD_SIZE.width, resizeState.startWidth + deltaX);
            if (resizeState.direction.includes('w')) newWidth = Math.max(MIN_CARD_SIZE.width, resizeState.startWidth - deltaX);
            if (resizeState.direction.includes('s')) newHeight = Math.max(MIN_CARD_SIZE.height, resizeState.startHeight + deltaY);
            if (resizeState.direction.includes('n')) newHeight = Math.max(MIN_CARD_SIZE.height, resizeState.startHeight - deltaY);
            setCards(prev => prev.map(c => c.id === resizeState.cardId ? { ...c, width: snapValue(newWidth), height: snapValue(newHeight) } : c));
            return;
        }
        if (dragState.cardId) {
            const canvasRect = canvasRef.current?.getBoundingClientRect();
            if (!canvasRect) return;
            const newX = snapValue((e.clientX - canvasRect.left - dragState.offsetX - viewport.x) / viewport.zoom);
            const newY = snapValue((e.clientY - canvasRect.top - dragState.offsetY - viewport.y) / viewport.zoom);
            const card = cards.find(c => c.id === dragState.cardId);
            if (!card) return;
            const deltaX = newX - card.x, deltaY = newY - card.y;
            setCards(prev => prev.map(c => (c.id === dragState.cardId || selectedCards.has(c.id)) ? { ...c, x: c.x + deltaX, y: c.y + deltaY } : c));
            return;
        }
        if (isPanning) {
            setViewport(prev => ({ ...prev, x: prev.x + (e.clientX - panStart.x), y: prev.y + (e.clientY - panStart.y) }));
            setPanStart({ x: e.clientX, y: e.clientY });
        }
    }, [dragState, resizeState, cards, isPanning, panStart, viewport, connectionMode, connectionStart, selectedCards, snapValue]);

    const handleMouseUp = useCallback(() => {
        if (dragState.cardId) {
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
        if (connectionMode === 'connecting') { setConnectionStart(null); setPendingConnection(null); }
        else { setIsPanning(true); setPanStart({ x: e.clientX, y: e.clientY }); }
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

    const renderConnection = useCallback((conn: CanvasConnection) => {
        const from = cards.find(c => c.id === conn.fromId);
        const to = cards.find(c => c.id === conn.toId);
        if (!from || !to) return null;

        // Calculate center points
        const fromCenterX = from.x + from.width / 2;
        const fromCenterY = from.y + from.height / 2;
        const toCenterX = to.x + to.width / 2;
        const toCenterY = to.y + to.height / 2;

        // Calculate angle between centers
        const angle = Math.atan2(toCenterY - fromCenterY, toCenterX - fromCenterX);

        // Calculate edge intersection points
        const getEdgePoint = (card: CanvasCard, angleToOther: number): { x: number; y: number } => {
            const cx = card.x + card.width / 2;
            const cy = card.y + card.height / 2;
            const hw = card.width / 2;
            const hh = card.height / 2;

            // Check which edge the line intersects
            const tanAngle = Math.tan(angleToOther);
            let edgeX, edgeY;

            // Right or left edge
            if (Math.abs(Math.cos(angleToOther)) * hh > Math.abs(Math.sin(angleToOther)) * hw) {
                // Intersects left or right edge
                edgeX = cx + (Math.cos(angleToOther) > 0 ? hw : -hw);
                edgeY = cy + (Math.cos(angleToOther) > 0 ? hw : -hw) * tanAngle;
            } else {
                // Intersects top or bottom edge
                const cotAngle = 1 / tanAngle;
                edgeY = cy + (Math.sin(angleToOther) > 0 ? hh : -hh);
                edgeX = cx + (Math.sin(angleToOther) > 0 ? hh : -hh) * cotAngle;
            }

            return { x: edgeX, y: edgeY };
        };

        const fromEdge = getEdgePoint(from, angle);
        const toEdge = getEdgePoint(to, angle + Math.PI);

        const x1 = fromEdge.x, y1 = fromEdge.y;
        const x2 = toEdge.x, y2 = toEdge.y;
        const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;

        const arrowLength = 12, arrowAngle = Math.PI / 6;
        const isSelected = editingConnectionId === conn.id;

        return (
            <g key={conn.id} className={styles.connectionGroup}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={20} className={styles.connectionHitArea} onClick={() => setEditingConnectionId(conn.id)} />
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={isSelected ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} strokeWidth={isSelected ? 3 : 2} strokeDasharray={conn.type === 'simple' ? '5,5' : 'none'} className={styles.connectionLine} />
                {(conn.type === 'directional' || conn.type === 'bidirectional') && (
                    <polygon points={`${x2 - arrowLength * Math.cos(angle - arrowAngle)},${y2 - arrowLength * Math.sin(angle - arrowAngle)} ${x2},${y2} ${x2 - arrowLength * Math.cos(angle + arrowAngle)},${y2 - arrowLength * Math.sin(angle + arrowAngle)}`} fill={isSelected ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                )}
                {conn.type === 'bidirectional' && (
                    <polygon points={`${x1 + arrowLength * Math.cos(angle - arrowAngle)},${y1 + arrowLength * Math.sin(angle - arrowAngle)} ${x1},${y1} ${x1 + arrowLength * Math.cos(angle + arrowAngle)},${y1 + arrowLength * Math.sin(angle + arrowAngle)}`} fill={isSelected ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                )}
                {conn.label && <text x={midX} y={midY - 8} textAnchor="middle" fill="var(--color-text-secondary)" fontSize="12" className={styles.connectionLabel}>{conn.label}</text>}
            </g>
        );
    }, [cards, editingConnectionId]);

    const renderPendingConnection = useMemo(() => {
        if (!connectionStart || !pendingConnection) return null;
        const from = cards.find(c => c.id === connectionStart);
        if (!from) return null;
        return <line x1={from.x + from.width / 2} y1={from.y + from.height / 2} x2={pendingConnection.x} y2={pendingConnection.y} stroke="var(--color-primary)" strokeWidth={2} strokeDasharray="5,5" />;
    }, [connectionStart, pendingConnection, cards]);

    const minimapBounds = useMemo(() => {
        if (cards.length === 0) return { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
        const xs = cards.flatMap(c => [c.x, c.x + c.width]);
        const ys = cards.flatMap(c => [c.y, c.y + c.height]);
        return { minX: Math.min(...xs) - 100, minY: Math.min(...ys) - 100, maxX: Math.max(...xs) + 100, maxY: Math.max(...ys) + 100 };
    }, [cards]);

    if (isLoading) return <AppShell title="Canvas"><p>Laden...</p></AppShell>;
    if (!canvas) return <AppShell title="Canvas"><p>Canvas nicht gefunden</p></AppShell>;

    return (
        <AppShell title={canvas.name}>
            <div className={styles.container}>
                <div className={styles.toolbar}>
                    <div className={styles.toolGroup}>
                        <IconButton icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>} onClick={() => router.push('/canvas')} label="Zurück zur Übersicht" />
                        <div className={styles.divider} />
                        <Button variant={connectionMode === 'none' ? 'ghost' : 'primary'} size="sm" onClick={() => { if (connectionMode === 'connecting') { setConnectionMode('none'); setConnectionStart(null); setPendingConnection(null); } else { setConnectionMode('connecting'); } }}>
                            {connectionMode === 'connecting' ? '✓ Verbinden' : '🔗 Verbinden'}
                        </Button>
                        {connectionMode === 'connecting' && (
                            <select className={styles.select} value={connectionType} onChange={(e) => setConnectionType(e.target.value as CanvasConnection['type'])}>
                                <option value="directional">→ Gerichtet</option>
                                <option value="bidirectional">↔ Bidirektional</option>
                                <option value="simple">— Einfach</option>
                            </select>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => { const rect = canvasRef.current?.getBoundingClientRect(); if (rect) createCard(rect.width / 2, rect.height / 2); }}>+ Karte</Button>
                    </div>
                    <div className={styles.toolGroup}>
                        <Button variant={snapToGrid ? 'secondary' : 'ghost'} size="sm" onClick={() => setSnapToGrid(!snapToGrid)}>⊞ Raster</Button>
                        <div className={styles.divider} />
                        <Button variant="ghost" size="sm" onClick={() => setViewport(prev => ({ ...prev, zoom: Math.max(prev.zoom * 0.8, 0.25) }))}>−</Button>
                        <span className={styles.zoomLevel}>{Math.round(viewport.zoom * 100)}%</span>
                        <Button variant="ghost" size="sm" onClick={() => setViewport(prev => ({ ...prev, zoom: Math.min(prev.zoom * 1.2, 3) }))}>+</Button>
                        <Button variant="ghost" size="sm" onClick={() => setViewport({ x: 0, y: 0, zoom: 1 })}>Reset</Button>
                    </div>
                </div>

                {editingConnectionId && (
                    <div className={styles.connectionEditor}>
                        <input type="text" placeholder="Label..." value={connections.find(c => c.id === editingConnectionId)?.label || ''} onChange={(e) => updateConnection(editingConnectionId, { label: e.target.value })} className={styles.connectionLabelInput} />
                        <select value={connections.find(c => c.id === editingConnectionId)?.type || 'directional'} onChange={(e) => updateConnection(editingConnectionId, { type: e.target.value as CanvasConnection['type'] })} className={styles.select}>
                            <option value="directional">→ Gerichtet</option>
                            <option value="bidirectional">↔ Bidirektional</option>
                            <option value="simple">— Einfach</option>
                        </select>
                        <Button variant="ghost" size="sm" onClick={() => setDeleteConfirm({ type: 'connection', id: editingConnectionId, title: 'diese Verbindung' })}>Löschen</Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditingConnectionId(null)}>✕</Button>
                    </div>
                )}

                <div ref={canvasRef} className={`${styles.canvas} ${connectionMode === 'connecting' ? styles.connectingMode : ''}`} onMouseDown={handleCanvasMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} onDoubleClick={handleDoubleClick} onWheel={handleWheel}>
                    <div className={styles.grid} style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`, transformOrigin: '0 0' }}>
                        <svg className={styles.connections}>{connections.map(renderConnection)}{renderPendingConnection}</svg>
                        {cards.map(card => (
                            <div key={card.id} className={`${styles.card} ${selectedCards.has(card.id) ? styles.selected : ''} ${connectionMode === 'connecting' ? styles.connectable : ''}`} style={{ left: card.x, top: card.y, width: card.width, height: card.height, borderColor: card.color || 'var(--color-border)' }} onMouseDown={(e) => handleCardMouseDown(e, card.id)} onDoubleClick={(e) => { e.stopPropagation(); setEditingCardId(card.id); }}>
                                <div className={styles.cardHeader} style={{ backgroundColor: card.color ? `${card.color}20` : undefined }}>
                                    {editingCardId === card.id ? (
                                        <input className={styles.cardTitleInput} value={card.title} onChange={(e) => updateCard(card.id, { title: e.target.value })} onBlur={() => { updateCard(card.id, { title: card.title }, true); setEditingCardId(null); }} onKeyDown={(e) => e.key === 'Enter' && setEditingCardId(null)} onMouseDown={(e) => e.stopPropagation()} autoFocus />
                                    ) : (
                                        <span className={styles.cardTitle}>{card.title}</span>
                                    )}
                                    <button className={styles.cardDelete} onClick={() => setDeleteConfirm({ type: 'card', id: card.id, title: card.title })} onMouseDown={(e) => e.stopPropagation()}>×</button>
                                </div>
                                <div className={styles.cardBody}>
                                    {editingCardId === card.id ? (
                                        <textarea className={styles.cardContentEdit} value={card.content || ''} onChange={(e) => updateCard(card.id, { content: e.target.value })} onBlur={() => updateCard(card.id, { content: card.content }, true)} onMouseDown={(e) => e.stopPropagation()} placeholder="Markdown schreiben..." />
                                    ) : (
                                        <div className={styles.cardContent} dangerouslySetInnerHTML={{ __html: parseMarkdown(card.content || '') }} />
                                    )}
                                </div>
                                <div className={styles.cardFooter}>
                                    {CARD_COLORS.map(color => (
                                        <button key={color} className={`${styles.colorDot} ${card.color === color ? styles.colorActive : ''}`} style={{ backgroundColor: color }} onClick={() => updateCard(card.id, { color })} onMouseDown={(e) => e.stopPropagation()} />
                                    ))}
                                </div>
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
                    {cards.length === 0 && <div className={styles.emptyState}><h3>Leeres Canvas</h3><p>Doppelklicke, um eine Karte zu erstellen</p></div>}
                    <div className={styles.minimap}>
                        <svg width="100%" height="100%" viewBox={`${minimapBounds.minX} ${minimapBounds.minY} ${minimapBounds.maxX - minimapBounds.minX} ${minimapBounds.maxY - minimapBounds.minY}`}>
                            {cards.map(card => <rect key={card.id} x={card.x} y={card.y} width={card.width} height={card.height} fill={card.color || 'var(--color-primary)'} opacity={0.6} />)}
                            <rect x={-viewport.x / viewport.zoom} y={-viewport.y / viewport.zoom} width={(canvasRef.current?.clientWidth || 800) / viewport.zoom} height={(canvasRef.current?.clientHeight || 600) / viewport.zoom} fill="none" stroke="var(--color-primary)" strokeWidth={4} />
                        </svg>
                    </div>
                </div>
                <div className={styles.help}><span>Doppelklick: Neue Karte</span><span>Shift+Klick: Mehrfachauswahl</span><span>Delete: Löschen</span><span>Esc: Abbrechen</span><span>⌘G: Raster an/aus</span></div>
            </div>

            <ConfirmDialog
                isOpen={deleteConfirm !== null}
                title={deleteConfirm?.type === 'card' ? 'Karte löschen?' : 'Verbindung löschen?'}
                message={`Möchtest du "${deleteConfirm?.title}" wirklich löschen?`}
                confirmText="Löschen"
                cancelText="Abbrechen"
                variant="danger"
                onConfirm={() => deleteConfirm?.type === 'card' ? confirmDeleteCard() : confirmDeleteConnection()}
                onCancel={() => setDeleteConfirm(null)}
            />
        </AppShell>
    );
}
