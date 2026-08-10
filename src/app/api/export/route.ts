/**
 * Vollständiges Backup als ein JSON-Dokument.
 *
 * Seit M13 nutzerskaliert (SPEC §17.4, „Export und Git-Sync"): **Der
 * Export eines Nutzers enthält nur dessen Dataset.** Konkret heißt das
 *
 *  - immer die eigene Workspace-Projektion (`data/docs|tasks|canvas` für
 *    den Einzelnutzer, `data/u/<id>/…` für jeden weiteren Nutzer),
 *  - zusätzlich die instanzweiten Bestände (Einstellungen, Chats,
 *    Kalender, AI-Konfiguration) **nur für Verwalter** — sie gehören der
 *    Installation, nicht einem einzelnen Nutzer, und ein Nutzer ohne
 *    `control` bekommt sie nicht,
 *  - **nie** `data/secure` (Geheimnisse) und nie `data/graph` — der
 *    Snapshot ist der Weg des Git-Syncs, nicht des Nutzer-Exports.
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { DEFAULT_USER_ID } from '@/lib/graph/iri';
import { currentIdentity } from '@/lib/graph/server/context';
import { adminUsers } from '@/lib/graph/server/instance';
import { exportScopeFor } from '@/lib/graph/workspace/export';

const DATA_DIR = path.join(process.cwd(), 'data');

interface ExportedFile {
    path: string;
    content: string;
}

async function collectFiles(dir: string, base: string): Promise<ExportedFile[]> {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const files: ExportedFile[] = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(base, full);
        if (entry.isDirectory()) {
            files.push(...await collectFiles(full, base));
        } else if (/\.(json|md)$/i.test(entry.name)) {
            files.push({ path: rel, content: await fs.readFile(full, 'utf-8') });
        }
    }
    return files;
}

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const identity = await currentIdentity();
        const userId = identity.userId || DEFAULT_USER_ID;
        const isAdmin = adminUsers().includes(userId);
        const scope = exportScopeFor(userId, isAdmin, DATA_DIR);

        const seen = new Set<string>();
        const files: ExportedFile[] = [];
        for (const target of scope.directories) {
            for (const file of await collectFiles(target, DATA_DIR)) {
                if (seen.has(file.path)) continue;
                seen.add(file.path);
                files.push(file);
            }
        }
        files.sort((a, b) => a.path.localeCompare(b.path));

        const payload = {
            format: 'open-workspace-backup',
            version: 1,
            exportedAt: new Date().toISOString(),
            user: userId,
            /** Was NICHT drin ist — damit niemand ein Vollbackup vermutet. */
            scope: scope.description,
            files,
        };

        const filename = `open-workspace-backup-${userId}-${new Date().toISOString().slice(0, 10)}.json`;
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
