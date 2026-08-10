'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { AppShell } from '@/components/layout';
import { Card, CardContent, Button, ConfirmDialog, FloatingActionButton } from '@/components/ui';
import { Settings2, X, RotateCcw, CloudDownload, Globe, ShieldCheck, TerminalSquare } from 'lucide-react';
import { isGraphQuery } from '@/lib/graph/sparql/classify';
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
    /** Hop-Tiefe für hierarchisches/radiales Layout (Query-Views). */
    depth?: number;
    /** Fixierte Y-Koordinate (hierarchisches Layout). */
    fy?: number;
}

interface GraphLink {
    source: string;
    target: string;
    type: string; // Predicate label
    /** Kante stammt aus graph/<u>/inferred/* (M7) — gestrichelt gezeichnet. */
    inferred?: boolean;
}

/** Reasoning-Zustand (GET /api/graph/reasoning, GRAPH_CORE_SPEC §7.3). */
interface ReasoningPayload {
    status: Array<{ scope: string; graph: string; inferred: number; generatedAt?: string }>;
    triples: Array<{ subject: string; predicate: string; object: string }>;
}

/** SHACL-Befund (POST /api/graph/validate, GRAPH_CORE_SPEC §7.2). */
interface ValidationReportPayload {
    conforms: boolean;
    counts: { violations: number; warnings: number; infos: number };
    results: Array<{
        severity: 'Violation' | 'Warning' | 'Info';
        focusNode: string;
        path?: string;
        message: string;
    }>;
}

const SEVERITY_LABELS: Record<ValidationReportPayload['results'][number]['severity'], string> = {
    Violation: 'Verstoß',
    Warning: 'Warnung',
    Info: 'Hinweis',
};

/** Kurzform einer IRI für die Anzeige (letztes Pfadsegment). */
function localName(iri: string): string {
    const cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
    return cut === -1 ? iri : iri.slice(cut + 1) || iri;
}

/** Gespeicherte Query-View (ow:QueryView, GRAPH_CORE_SPEC §9 / M5). */
interface QueryViewRecord {
    id: string;
    name: string;
    queryText: string;
    layoutMethod: 'force-directed' | 'hierarchical' | 'radial';
}

interface ResolvedViewPayload {
    view: QueryViewRecord;
    nodes: Array<{ id: string; name: string; type: string }>;
    links: Array<{ source: string; target: string; type: string }>;
    truncated: boolean;
}

const LAYOUT_LABELS: Record<QueryViewRecord['layoutMethod'], string> = {
    'force-directed': 'kräftebasiert',
    hierarchical: 'hierarchisch',
    radial: 'radial',
};

const DEFAULT_VIEW_QUERY = `CONSTRUCT { ?s ?p ?o }
WHERE { ?s ?p ?o . ?s a <https://pajew-ski.github.io/open-workspace/ns/v1#Document> }`;

/** Deterministische Farbe für unbekannte Typen einer Query-View. */
function typeColor(type: string): string {
    let hash = 0;
    for (const char of type) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return `hsl(${hash % 360}, 45%, 42%)`;
}

/**
 * Hop-Tiefe je Knoten (BFS von den Wurzeln — Knoten ohne eingehende
 * Kanten; Zyklen ohne Wurzel starten bei 0). Grundlage für
 * hierarchisches und radiales Layout.
 */
function computeDepths(
    nodes: Array<{ id: string }>,
    links: Array<{ source: string; target: string }>,
): Map<string, number> {
    const outgoing = new Map<string, string[]>();
    const hasIncoming = new Set<string>();
    for (const link of links) {
        outgoing.set(link.source, [...(outgoing.get(link.source) ?? []), link.target]);
        hasIncoming.add(link.target);
    }
    const depths = new Map<string, number>();
    const queue: string[] = [];
    for (const node of nodes) {
        if (!hasIncoming.has(node.id)) {
            depths.set(node.id, 0);
            queue.push(node.id);
        }
    }
    if (queue.length === 0 && nodes.length > 0) {
        depths.set(nodes[0].id, 0);
        queue.push(nodes[0].id);
    }
    while (queue.length > 0) {
        const current = queue.shift() as string;
        const depth = depths.get(current) ?? 0;
        for (const next of outgoing.get(current) ?? []) {
            if (!depths.has(next)) {
                depths.set(next, depth + 1);
                queue.push(next);
            }
        }
    }
    return depths;
}

