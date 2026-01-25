
import { promises as fs } from 'fs';
import path from 'path';

// Re-using logic from docs.ts manually to avoid import issues in standalone script if tsconfig paths aren't perfect for scripts
// Ideally we run this with `bun run scripts/migrate-to-docs.ts`

const DATA_DIR = path.join(process.cwd(), 'data', 'docs');

interface DocFrontmatter {
    id: string;
    slug: string;
    title: string;
    category?: string;
    tags: string[];
    author?: string;
    type?: string;
    inLanguage?: string;
    createdAt: string;
    updatedAt: string;
}

function parseFrontmatter(content: string): { frontmatter: Partial<DocFrontmatter> | null; body: string } {
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

        if (value.startsWith('[') && value.endsWith(']')) {
            value = value.slice(1, -1);
            frontmatter[key] = value.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        } else {
            frontmatter[key] = value.replace(/^["']|["']$/g, '');
        }
    }

    // Ensure tags is array
    if (!frontmatter.tags) frontmatter.tags = [];

    return {
        frontmatter: frontmatter as unknown as Partial<DocFrontmatter>,
        body: body.trim(),
    };
}

function generateFrontmatter(meta: Partial<DocFrontmatter>): string {
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

    const tagsStr = (meta.tags as string[] || []).map(t => `"${t}"`).join(', ');
    lines.push(`tags: [${tagsStr}]`);
    lines.push(`createdAt: "${meta.createdAt}"`);
    lines.push(`updatedAt: "${meta.updatedAt}"`);
    lines.push('---');

    return lines.join('\n');
}

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

function determineType(title: string, tags: string[] = [], category?: string): string {
    // Polymorphic Logic
    const t = title.toLowerCase();
    const c = category?.toLowerCase() || '';

    if (t.match(/\d{4}-\d{2}-\d{2}/)) return 'BlogPosting'; // Daily Note pattern
    if (tags.includes('daily') || tags.includes('log')) return 'BlogPosting';

    if (tags.includes('concept') || tags.includes('definition') || c === 'wiki') return 'DefinedTerm';

    if (title.startsWith('How to') || title.startsWith('Anleitung') || tags.includes('tutorial')) return 'HowTo';

    if (tags.includes('tech') || c === 'dev') return 'TechArticle';

    return 'CreativeWork';
}

async function migrate() {
    console.log(`Migrating docs in ${DATA_DIR}...`);

    try {
        await fs.access(DATA_DIR);
    } catch {
        console.error("Data directory does not exist!");
        return;
    }

    const files = await fs.readdir(DATA_DIR);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    for (const file of mdFiles) {
        const filePath = path.join(DATA_DIR, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(content);

        if (!frontmatter || !frontmatter.id || !frontmatter.title) {
            console.warn(`Skipping invalid file: ${file}`);
            continue;
        }

        let updated = false;

        // 1. Generate Slug if missing
        if (!frontmatter.slug) {
            frontmatter.slug = sanitizeFilename(frontmatter.title);
            updated = true;
        }

        // 2. Generate Author if missing
        if (!frontmatter.author) {
            frontmatter.author = "michael-pajewski"; // Default Identity
            updated = true;
        }

        // 3. Generate Type if missing
        if (!frontmatter.type) {
            frontmatter.type = determineType(frontmatter.title, frontmatter.tags, frontmatter.category);
            updated = true;
        }

        // 4. Set Language
        if (!frontmatter.inLanguage) {
            frontmatter.inLanguage = "de";
            updated = true;
        }

        if (updated) {
            const newContent = `${generateFrontmatter(frontmatter)}\n\n${body}`;

            // Rename file to slug.md
            const newFilename = `${frontmatter.slug}.md`;
            const newFilePath = path.join(DATA_DIR, newFilename);

            if (filePath !== newFilePath) {
                console.log(`Renaming ${file} -> ${newFilename}`);
                await fs.unlink(filePath);
            } else {
                console.log(`Updating metadata for ${file}`);
            }

            await fs.writeFile(newFilePath, newContent, 'utf-8');
        }
    }

    console.log("Migration complete.");
}

migrate().catch(console.error);
