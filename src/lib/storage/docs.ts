import { promises as fs } from 'fs';
import path from 'path';
import { Doc, DocFrontmatter, DocType } from '@/types/doc';

const DATA_DIR = path.join(process.cwd(), 'data', 'docs');

/**
 * Parse YAML frontmatter from Markdown content
 */
function parseFrontmatter(content: string): { frontmatter: DocFrontmatter | null; body: string } {
    const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

    const match = content.match(frontmatterRegex);

    if (!match) {
        return { frontmatter: null, body: content };
    }

    const yamlContent = match[1];
    const body = match[2];

    const frontmatter: Record<string, string | string[]> = {};
    const lines = yamlContent.split('\n');

    for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) continue;

        const key = line.slice(0, colonIndex).trim();
        let value = line.slice(colonIndex + 1).trim();

        // Handle arrays (tags)
        if (value.startsWith('[') && value.endsWith(']')) {
            value = value.slice(1, -1);
            frontmatter[key] = value.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        } else {
            // Remove quotes if present
            frontmatter[key] = value.replace(/^["']|["']$/g, '');
        }
    }

    return {
        frontmatter: frontmatter as unknown as DocFrontmatter,
        body: body.trim(),
    };
}

/**
 * Generate YAML frontmatter string
 */
function generateFrontmatter(meta: DocFrontmatter): string {
    const lines = [
        '---',
        `id: "${meta.id}"`,
        `slug: "${meta.slug}"`,
        `title: "${meta.title}"`,
    ];

    if (meta.category) lines.push(`category: "${meta.category}"`);
    if (meta.author) lines.push(`author: "${meta.author}"`);
    if (meta.type) lines.push(`type: "${meta.type}"`);
    if (meta.inLanguage) lines.push(`inLanguage: "${meta.inLanguage}"`);

    const tagsStr = meta.tags.map(t => `"${t}"`).join(', ');
    lines.push(`tags: [${tagsStr}]`);
    lines.push(`createdAt: "${meta.createdAt}"`);
    lines.push(`updatedAt: "${meta.updatedAt}"`);
    lines.push('---');

    return lines.join('\n');
}

/**
 * Generate a unique ID
 */
function generateId(): string {
    return `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sanitize filename from title (german to english transliteration simple)
 */
function sanitizeFilename(title: string): string {
    return title
        .toLowerCase()
        .replace(/[äÄ]/g, 'ae')
        .replace(/[öÖ]/g, 'oe')
        .replace(/[üÜ]/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
}

/**
 * Generate English slug (simple placeholder logic for now)
 */
export function generateSlug(title: string): string {
    return sanitizeFilename(title);
}

/**
 * Ensure data directory exists
 */
async function ensureDataDir(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
}

/**
 * List all docs
 */
export async function listDocs(): Promise<Doc[]> {
    await ensureDataDir();

    try {
        const files = await fs.readdir(DATA_DIR);
        const mdFiles = files.filter(f => f.endsWith('.md'));

        const docs: Doc[] = [];

        for (const file of mdFiles) {
            const content = await fs.readFile(path.join(DATA_DIR, file), 'utf-8');
            const { frontmatter, body } = parseFrontmatter(content);

            if (frontmatter) {
                docs.push({
                    ...frontmatter,
                    tags: frontmatter.tags || [],
                    content: body,
                });
            }
        }

        // Sort by updatedAt descending
        return docs.sort((a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
    } catch {
        return [];
    }
}

/**
 * Get a single doc by ID
 */
export async function getDoc(id: string): Promise<Doc | null> {
    const docs = await listDocs();
    return docs.find(n => n.id === id) || null;
}

/**
 * Get a single doc by Slug
 */
export async function getDocBySlug(slug: string): Promise<Doc | null> {
    const docs = await listDocs();
    return docs.find(n => n.slug === slug) || null;
}

/**
 * Create a new doc
 */
export async function createDoc(data: {
    title: string;
    content: string;
    category?: string;
    type?: DocType;
    tags?: string[];
}): Promise<Doc> {
    await ensureDataDir();

    const now = new Date().toISOString();
    const id = generateId();
    const slug = generateSlug(data.title);

    const doc: Doc = {
        id,
        slug,
        title: data.title,
        content: data.content,
        category: data.category,
        tags: data.tags || [],
        type: data.type || 'CreativeWork', // Default
        author: 'default-author', // Should be configured via ENV or Context
        inLanguage: 'de',
        createdAt: now,
        updatedAt: now,
    };

    const frontmatter = generateFrontmatter(doc);

    // Filename uses the slug for cleaner FS
    const filename = `${slug}.md`;

    await fs.writeFile(path.join(DATA_DIR, filename), `${frontmatter}\n\n${doc.content}`, 'utf-8');

    return doc;
}

/**
 * Update an existing doc
 */
export async function updateDoc(id: string, data: {
    title?: string;
    content?: string;
    category?: string;
    tags?: string[];
    type?: DocType;
    slug?: string;
}): Promise<Doc | null> {
    const docs = await listDocs();
    const existing = docs.find(n => n.id === id);

    if (!existing) return null;

    // Remove old file if slug/title changes
    if (data.slug && data.slug !== existing.slug) {
        // This requires finding the old file by the old slug/filename
        const oldFilename = `${existing.slug}.md`;
        // But existing logic used title for filename sanitized.
        // Since we are migrating, we should assume we might need to look for files.
        // Ideally, we just check if file exists.
        // For now, let's keep it robust by searching by ID in the directory loop if needed, 
        // but since we read all into memory in listDocs, we can just find it.
    }

    // Deleting old file strategy
    const files = await fs.readdir(DATA_DIR);
    for (const file of files) {
        const content = await fs.readFile(path.join(DATA_DIR, file), 'utf-8');
        const { frontmatter } = parseFrontmatter(content);
        if (frontmatter?.id === id) {
            await fs.unlink(path.join(DATA_DIR, file));
            break;
        }
    }

    const now = new Date().toISOString();
    const updated: Doc = {
        ...existing,
        title: data.title ?? existing.title,
        content: data.content ?? existing.content,
        category: data.category ?? existing.category,
        tags: data.tags ?? existing.tags,
        type: data.type ?? existing.type,
        slug: data.slug ?? existing.slug,
        updatedAt: now,
    };

    const frontmatter = generateFrontmatter(updated);

    // We prefer using slug for filename if we can, but we need to ensure backward compatibility or migration
    // For new system: always use slug
    const filename = `${updated.slug}.md`;

    await fs.writeFile(path.join(DATA_DIR, filename), `${frontmatter}\n\n${updated.content}`, 'utf-8');

    return updated;
}

/**
 * Delete a doc
 */
export async function deleteDoc(id: string): Promise<boolean> {
    try {
        const files = await fs.readdir(DATA_DIR);

        for (const file of files) {
            const content = await fs.readFile(path.join(DATA_DIR, file), 'utf-8');
            const { frontmatter } = parseFrontmatter(content);

            if (frontmatter?.id === id) {
                await fs.unlink(path.join(DATA_DIR, file));
                return true;
            }
        }

        return false;
    } catch {
        return false;
    }
}
