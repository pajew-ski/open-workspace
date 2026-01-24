/**
 * Note Storage - Markdown files with YAML frontmatter
 * 
 * Notes are stored as .md files in data/notes/ for GitHub sync compatibility
 * Metadata is stored in YAML frontmatter
 */

import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data', 'notes');

export interface Note {
    id: string;
    title: string;
    content: string;
    category?: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
}

export interface NoteFrontmatter {
    id: string;
    title: string;
    category?: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
}

/**
 * Parse YAML frontmatter from Markdown content
 */
function parseFrontmatter(content: string): { frontmatter: NoteFrontmatter | null; body: string } {
    const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
    const match = content.match(frontmatterRegex);

    if (!match) {
        return { frontmatter: null, body: content };
    }

    const yamlContent = match[1];
    const body = match[2];

    // Simple YAML parser for our use case
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
        frontmatter: frontmatter as unknown as NoteFrontmatter,
        body: body.trim(),
    };
}

/**
 * Generate YAML frontmatter string
 */
function generateFrontmatter(meta: NoteFrontmatter): string {
    const lines = [
        '---',
        `id: "${meta.id}"`,
        `title: "${meta.title}"`,
    ];

    if (meta.category) {
        lines.push(`category: "${meta.category}"`);
    }

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
    return `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sanitize filename from title
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
 * Ensure data directory exists
 */
async function ensureDataDir(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
}

/**
 * List all notes
 */
export async function listNotes(): Promise<Note[]> {
    await ensureDataDir();

    try {
        const files = await fs.readdir(DATA_DIR);
        const mdFiles = files.filter(f => f.endsWith('.md'));

        const notes: Note[] = [];

        for (const file of mdFiles) {
            const content = await fs.readFile(path.join(DATA_DIR, file), 'utf-8');
            const { frontmatter, body } = parseFrontmatter(content);

            if (frontmatter) {
                notes.push({
                    ...frontmatter,
                    tags: frontmatter.tags || [],
                    content: body,
                });
            }
        }

        // Sort by updatedAt descending
        return notes.sort((a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
    } catch {
        return [];
    }
}

/**
 * Get a single note by ID
 */
export async function getNote(id: string): Promise<Note | null> {
    const notes = await listNotes();
    return notes.find(n => n.id === id) || null;
}

/**
 * Create a new note
 */
export async function createNote(data: {
    title: string;
    content: string;
    category?: string;
    tags?: string[];
}): Promise<Note> {
    await ensureDataDir();

    const now = new Date().toISOString();
    const id = generateId();

    const note: Note = {
        id,
        title: data.title,
        content: data.content,
        category: data.category,
        tags: data.tags || [],
        createdAt: now,
        updatedAt: now,
    };

    const frontmatter = generateFrontmatter({
        id: note.id,
        title: note.title,
        category: note.category,
        tags: note.tags,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
    });

    const fileContent = `${frontmatter}\n\n${note.content}`;
    const filename = `${sanitizeFilename(note.title)}.md`;

    await fs.writeFile(path.join(DATA_DIR, filename), fileContent, 'utf-8');

    return note;
}

/**
 * Update an existing note
 */
export async function updateNote(id: string, data: {
    title?: string;
    content?: string;
    category?: string;
    tags?: string[];
}): Promise<Note | null> {
    const notes = await listNotes();
    const existing = notes.find(n => n.id === id);

    if (!existing) return null;

    // Find and delete old file
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
    const updated: Note = {
        ...existing,
        title: data.title ?? existing.title,
        content: data.content ?? existing.content,
        category: data.category ?? existing.category,
        tags: data.tags ?? existing.tags,
        updatedAt: now,
    };

    const frontmatter = generateFrontmatter({
        id: updated.id,
        title: updated.title,
        category: updated.category,
        tags: updated.tags,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
    });

    const fileContent = `${frontmatter}\n\n${updated.content}`;
    const filename = `${sanitizeFilename(updated.title)}.md`;

    await fs.writeFile(path.join(DATA_DIR, filename), fileContent, 'utf-8');

    return updated;
}

/**
 * Delete a note
 */
export async function deleteNote(id: string): Promise<boolean> {
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
