import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const UPLOAD_DIR = path.resolve(process.cwd(), 'data', 'images');

/** 10 MB upload limit */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp';

/** Allowed extensions and the magic-byte family they must match. SVG is deliberately NOT allowed (XSS). */
const ALLOWED_EXTENSIONS: Record<string, ImageKind> = {
    png: 'png',
    jpg: 'jpeg',
    jpeg: 'jpeg',
    webp: 'webp',
    gif: 'gif',
};

/**
 * Detect the real image type from magic bytes instead of trusting the
 * client-provided MIME type or file extension.
 */
function detectImageKind(buffer: Buffer): ImageKind | null {
    // PNG: \x89PNG
    if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return 'png';
    }
    // JPEG: \xFF\xD8\xFF
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'jpeg';
    }
    // GIF87a / GIF89a
    if (buffer.length >= 6) {
        const head = buffer.subarray(0, 6).toString('latin1');
        if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
    }
    // WEBP: RIFF....WEBP
    if (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
        buffer.subarray(8, 12).toString('latin1') === 'WEBP'
    ) {
        return 'webp';
    }
    return null;
}

function jsonResponse(payload: unknown, status = 200): NextResponse {
    return NextResponse.json(payload as Record<string, unknown>, {
        status,
        headers: { 'X-Content-Type-Options': 'nosniff' },
    });
}

// Ensure dir exists
async function ensureDir() {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

export async function POST(request: NextRequest) {
    try {
        await ensureDir();

        const formData = await request.formData();
        const file = formData.get('file');

        if (!(file instanceof File)) {
            return jsonResponse({ error: 'Keine Datei' }, 400);
        }

        // 1. Size limit
        if (file.size > MAX_FILE_SIZE) {
            return jsonResponse({ error: 'Datei zu groß (max. 10 MB)' }, 413);
        }

        // 2. Extension allowlist (rejects .svg and everything else)
        const originalExt = path.extname(file.name).toLowerCase().replace('.', '');
        const expectedKind = ALLOWED_EXTENSIONS[originalExt];
        if (!expectedKind) {
            return jsonResponse({ error: 'Nur PNG, JPEG, WebP oder GIF erlaubt' }, 400);
        }

        // 3. Magic-byte check: the content must really be the claimed image type
        const buffer = Buffer.from(await file.arrayBuffer());
        const actualKind = detectImageKind(buffer);
        if (!actualKind) {
            return jsonResponse({ error: 'Dateiinhalt ist kein unterstütztes Bildformat' }, 400);
        }
        if (actualKind !== expectedKind) {
            return jsonResponse({ error: 'Dateiendung passt nicht zum Dateiinhalt' }, 400);
        }

        // 4. Path-safe filename: sanitized base name + verified extension
        const base = path.basename(file.name, path.extname(file.name))
            .replace(/[^a-zA-Z0-9._-]/g, '')
            .replace(/\.{2,}/g, '.')
            .slice(0, 100) || 'upload';
        const filename = `${Date.now()}-${base}.${originalExt}`;
        const filepath = path.resolve(UPLOAD_DIR, filename);

        // Defense in depth: never write outside the upload directory
        if (!filepath.startsWith(UPLOAD_DIR + path.sep)) {
            return jsonResponse({ error: 'Ungültiger Dateiname' }, 400);
        }

        await fs.writeFile(filepath, buffer);

        return jsonResponse({
            url: `/api/images/${filename}`,
            filename
        });
    } catch (error) {
        console.error('Image upload error:', error);
        return jsonResponse({ error: 'Upload fehlgeschlagen' }, 500);
    }
}
