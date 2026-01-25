'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { AppShell } from '@/components/layout';
import { Card, CardContent, Button } from '@/components/ui';
import styles from './page.module.css';

// Dynamically import ForceGraph to avoid SSR issues with Canvas
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

interface GraphData {
    nodes: any[];
    links: any[];
}

export default function GraphExplorerPage() {
    const [data, setData] = useState<GraphData>({ nodes: [], links: [] });
    const [isLoading, setIsLoading] = useState(true);

    // Filters
    const [showDocs, setShowDocs] = useState(true);
    const [showTasks, setShowTasks] = useState(true);
    const [showProjects, setShowProjects] = useState(true);
    const [showCanvas, setShowCanvas] = useState(true);
    const [showTags, setShowTags] = useState(false); // Default off to reduce noise

    // Clustering
    const [enableClustering, setEnableClustering] = useState(false);

    const graphRef = useRef<any>(null);

    useEffect(() => {
        fetch('/api/graph')
            .then(res => res.json())
            .then(graphData => {
                setData(graphData);
                setIsLoading(false);
            })
            .catch(err => {
                console.error(err);
                setIsLoading(false);
            });
    }, []);

    // Adjust forces when clustering changes
    useEffect(() => {
        if (graphRef.current) {
            graphRef.current.d3Force('charge').strength(enableClustering ? -30 : -100);
            graphRef.current.d3Force('link').distance(enableClustering ? 30 : 60);
        }
    }, [enableClustering, isLoading]);

    // Theme Management for Links
    const [linkColor, setLinkColor] = useState('rgba(200, 200, 200, 0.2)'); // Default fallback

    useEffect(() => {
        const updateTheme = () => {
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            // Dark Mode: White links
            // Light Mode: Dark links
            setLinkColor(isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)');
        };

        // Initial check
        updateTheme();

        // Observe attribute changes on HTML element
        const observer = new MutationObserver(updateTheme);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

        return () => observer.disconnect();
    }, []);

    const filteredData = useMemo(() => {
        if (!data.nodes.length) return { nodes: [], links: [] };

        const activeTypes = new Set([
            ...(showDocs ? ['doc'] : []),
            ...(showTasks ? ['task'] : []),
            ...(showProjects ? ['project'] : []),
            ...(showCanvas ? ['canvas'] : []),
            ...(showTags ? ['tag'] : [])
        ]);

        const nodes = data.nodes.filter(n => activeTypes.has(n.type));
        const nodeIds = new Set(nodes.map(n => n.id));
        const links = data.links.filter(l => nodeIds.has(l.source.id || l.source) && nodeIds.has(l.target.id || l.target));

        return { nodes, links };
    }, [data, showDocs, showTasks, showProjects, showCanvas, showTags]);

    return (
        <AppShell title="Wissensgraph">
            <div className={styles.container}>
                <div className={styles.controls}>
                    <Card className={styles.controlCard}>
                        <CardContent className={styles.filterGroup}>
                            <h4 className={styles.filterTitle}>Ansicht</h4>
                            <label className={styles.checkbox}>
                                <input type="checkbox" checked={enableClustering} onChange={e => setEnableClustering(e.target.checked)} />
                                Cluster Projekte
                            </label>

                            <h4 className={styles.filterTitle}>Filter</h4>
                            <label className={styles.checkbox}>
                                <input type="checkbox" checked={showProjects} onChange={e => setShowProjects(e.target.checked)} />
                                <span style={{ color: '#00674F' }}>●</span> Projekte
                            </label>
                            <label className={styles.checkbox}>
                                <input type="checkbox" checked={showDocs} onChange={e => setShowDocs(e.target.checked)} />
                                <span style={{ color: '#2563A0' }}>●</span> Dokumente
                            </label>
                            <label className={styles.checkbox}>
                                <input type="checkbox" checked={showTasks} onChange={e => setShowTasks(e.target.checked)} />
                                <span style={{ color: '#2E7D4A' }}>●</span> Aufgaben
                            </label>
                            <label className={styles.checkbox}>
                                <input type="checkbox" checked={showCanvas} onChange={e => setShowCanvas(e.target.checked)} />
                                <span style={{ color: '#B8860B' }}>●</span> Canvas
                            </label>
                            <label className={styles.checkbox}>
                                <input type="checkbox" checked={showTags} onChange={e => setShowTags(e.target.checked)} />
                                <span style={{ color: '#8A8A8A' }}>●</span> Tags
                            </label>
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => graphRef.current?.zoomToFit(400)}
                            >
                                Reset Zoom
                            </Button>
                        </CardContent>
                    </Card>
                </div>

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
                            // Directionality
                            linkDirectionalArrowLength={3.5}
                            linkDirectionalArrowRelPos={1}
                            linkCurvature={0.25}
                            // Custom Link Color
                            linkColor={() => linkColor}
                            backgroundColor="rgba(0,0,0,0)" // Transparent to let CSS background show through
                            width={1200}
                            height={800}
                            onNodeClick={(node: any) => {
                                graphRef.current?.centerAt(node.x, node.y, 1000);
                                graphRef.current?.zoom(8, 2000);
                            }}
                        />
                    )}
                </div>
            </div>
        </AppShell>
    );
}
