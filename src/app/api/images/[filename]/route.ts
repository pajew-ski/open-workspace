import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const UPLOAD_DIR = path.resolve(process.cwd(), 'data', 'images');

// Strict allowlist: letters, digits, dot, underscore, dash. No path separators.
const FILENAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

const CONTENT_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
};

function jsonError(message: string, status: number): NextResponse {
    return NextResponse.json(
        { error: message },
        { status, headers: { 'X-Content-Type-Options': 'nosniff' } }
    );
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ filename: string }> }) {
    try {
        const { filename } = await params;

        // 1. Strict character allowlist, explicit rejection of '..'
        if (!filename || !FILENAME_PATTERN.test(filename) || filename.includes('..')) {
            return jsonError('Ungültiger Dateiname', 400);
        }

        // 2. Defense in depth: resolved path must stay inside UPLOAD_DIR
        const filepath = path.resolve(UPLOAD_DIR, filename);
        if (!filepath.startsWith(UPLOAD_DIR + path.sep)) {
            return jsonError('Ungültiger Dateiname', 400);
        }

        try {
            const fileBuffer = await fs.readFile(filepath);
            const ext = path.extname(filename).toLowerCase();
            const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';

            const headers: Record<string, string> = {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=31536000, immutable',
                // Never let browsers content-sniff their way into executing markup
                'X-Content-Type-Options': 'nosniff',
            };

            // SVG can contain scripts - force download instead of inline rendering
            if (ext === '.svg') {
                headers['Content-Disposition'] = `attachment; filename="${filename}"`;
            }

            return new NextResponse(new Uint8Array(fileBuffer), { headers });
        } catch {
            return jsonError('Bild nicht gefunden', 404);
        }
    } catch (error) {
        console.error('Image serve error:', error);
        return jsonError('Fehler beim Laden', 500);
    }
}
