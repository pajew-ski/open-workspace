
import { NextResponse } from 'next/server';
import { listDocs } from '@/lib/storage/docs';
import { listTasks } from '@/lib/storage/tasks';
import { listProjects } from '@/lib/storage/projects';
import { listCanvases } from '@/lib/storage/canvas';

interface GraphNode {
    id: string;
    name: string;
    val: number; // Size
    type: 'doc' | 'task' | 'project' | 'canvas' | 'tag';
    color?: string;
    group?: number;
}

interface GraphLink {
    source: string;
    target: string;
    type?: string;
}

export async function GET() {
    try {
        const [docs, tasks, projects, canvases] = await Promise.all([
            listDocs(),
            listTasks(),
            listProjects().catch(() => []),
            listCanvases()
        ]);

        const nodes: GraphNode[] = [];
        const links: GraphLink[] = [];
        const addedNodeIds = new Set<string>();

        // Colors from Design System
        /*
        --color-primary: #00674F; (Projects)
        --color-success: #2E7D4A; (Tasks)
        --color-info: #2563A0; (Docs)
        --color-warning: #B8860B; (Canvas)
        --color-text-tertiary: #8A8A8A; (Tags)
        */
        const COLORS = {
            project: '#00674F',
            task: '#2E7D4A',
            doc: '#2563A0',
            canvas: '#B8860B',
            tag: '#8A8A8A'
        };

        const addNode = (node: GraphNode) => {
            if (!addedNodeIds.has(node.id)) {
                nodes.push(node);
                addedNodeIds.add(node.id);
            }
        };

        // 1. Projects
        projects.forEach(p => {
            addNode({
                id: `proj-${p.id}`,
                name: p.title,
                val: 8, // Larger
                type: 'project',
                color: p.color || COLORS.project
            });
        });

        // 2. Tasks
        tasks.forEach(t => {
            addNode({
                id: `task-${t.id}`,
                name: t.title,
                val: 3,
                type: 'task',
                color: COLORS.task,
                group: t.projectId ? parseInt(t.projectId.replace(/\D/g, '').slice(0, 5), 10) : undefined // Simple hash for grouping
            });

            if (t.projectId) {
                links.push({
                    source: `task-${t.id}`,
                    target: `proj-${t.projectId}`,
                    type: 'belongs_to',
                    // Project links are strong structural links
                });
            }
        });

        // 3. Docs
        const slugToIdMap = new Map<string, string>();
        docs.forEach(d => slugToIdMap.set(d.slug, `doc-${d.id}`));

        docs.forEach(d => {
            const docId = `doc-${d.id}`;
            addNode({
                id: docId,
                name: d.title,
                val: 4,
                type: 'doc',
                color: COLORS.doc
            });

            // Mentions
            const mentionRegex = /\[\[(.*?)\]\]/g;
            let match;
            while ((match = mentionRegex.exec(d.content)) !== null) {
                const title = match[1];
                const targetSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                const targetId = slugToIdMap.get(targetSlug);

                if (targetId) {
                    links.push({ source: docId, target: targetId, type: 'mentions' });
                }
            }

            // Tags
            d.tags?.forEach(tag => {
                const tagId = `tag-${tag}`;
                addNode({
                    id: tagId,
                    name: `#${tag}`,
                    val: 1,
                    type: 'tag',
                    color: COLORS.tag
                });
                links.push({ source: docId, target: tagId, type: 'tagged' });
            });
        });

        // 4. Canvases & Connections
        canvases.forEach(c => {
            // Add Canvas Node itself
            const canvasRootId = `canvas-${c.id}`;
            addNode({
                id: canvasRootId,
                name: c.name,
                val: 6,
                type: 'canvas',
                color: COLORS.canvas
            });

            // Add internal Canvas nodes (optional, might get too busy, but user asked for detail)
            // For now, let's keep it simple: Canvas represents the work. 
            // Future: To support detailed directional parts, we would need to load each canvas individually.
            // For now, we only visualize the canvas as a high-level node.
        });

        return NextResponse.json({ nodes, links });

    } catch (error) {
        console.error('Graph API Error:', error);
        return NextResponse.json({ error: 'Failed to generate graph' }, { status: 500 });
    }
}
