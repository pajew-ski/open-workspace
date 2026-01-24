import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'images');

export async function GET(request: NextRequest, { params }: { params: Promise<{ filename: string }> }) {
    try {
        const { filename } = await params;
        const filepath = path.join(UPLOAD_DIR, filename);

        try {
            const fileBuffer = await fs.readFile(filepath);
            // Determine content type roughly
            const ext = path.extname(filename).toLowerCase();
            let contentType = 'image/jpeg';
            if (ext === '.png') contentType = 'image/png';
            if (ext === '.gif') contentType = 'image/gif';
            if (ext === '.webp') contentType = 'image/webp';
            if (ext === '.svg') contentType = 'image/svg+xml';

            return new NextResponse(fileBuffer, {
                headers: {
                    'Content-Type': contentType,
                    'Cache-Control': 'public, max-age=31536000, immutable'
                }
            });
        } catch (e) {
            return NextResponse.json({ error: 'Bild nicht gefunden' }, { status: 404 });
        }
    } catch (error) {
        return NextResponse.json({ error: 'Fehler beim Laden' }, { status: 500 });
    }
}
