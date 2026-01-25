
import { NextResponse } from 'next/server';
import { listDocs } from '@/lib/storage/docs';
import { listTasks } from '@/lib/storage/tasks';
import { listProjects } from '@/lib/storage/projects';
import { listCanvases } from '@/lib/storage/canvas';
import { WithContext, Graph, Thing, Project, Action, CreativeWork, TechArticle, DefinedTerm } from 'schema-dts';

// Helper to sanitize IDs
const sanitizeId = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export async function GET() {
    try {
        const [docs, tasks, projects, canvases] = await Promise.all([
            listDocs(),
            listTasks(),
            listProjects().catch(() => []),
            listCanvases()
        ]);

        const graphNodes: Thing[] = [];

        // Config constants
        const BASE_URL = 'https://exocortex.local';
        const COLORS = {
            project: '#00674F',
            task: '#2E7D4A',
            doc: '#2563A0',
            canvas: '#B8860B',
            tag: '#8A8A8A'
        };

        // 1. Projects
        projects.forEach(p => {
            const projectNode: Project = {
                '@type': 'Project',
                '@id': `${BASE_URL}/projects/${p.id}`,
                name: p.title,
                description: 'Project', // Generic description or from data
                // Custom extension properties for visualization can be added but won't be valid Schema.org
                // We will add them as standard properties where possible, or extensions with clear naming
                // For graph viz, we might need to parse these out on client side
                'identifier': `proj-${p.id}`,
                'color': p.color || COLORS.project,
                'val': 8
            } as any;
            graphNodes.push(projectNode);
        });

        // 2. Tasks
        tasks.forEach(t => {
            const taskNode: Action = {
                '@type': 'Action',
                '@id': `${BASE_URL}/tasks/${t.id}`,
                name: t.title,
                agent: t.projectId ? { '@id': `${BASE_URL}/projects/${t.projectId}` } : undefined, // Links to Project
                actionStatus: t.status === 'done' ? 'CompletedActionStatus' : 'ActiveActionStatus',
                'identifier': `task-${t.id}`,
                'color': COLORS.task,
                'val': 3
            } as any;

            // Handle Dependencies
            if (t.dependencies && t.dependencies.length > 0) {
                // schema.org doesn't have a direct "dependsOn" for Action. 
                // We can use 'object' or a custom property or 'result' flow?
                // Let's use a custom property 'dependencies' for now as it's critical for the graph
                (taskNode as any).dependencies = t.dependencies.map((dep: any) => ({
                    '@type': 'Action',
                    '@id': `${BASE_URL}/tasks/${dep.id}`,
                    'relationshipType': dep.type // e.g. "blocks", "relates_to"
                }));
            }

            graphNodes.push(taskNode);
        });

        // 3. Docs
        const slugToIdMap = new Map<string, string>();
        docs.forEach(d => slugToIdMap.set(d.slug, `${BASE_URL}/docs/${d.slug}`));

        docs.forEach(d => {
            const docUrl = `${BASE_URL}/docs/${d.slug}`;
            const docNode: TechArticle = {
                '@type': 'TechArticle',
                '@id': docUrl,
                headline: d.title,
                'identifier': `doc-${d.id}`,
                'color': COLORS.doc,
                'val': 4,
                mentions: []
            } as any;

            // Mentions (Links)
            const mentionRegex = /\[\[(.*?)\]\]/g;
            let match;
            const mentions: Thing[] = [];

            while ((match = mentionRegex.exec(d.content)) !== null) {
                const title = match[1];
                const targetSlug = sanitizeId(title);
                const targetId = slugToIdMap.get(targetSlug);

                if (targetId) {
                    mentions.push({ '@id': targetId });
                }
            }
            if (mentions.length > 0) {
                docNode.mentions = mentions;
            }

            // Tags
            if (d.tags && d.tags.length > 0) {
                (docNode as any).keywords = d.tags;
                // Create Tag nodes? Or just keep as property?
                // For Graph Viz, we want Tag Nodes.
                d.tags.forEach(tag => {
                    const tagId = `${BASE_URL}/tags/${tag}`;
                    // check if tag node exists, if not add it (simple check)
                    if (!graphNodes.find(n => n['@id'] === tagId)) {
                        graphNodes.push({
                            '@type': 'DefinedTerm',
                            '@id': tagId,
                            name: `#${tag}`,
                            'identifier': `tag-${tag}`,
                            'color': COLORS.tag,
                            'val': 1
                        } as any);
                    }
                    // Link doc to tag is implied by 'keywords', 
                    // but for explicit graph link we might want to standardize on 'mentions' or similar?
                    // Let's use 'about' for tags
                    if (!docNode.about) docNode.about = [];
                    (docNode.about as any[]).push({ '@id': tagId });
                });
            }

            graphNodes.push(docNode);
        });

        // 4. Canvases
        canvases.forEach(c => {
            const canvasNode: CreativeWork = {
                '@type': 'CreativeWork',
                '@id': `${BASE_URL}/canvas/${c.id}`,
                name: c.name,
                description: c.description,
                'identifier': `canvas-${c.id}`,
                'color': COLORS.canvas,
                'val': 6
            } as any;

            graphNodes.push(canvasNode);
        });

        const graph: Graph = {
            '@context': 'https://schema.org',
            '@graph': graphNodes
        };

        return NextResponse.json(graph);

    } catch (error) {
        console.error('Graph API Error:', error);
        return NextResponse.json({ error: 'Failed to generate graph' }, { status: 500 });
    }
}