/**
 * Präsentationswerte (Farbe, Knotengröße) sind seit dem Graph-Core-Umbau
 * nicht mehr Teil der API-Antwort (Trennung Wissen/Präsentation, SPEC §2).
 * Sie werden hier clientseitig aus dem Typ berechnet.
 */
const NODE_STYLE: Record<string, { color: string; val: number }> = {
    Project: { color: '#00674F', val: 8 },
    Action: { color: '#2E7D4A', val: 3 },
    TechArticle: { color: '#2563A0', val: 4 },
    BlogPosting: { color: '#2563A0', val: 4 },
    HowTo: { color: '#2563A0', val: 4 },
    CreativeWork: { color: '#B8860B', val: 6 },
    DefinedTerm: { color: '#8A8A8A', val: 1 },
};
const FALLBACK_STYLE = { color: '#999', val: 1 };

// Default Constants
const DEFAULTS = {
    showDocs: true,
    showTasks: true,
    showProjects: true,
    showCanvas: true,
    showTags: false,
    showDependencies: true,
    showInferred: false, // SPEC §11: inferierte Kanten per Default aus
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
    const [showInferred, setShowInferred] = usePersistentState('showInferred', DEFAULTS.showInferred);
    const [showPredicates, setShowPredicates] = usePersistentState('showPredicates', DEFAULTS.showPredicates);
    const [showNames, setShowNames] = usePersistentState('showNames', DEFAULTS.showNames);

    // --- Reasoning & Validierung (M7, GRAPH_CORE_SPEC §7.2/§7.3) ---
    const [reasoning, setReasoning] = useState<ReasoningPayload | null>(null);
    const [reasoningBusy, setReasoningBusy] = useState(false);
    const [reasoningError, setReasoningError] = useState<string | null>(null);
    const [validation, setValidation] = useState<ValidationReportPayload | null>(null);
    const [validationBusy, setValidationBusy] = useState(false);

    const loadReasoning = useCallback(async (method: 'GET' | 'POST') => {
        setReasoningBusy(true);
        setReasoningError(null);
        try {
            const response = await fetch('/api/graph/reasoning', { method });
            const data = await response.json();
            if (!response.ok) {
                setReasoningError(data.details || data.error || 'Reasoning nicht erreichbar');
                return;
            }
            setReasoning({ status: data.status ?? data.runs ?? [], triples: data.triples ?? [] });
        } catch (error) {
            setReasoningError(error instanceof Error ? error.message : 'Reasoning nicht erreichbar');
        } finally {
            setReasoningBusy(false);
        }
    }, []);

    // Inferenz-Kanten nachladen, sobald die Überlagerung eingeschaltet wird.
    useEffect(() => {
        if (showInferred && reasoning === null && !reasoningBusy) {
            loadReasoning('GET');
        }
    }, [showInferred, reasoning, reasoningBusy, loadReasoning]);

    const runValidation = useCallback(async () => {
        setValidationBusy(true);
        try {
            const response = await fetch('/api/graph/validate', { method: 'POST' });
            const data = await response.json();
            if (!response.ok) {
                setValidation({
                    conforms: false,
                    counts: { violations: 0, warnings: 0, infos: 0 },
                    results: [{ severity: 'Info', focusNode: '', message: data.details || data.error || 'Validierung nicht erreichbar' }],
                });
                return;
            }
            setValidation(data.report);
        } catch (error) {
            setValidation({
                conforms: false,
                counts: { violations: 0, warnings: 0, infos: 0 },
                results: [{ severity: 'Info', focusNode: '', message: error instanceof Error ? error.message : 'Validierung nicht erreichbar' }],
            });
        } finally {
            setValidationBusy(false);
        }
    }, []);

    // Physics
    const [forceCharge, setForceCharge] = usePersistentState('forceCharge', DEFAULTS.forceCharge);
    const [linkDistance, setLinkDistance] = usePersistentState('linkDistance', DEFAULTS.linkDistance);

    const graphRef = useRef<any>(null);
    const dragRef = useRef<{ startX: number, startY: number, startPosX: number, startPosY: number } | null>(null);

    // --- Query-Views (GRAPH_CORE_SPEC §9 / M5) ---
    const [views, setViews] = useState<QueryViewRecord[]>([]);
    const [activeView, setActiveView] = useState<{
        record: QueryViewRecord;
        nodes: GraphNode[];
        links: GraphLink[];
        truncated: boolean;
    } | null>(null);
    const [viewError, setViewError] = useState<string | null>(null);
    const [viewBusy, setViewBusy] = useState(false);
    const [viewDeleteConfirm, setViewDeleteConfirm] = useState<QueryViewRecord | null>(null);
    const [viewName, setViewName] = useState('');
    const [viewQuery, setViewQuery] = useState(DEFAULT_VIEW_QUERY);
    const [viewLayout, setViewLayout] = useState<QueryViewRecord['layoutMethod']>('force-directed');

    const fetchViews = useCallback(async () => {
        try {
            const response = await fetch('/api/graph/views');
            if (!response.ok) return;
            const data = await response.json();
            setViews(data.views ?? []);
        } catch {
            // Views sind optional — der Standard-Graph funktioniert ohne.
        }
    }, []);

    useEffect(() => {
        fetchViews();
    }, [fetchViews]);

    const applyView = useCallback(async (id: string) => {
        setViewBusy(true);
        setViewError(null);
        try {
            const response = await fetch(`/api/graph/views/${encodeURIComponent(id)}/resolve`);
            const data = await response.json();
            if (!response.ok) {
                setViewError(data.details || data.error || 'View nicht auflösbar');
                return;
            }
            const payload = data as ResolvedViewPayload;
            const depths = computeDepths(payload.nodes, payload.links);
            const hierarchical = payload.view.layoutMethod === 'hierarchical';
            const nodes: GraphNode[] = payload.nodes.map(node => {
                const style = NODE_STYLE[node.type];
                const depth = depths.get(node.id) ?? 0;
                return {
                    id: node.id,
                    name: node.name,
                    type: node.type,
                    val: style?.val ?? 3,
                    color: style?.color ?? typeColor(node.type),
                    depth,
                    ...(hierarchical ? { fy: depth * 140 } : {}),
                };
            });
            setActiveView({
                record: payload.view,
                nodes,
                links: payload.links,
                truncated: payload.truncated,
            });
        } catch (error) {
            setViewError(error instanceof Error ? error.message : 'View nicht auflösbar');
        } finally {
            setViewBusy(false);
        }
    }, []);

    const clearView = useCallback(() => {
        setActiveView(null);
        setViewError(null);
    }, []);

    const createView = useCallback(async () => {
        if (viewName.trim() === '' || viewQuery.trim() === '') {
            setViewError('Name und SPARQL-Query sind erforderlich.');
            return;
        }
        setViewBusy(true);
        setViewError(null);
        try {
            const response = await fetch('/api/graph/views', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: viewName.trim(), queryText: viewQuery, layoutMethod: viewLayout }),
            });
            const data = await response.json();
            if (!response.ok) {
                setViewError(data.details || data.error || 'View konnte nicht angelegt werden');
                return;
            }
            setViewName('');
            await fetchViews();
            await applyView(data.view.id);
        } catch (error) {
            setViewError(error instanceof Error ? error.message : 'View konnte nicht angelegt werden');
        } finally {
            setViewBusy(false);
        }
    }, [applyView, fetchViews, viewLayout, viewName, viewQuery]);

    const deleteView = useCallback(async (view: QueryViewRecord) => {
        setViewDeleteConfirm(null);
        try {
            const response = await fetch(`/api/graph/views/${encodeURIComponent(view.id)}`, { method: 'DELETE' });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                setViewError(data.details || data.error || 'View konnte nicht gelöscht werden');
                return;
            }
            if (activeView?.record.id === view.id) setActiveView(null);
            await fetchViews();
        } catch (error) {
            setViewError(error instanceof Error ? error.message : 'View konnte nicht gelöscht werden');
        }
    }, [activeView, fetchViews]);

    // Radiales Layout: eigene d3-Kraft zieht Knoten auf Ringe je Hop-Tiefe.
    useEffect(() => {
        const fg = graphRef.current;
        if (!fg) return;
        if (activeView?.record.layoutMethod === 'radial') {
            let simNodes: Array<GraphNode & { x: number; y: number; vx: number; vy: number }> = [];
            const force = (alpha: number) => {
                for (const node of simNodes) {
                    const radius = 80 + (node.depth ?? 0) * 130;
                    const distance = Math.hypot(node.x, node.y) || 1e-6;
                    const strength = ((radius - distance) / distance) * alpha * 0.25;
                    node.vx += node.x * strength;
                    node.vy += node.y * strength;
                }
            };
            force.initialize = (nodes: typeof simNodes) => {
                simNodes = nodes;
            };
            fg.d3Force('radial', force);
        } else {
            fg.d3Force('radial', null);
        }
        fg.d3ReheatSimulation();
    }, [activeView, isLoading]);

    // Reset Function
    const handleReset = () => {
        setShowDocs(DEFAULTS.showDocs);
        setShowTasks(DEFAULTS.showTasks);
        setShowProjects(DEFAULTS.showProjects);
        setShowCanvas(DEFAULTS.showCanvas);
        setShowTags(DEFAULTS.showTags);
        setShowDependencies(DEFAULTS.showDependencies);
        setShowInferred(DEFAULTS.showInferred);
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
                        // Präsentation (Farbe/Größe) aus dem Typ berechnen —
                        // die API liefert nur noch Wissen, kein Layout.
                        const style = NODE_STYLE[entity['@type']] ?? FALLBACK_STYLE;
                        const node: GraphNode = {
                            id: entity['@id'],
                            name: entity.name || entity.headline || entity['@id'],
                            type: entity['@type'],
                            val: style.val,
                            color: style.color,
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
            'HowTo': showDocs,
            'Action': showTasks,
            'Project': showProjects,
            'CreativeWork': showCanvas,
            'DefinedTerm': showTags
        };

        const activeNodes = graphData.nodes.filter(n => typeMap[n.type] ?? true);
        const activeNodeIds = new Set(activeNodes.map(n => n.id));

        // react-force-graph mutates link.source/target from id strings to
        // node objects on first render — normalize back to ids for filtering.
        const linkId = (end: unknown): string =>
            typeof end === 'object' && end !== null ? (end as { id: string }).id : String(end);

        const activeLinks = graphData.links.filter(l => {
            if (!activeNodeIds.has(linkId(l.source)) || !activeNodeIds.has(linkId(l.target))) return false;
            if (l.type === 'blocks' || l.type === 'depends_on') return showDependencies;
            return true;
        });

        // Inferierte Kanten (graph/<u>/inferred/workspace, M7) als
        // Überlagerung: nur zwischen sichtbaren Knoten, optisch
        // unterscheidbar (gestrichelt), per Default aus (SPEC §11).
        if (showInferred && reasoning) {
            const known = new Set(activeLinks.map(l => `${linkId(l.source)}|${l.type}|${linkId(l.target)}`));
            for (const t of reasoning.triples) {
                if (!activeNodeIds.has(t.subject) || !activeNodeIds.has(t.object)) continue;
                const type = localName(t.predicate);
                if (known.has(`${t.subject}|${type}|${t.object}`)) continue;
                activeLinks.push({ source: t.subject, target: t.object, type, inferred: true });
            }
        }

        return { nodes: activeNodes, links: activeLinks };
    }, [graphData, showDocs, showTasks, showProjects, showCanvas, showTags, showDependencies, showInferred, reasoning]);

    // Aktive Query-View ersetzt den Standard-Graphen (Live-Subgraph).
    const displayData = useMemo(
        () => (activeView ? { nodes: activeView.nodes, links: activeView.links } : filteredData),
        [activeView, filteredData],
    );

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
                            graphData={displayData}
                            nodeLabel="name"
                            nodeColor="color"
                            nodeVal="val"

                            // Links
                            linkDirectionalArrowLength={3.5}
                            linkDirectionalArrowRelPos={1}
                            linkCurvature={0.25}

                            // Link Color
                            linkColor={(link: any) => {
                                // Inferierte Kanten (M7): violett + gestrichelt.
                                if (link.inferred) return 'rgba(126, 87, 194, 0.75)';
                                if (link.type === 'depends_on' || link.type === 'blocks') return showDependencies ? '#ff4444' : 'rgba(150,150,150,0.2)';
                                return 'rgba(150,150,150,0.2)';
                            }}
                            linkLineDash={(link: any) => (link.inferred ? [4, 3] : null)}

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
                                    <label><input type="checkbox" checked={showInferred} onChange={e => setShowInferred(e.target.checked)} /> <span className={styles.inferredSwatch} aria-hidden="true">┄</span> Inferierte Kanten anzeigen</label>
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

                                <div className={styles.section}>
                                    <h4>Query-Views</h4>
                                    {activeView ? (
                                        <div className={styles.activeView}>
                                            <span>
                                                Aktiv: {activeView.record.name} ({LAYOUT_LABELS[activeView.record.layoutMethod]})
                                                {activeView.truncated ? ' — Ergebnis gekürzt' : ''}
                                            </span>
                                            <Button variant="ghost" size="sm" onClick={clearView}>Standard-Graph</Button>
                                        </div>
                                    ) : (
                                        views.length === 0 && (
                                            <p className={styles.viewsHint}>
                                                Noch keine gespeicherten Views — eine View ist eine SPARQL-Query
                                                (CONSTRUCT/DESCRIBE) mit Layout-Verfahren.
                                            </p>
                                        )
                                    )}
                                    {views.length > 0 && (
                                        <ul className={styles.viewList}>
                                            {views.map(view => (
                                                <li key={view.id} className={styles.viewItem}>
                                                    {isGraphQuery(view.queryText) ? (
                                                        <button
                                                            type="button"
                                                            className={styles.viewApply}
                                                            onClick={() => applyView(view.id)}
                                                            disabled={viewBusy}
                                                        >
                                                            {view.name}
                                                            <span className={styles.viewLayout}>{LAYOUT_LABELS[view.layoutMethod]}</span>
                                                        </button>
                                                    ) : (
                                                        // Gespeicherte SELECT/ASK-Queries (SPARQL-Editor, M2)
                                                        // sind keine Graph-Views — ehrlich verlinken statt
                                                        // eines toten Anwenden-Buttons (Invariante 10).
                                                        <Link
                                                            className={styles.viewApply}
                                                            href={`/graph/sparql?view=${encodeURIComponent(view.id)}`}
                                                        >
                                                            {view.name}
                                                            <span className={styles.viewLayout}>im Editor öffnen</span>
                                                        </Link>
                                                    )}
                                                    <button
                                                        type="button"
                                                        className={styles.viewDelete}
                                                        aria-label={`View "${view.name}" löschen`}
                                                        onClick={() => setViewDeleteConfirm(view)}
                                                    >
                                                        <X size={16} aria-hidden="true" />
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                    {viewError && <p className={styles.viewError} role="alert">{viewError}</p>}
                                    <details className={styles.viewForm}>
                                        <summary>Neue View anlegen</summary>
                                        <label className={styles.viewField}>
                                            Name
                                            <input
                                                type="text"
                                                value={viewName}
                                                onChange={e => setViewName(e.target.value)}
                                                placeholder="z. B. Dokument-Netz"
                                            />
                                        </label>
                                        <label className={styles.viewField}>
                                            Layout-Verfahren
                                            <select value={viewLayout} onChange={e => setViewLayout(e.target.value as QueryViewRecord['layoutMethod'])}>
                                                <option value="force-directed">kräftebasiert</option>
                                                <option value="hierarchical">hierarchisch</option>
                                                <option value="radial">radial</option>
                                            </select>
                                        </label>
                                        <label className={styles.viewField}>
                                            SPARQL (CONSTRUCT oder DESCRIBE)
                                            <textarea
                                                value={viewQuery}
                                                onChange={e => setViewQuery(e.target.value)}
                                                rows={5}
                                                spellCheck={false}
                                            />
                                        </label>
                                        <Button variant="primary" size="sm" onClick={createView} disabled={viewBusy}>
                                            {viewBusy ? 'Speichert…' : 'View speichern'}
                                        </Button>
                                    </details>
                                </div>

                                <div className={styles.section}>
                                    <h4>Reasoning &amp; Validierung</h4>
                                    <div className={styles.reasonActions}>
                                        <Button variant="ghost" size="sm" onClick={() => loadReasoning('POST')} disabled={reasoningBusy}>
                                            {reasoningBusy ? 'Leitet ab…' : 'Neu ableiten'}
                                        </Button>
                                        <Button variant="ghost" size="sm" onClick={runValidation} disabled={validationBusy}>
                                            {validationBusy ? 'Prüft…' : 'Validieren (SHACL)'}
                                        </Button>
                                    </div>
                                    {reasoning && (
                                        <p className={styles.reasonStatus}>
                                            {(() => {
                                                const ws = reasoning.status.find(s => s.scope === 'workspace');
                                                if (!ws) return 'Noch kein Reasoning-Lauf.';
                                                const stamp = ws.generatedAt
                                                    ? new Date(ws.generatedAt).toLocaleString('de-DE')
                                                    : 'unbekannt';
                                                return `${ws.inferred} abgeleitete Aussagen (Stand: ${stamp})`;
                                            })()}
                                        </p>
                                    )}
                                    {reasoningError && <p className={styles.viewError} role="alert">{reasoningError}</p>}
                                    {validation && (
                                        <div className={styles.validationReport}>
                                            <p className={styles.reasonStatus} role="status">
                                                {validation.conforms
                                                    ? 'SHACL: Bestand ist konform.'
                                                    : `SHACL: ${validation.counts.violations} Verstoß/Verstöße, ${validation.counts.warnings} Warnung(en), ${validation.counts.infos} Hinweis(e)`}
                                            </p>
                                            {validation.results.length > 0 && (
                                                <ul className={styles.validationList}>
                                                    {validation.results.slice(0, 12).map((result, index) => (
                                                        <li key={index} className={styles.validationItem} data-severity={result.severity}>
                                                            <span className={styles.validationSeverity}>{SEVERITY_LABELS[result.severity]}</span>
                                                            <span>
                                                                {result.focusNode ? <strong>{localName(result.focusNode)}: </strong> : null}
                                                                {result.message}
                                                            </span>
                                                        </li>
                                                    ))}
                                                    {validation.results.length > 12 && (
                                                        <li className={styles.validationItem}>… und {validation.results.length - 12} weitere Einträge.</li>
                                                    )}
                                                </ul>
                                            )}
                                        </div>
                                    )}
                                </div>

                                <div className={styles.section}>
                                    <h4>Quellen &amp; Abfragen</h4>
                                    <Link href="/graph/sparql" className={styles.sourcesLink}>
                                        <TerminalSquare size={14} aria-hidden="true" /> SPARQL-Editor
                                    </Link>
                                    <Link href="/graph/connectors" className={styles.sourcesLink}>
                                        <CloudDownload size={14} aria-hidden="true" /> Externe Quellen verwalten
                                    </Link>
                                    <Link href="/graph/federation" className={styles.sourcesLink}>
                                        <Globe size={14} aria-hidden="true" /> Föderierte Endpoints
                                    </Link>
                                    <Link href="/graph/access" className={styles.sourcesLink}>
                                        <ShieldCheck size={14} aria-hidden="true" /> Zugriff &amp; Freigaben
                                    </Link>
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                )}
            </div>

            <ConfirmDialog
                isOpen={viewDeleteConfirm !== null}
                title="Query-View löschen?"
                message={`Möchtest du die View "${viewDeleteConfirm?.name}" wirklich löschen? Die gespeicherte SPARQL-Query geht verloren.`}
                confirmText="Löschen"
                cancelText="Abbrechen"
                variant="danger"
                onConfirm={() => viewDeleteConfirm && deleteView(viewDeleteConfirm)}
                onCancel={() => setViewDeleteConfirm(null)}
            />
        </AppShell>
    );
}
