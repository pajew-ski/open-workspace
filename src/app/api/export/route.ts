import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

// Never export secrets (encrypted credentials + master key)
const EXCLUDED_DIRS = new Set(['secure']);

interface ExportedFile {
    path: string;
    content: string;
}

async function collectFiles(dir: string, base: string): Promise<ExportedFile[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: ExportedFile[] = [];

    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(base, full);

        if (entry.isDirectory()) {
            if (EXCLUDED_DIRS.has(entry.name)) continue;
            files.push(...await collectFiles(full, base));
        } else if (/\.(json|md)$/i.test(entry.name)) {
            files.push({ path: rel, content: await fs.readFile(full, 'utf-8') });
        }
    }
    return files;
}

/**
 * Full workspace backup as a single JSON document (docs, tasks, canvas,
 * chat, calendar, settings — everything under data/ except data/secure).
 */
export async function GET() {
    try {
        const files = await collectFiles(DATA_DIR, DATA_DIR);
        const payload = {
            format: 'open-workspace-backup',
            version: 1,
            exportedAt: new Date().toISOString(),
            files,
        };

        const filename = `open-workspace-backup-${new Date().toISOString().slice(0, 10)}.json`;
        return new NextResponse(JSON.stringify(payload, null, 2), {
            headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="${filename}"`,
                'X-Content-Type-Options': 'nosniff',
            },
        });
    } catch (error) {
        console.error('Export error:', error);
        return NextResponse.json({ error: 'Export fehlgeschlagen.' }, { status: 500 });
    }
}
