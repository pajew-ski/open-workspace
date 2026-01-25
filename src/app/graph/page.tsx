'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { AppShell } from '@/components/layout';
import { Card, CardContent, Button, FloatingActionButton } from '@/components/ui';
import { Settings2, X, RotateCcw } from 'lucide-react';
import styles from './page.module.css';
import { Graph } from 'schema-dts';

// Dynamically import ForceGraph to avoid SSR issues with Canvas
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

interface GraphNode {
    id: string;
    name: string;
    val: number;
    type: string;
    color: string;
    group?: number;
}

interface GraphLink {
    source: string;
    target: string;
    type: string; // Predicate label
}

// Default Constants
const DEFAULTS = {
    showDocs: true,
    showTasks: true,
    showProjects: true,
    showCanvas: true,
    showTags: false,
    showDependencies: true,
    showPredicates: false,
    showNames: false,
    forceCharge: -100,
    linkDistance: 60,
    settingsOpen: false // Default to closed as requested
};

export default function GraphExplorerPage() {
    // --- State: Data ---
    const [graphData, setGraphData] = useState<{ nodes: GraphNode[], links: GraphLink[] }>({ nodes: [], links: [] });
    const [isLoading, setIsLoading] = useState(true);

    // --- State: UI Controls (Persistent) ---
    // Initialize state lazily from localStorage to avoid hydration mismatch, or use effect for client-side only
    const [isClient, setIsClient] = useState(false);

    useEffect(() => {
        setIsClient(true);
    }, []);

    // Helper for persistent state
    const usePersistentState = <T,>(key: string, defaultValue: T): [T, (value: T) => void] => {
        const [state, setState] = useState<T>(() => {
            if (typeof window !== 'undefined') {
                const saved = localStorage.getItem(`graph-${key}`);
                if (saved !== null) {
                    try {
                        return JSON.parse(saved);
                    } catch { return defaultValue; }
                }
            }
            return defaultValue;
        });

        useEffect(() => {
            localStorage.setItem(`graph-${key}`, JSON.stringify(state));
        }, [key, state]);

        return [state, setState];
    };

    const [settingsOpen, setSettingsOpen] = useState(DEFAULTS.settingsOpen);
    const [settingsPos, setSettingsPos] = useState({ x: 20, y: 80 });

    // --- Resize Logic ---
    const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

    useEffect(() => {
        // Set initial dimensions
        setDimensions({ width: window.innerWidth, height: window.innerHeight });

        const handleResize = () => {
            setDimensions({ width: window.innerWidth, height: window.innerHeight });
        };

        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Filters
    const [showDocs, setShowDocs] = usePersistentState('showDocs', DEFAULTS.showDocs);
    const [showTasks, setShowTasks] = usePersistentState('showTasks', DEFAULTS.showTasks);
    const [showProjects, setShowProjects] = usePersistentState('showProjects', DEFAULTS.showProjects);
    const [showCanvas, setShowCanvas] = usePersistentState('showCanvas', DEFAULTS.showCanvas);
    const [showTags, setShowTags] = usePersistentState('showTags', DEFAULTS.showTags);

    // Visualization Toggles
    const [showDependencies, setShowDependencies] = usePersistentState('showDependencies', DEFAULTS.showDependencies);
    const [showPredicates, setShowPredicates] = usePersistentState('showPredicates', DEFAULTS.showPredicates);
    const [showNames, setShowNames] = usePersistentState('showNames', DEFAULTS.showNames);

    // Physics
    const [forceCharge, setForceCharge] = usePersistentState('forceCharge', DEFAULTS.forceCharge);
    const [linkDistance, setLinkDistance] = usePersistentState('linkDistance', DEFAULTS.linkDistance);

    const graphRef = useRef<any>(null);
    const dragRef = useRef<{ startX: number, startY: number, startPosX: number, startPosY: number } | null>(null);

    // Reset Function
    const handleReset = () => {
        setShowDocs(DEFAULTS.showDocs);
        setShowTasks(DEFAULTS.showTasks);
        setShowProjects(DEFAULTS.showProjects);
        setShowCanvas(DEFAULTS.showCanvas);
        setShowTags(DEFAULTS.showTags);
        setShowDependencies(DEFAULTS.showDependencies);
        setShowPredicates(DEFAULTS.showPredicates);
        setShowNames(DEFAULTS.showNames);
        setForceCharge(DEFAULTS.forceCharge);
        setLinkDistance(DEFAULTS.linkDistance);

        // Also reset position? Maybe keep position but reset internal values
        setSettingsPos({ x: window.innerWidth - 320, y: 80 });
    };

    useEffect(() => {
        // Initial position on the right side if not set or just ensure nice default
        // We don't persist position for now as per previous code, but we could.
        // Let's stick to user request about "settings"
        setSettingsPos({ x: window.innerWidth - 320, y: 80 });
    }, []);

    // --- Fetch & Adapt Data ---
    useEffect(() => {
        fetch('/api/graph')
            .then(res => res.json())
            .then((jsonLd: Graph) => {
                const nodes: GraphNode[] = [];
                const links: GraphLink[] = [];

                if (jsonLd['@graph']) {
                    jsonLd['@graph'].forEach((entity: any) => {
                        // Extract base properties
                        const node: GraphNode = {
                            id: entity['@id'],
                            name: entity.name || entity.headline || entity['@id'],
                            type: entity['@type'],
                            val: entity.val || 1,
                            color: entity.color || '#999',
                            group: entity.group
                        };
                        nodes.push(node);

                        // Extract Links
                        if (entity.mentions) {
                            (Array.isArray(entity.mentions) ? entity.mentions : [entity.mentions]).forEach((m: any) => {
                                links.push({ source: entity['@id'], target: m['@id'], type: 'mentions' });
                            });
                        }
                        if (entity.agent) {
                            links.push({ source: entity['@id'], target: entity.agent['@id'], type: 'belongs_to' });
                        }
                        if (entity.dependencies) {
                            entity.dependencies.forEach((d: any) => {
                                links.push({ source: entity['@id'], target: d['@id'], type: d.relationshipType || 'depends_on' });
                            });
                        }
                        if (entity.about) {
                            (Array.isArray(entity.about) ? entity.about : [entity.about]).forEach((t: any) => {
                                links.push({ source: entity['@id'], target: t['@id'], type: 'tagged' });
                            });
                        }
                    });
                }

                setGraphData({ nodes, links });
                setIsLoading(false);
            })
            .catch(err => {
                console.error(err);
                setIsLoading(false);
            });
    }, []);

    // --- Filtered Data ---
    const filteredData = useMemo(() => {
        if (!graphData.nodes.length) return { nodes: [], links: [] };

        const typeMap: Record<string, boolean> = {
            'TechArticle': showDocs,
            'BlogPosting': showDocs,
            'Action': showTasks,
            'Project': showProjects,
            'CreativeWork': showCanvas,
            'DefinedTerm': showTags
        };

        const activeNodes = graphData.nodes.filter(n => typeMap[n.type] ?? true);
        const activeNodeIds = new Set(activeNodes.map(n => n.id));

        const activeLinks = graphData.links.filter(l => {
            if (!activeNodeIds.has(l.source) || !activeNodeIds.has(l.target)) return false;
            if (l.type === 'blocks' || l.type === 'depends_on') return showDependencies;
            return true;
        });

        return { nodes: activeNodes, links: activeLinks };
    }, [graphData, showDocs, showTasks, showProjects, showCanvas, showTags, showDependencies]);

    // --- Physics Update ---
    useEffect(() => {
        if (graphRef.current) {
            graphRef.current.d3Force('charge').strength(forceCharge);
            graphRef.current.d3Force('link').distance(linkDistance);
            graphRef.current.d3ReheatSimulation();
        }
    }, [forceCharge, linkDistance, isLoading]);

    // --- Drag Logic ---
    const handleDragStart = (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('input') || (e.target as HTMLElement).closest('label')) return;
        e.preventDefault();
        dragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            startPosX: settingsPos.x,
            startPosY: settingsPos.y
        };
        document.addEventListener('mousemove', handleDragMove);
        document.addEventListener('mouseup', handleDragEnd);
    };

    const handleDragMove = useCallback((e: MouseEvent) => {
        if (!dragRef.current) return;
        const deltaX = e.clientX - dragRef.current.startX;
        const deltaY = e.clientY - dragRef.current.startY;
        setSettingsPos({
            x: Math.max(0, Math.min(window.innerWidth - 300, dragRef.current.startPosX + deltaX)),
            y: Math.max(0, Math.min(window.innerHeight - 500, dragRef.current.startPosY + deltaY))
        });
    }, []);

    const handleDragEnd = useCallback(() => {
        dragRef.current = null;
        document.removeEventListener('mousemove', handleDragMove);
        document.removeEventListener('mouseup', handleDragEnd);
    }, [handleDragMove]);


    // Prevent hydration mismatch for persistent state
    if (!isClient) return null;

    return (
        <AppShell
            title="Wissensgraph"
            actions={
                <FloatingActionButton
                    icon={<Settings2 size={24} />}
                    label={settingsOpen ? "Einstellungen schließen" : "Einstellungen öffnen"}
                    onClick={() => setSettingsOpen(prev => !prev)}
                    className={settingsOpen ? styles.fabActive : ''}
                />
            }
        >
            <div className={styles.container}>

                {/* Graph Area */}
                <div className={styles.graphWrapper}>
                    {isLoading ? (
                        <div className={styles.loading}>Lade Graph...</div>
                    ) : (
                        <ForceGraph2D
                            ref={graphRef}
                            graphData={filteredData}
                            nodeLabel="name"
                            nodeColor="color"
                            nodeVal="val"

                            // Links
                            linkDirectionalArrowLength={3.5}
                            linkDirectionalArrowRelPos={1}
                            linkCurvature={0.25}

                            // Link Color
                            linkColor={(link: any) => {
                                if (link.type === 'depends_on' || link.type === 'blocks') return showDependencies ? '#ff4444' : 'rgba(150,150,150,0.2)';
                                return 'rgba(150,150,150,0.2)';
                            }}

                            // Link Labels (Predicates)
                            linkCanvasObject={showPredicates ? (link: any, ctx, globalScale) => {
                                const label = link.type;
                                if (!label) return;

                                const fontSize = 10 / globalScale;
                                ctx.font = `${fontSize}px Sans-Serif`;
                                const textWidth = ctx.measureText(label).width;
                                const bckgDimensions = [textWidth, fontSize].map(n => n + fontSize * 0.2);

                                // Safe coordinate access
                                const x1 = link.source?.x ?? 0;
                                const y1 = link.source?.y ?? 0;
                                const x2 = link.target?.x ?? 0;
                                const y2 = link.target?.y ?? 0;

                                const midX = x1 + (x2 - x1) / 2;
                                const midY = y1 + (y2 - y1) / 2;

                                const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
                                ctx.fillStyle = isDark ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.8)';
                                ctx.fillRect(midX - bckgDimensions[0] / 2, midY - bckgDimensions[1] / 2, bckgDimensions[0], bckgDimensions[1]);

                                ctx.textAlign = 'center';
                                ctx.textBaseline = 'middle';
                                ctx.fillStyle = isDark ? '#aaa' : '#555';
                                ctx.fillText(label, midX, midY);
                            } : undefined}
                            linkCanvasObjectMode={() => 'after'}


                            // Node Labels (Always visible)
                            nodeCanvasObject={showNames ? (node: any, ctx, globalScale) => {
                                const label = node.name;
                                const fontSize = 12 / globalScale;
                                ctx.font = `${fontSize}px Sans-Serif`;
                                const textWidth = ctx.measureText(label).width;
                                const bckgDimensions = [textWidth, fontSize].map(n => n + fontSize * 0.2); // some padding

                                // Check theme for correct colors
                                const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
                                const bgColor = isDark ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.8)';
                                const textColor = node.color;

                                ctx.fillStyle = bgColor;
                                ctx.fillRect(node.x - bckgDimensions[0] / 2, node.y - bckgDimensions[1] / 2, bckgDimensions[0], bckgDimensions[1]);

                                ctx.textAlign = 'center';
                                ctx.textBaseline = 'middle';
                                ctx.fillStyle = textColor;
                                ctx.fillText(label, node.x, node.y);

                                // Draw node circle as well otherwise it's just text
                                ctx.beginPath();
                                ctx.arc(node.x, node.y, node.val, 0, 2 * Math.PI, false);
                                ctx.fill();
                            } : undefined}

                            backgroundColor="rgba(0,0,0,0)"
                            width={dimensions.width}
                            height={dimensions.height} // Fullscreen canvas
                        />
                    )}
                </div>

                {/* Floating Settings Panel */}
                {settingsOpen && (
                    <div
                        className={styles.floatingSettings}
                        style={{ left: settingsPos.x, top: settingsPos.y }}
                        onMouseDown={handleDragStart}
                    >
                        <Card className={styles.cardInner}>
                            <div className={styles.settingsHeader}>
                                <h3>Graph Einstellungen</h3>
                                <div className={styles.headerActions}>
                                    <button
                                        className={styles.resetButton}
                                        onClick={handleReset}
                                        title="Einstellungen zurücksetzen"
                                    >
                                        <RotateCcw size={14} />
                                    </button>
                                    <button className={styles.closeButton} onClick={() => setSettingsOpen(false)}>
                                        <X size={18} />
                                    </button>
                                </div>
                            </div>
                            <CardContent className={styles.settingsContent}>
                                <div className={styles.section}>
                                    <h4>Ansicht</h4>
                                    <label><input type="checkbox" checked={showNames} onChange={e => setShowNames(e.target.checked)} /> Namen anzeigen</label>
                                    <label><input type="checkbox" checked={showPredicates} onChange={e => setShowPredicates(e.target.checked)} /> Beziehungen anzeigen</label>
                                    <label><input type="checkbox" checked={showDependencies} onChange={e => setShowDependencies(e.target.checked)} /> Abhängigkeiten anzeigen</label>
                                </div>

                                <div className={styles.section}>
                                    <h4>Physik</h4>
                                    <label>
                                        Abstand ({linkDistance})
                                        <input type="range" min="10" max="200" value={linkDistance} onChange={e => setLinkDistance(Number(e.target.value))} />
                                    </label>
                                    <label>
                                        Kraft ({forceCharge})
                                        <input type="range" min="-500" max="-10" value={forceCharge} onChange={e => setForceCharge(Number(e.target.value))} />
                                    </label>
                                </div>

                                <div className={styles.section}>
                                    <h4>Filter</h4>
                                    <label><input type="checkbox" checked={showProjects} onChange={e => setShowProjects(e.target.checked)} /> <span style={{ color: '#00674F' }}>●</span> Projekte</label>
                                    <label><input type="checkbox" checked={showTasks} onChange={e => setShowTasks(e.target.checked)} /> <span style={{ color: '#2E7D4A' }}>●</span> Aufgaben</label>
                                    <label><input type="checkbox" checked={showDocs} onChange={e => setShowDocs(e.target.checked)} /> <span style={{ color: '#2563A0' }}>●</span> Dokumente</label>
                                    <label><input type="checkbox" checked={showCanvas} onChange={e => setShowCanvas(e.target.checked)} /> <span style={{ color: '#B8860B' }}>●</span> Canvas</label>
                                    <label><input type="checkbox" checked={showTags} onChange={e => setShowTags(e.target.checked)} /> <span style={{ color: '#8A8A8A' }}>●</span> Tags</label>
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                )}
            </div>
        </AppShell>
    );
}
