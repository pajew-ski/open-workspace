import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'images');

// Ensure dir exists
async function ensureDir() {
    try {
        await fs.access(UPLOAD_DIR);
    } catch {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
    }
}

export async function POST(request: NextRequest) {
    try {
        await ensureDir();

        const formData = await request.formData();
        const file = formData.get('file') as File;

        if (!file) {
            return NextResponse.json({ error: 'Keine Datei' }, { status: 400 });
        }

        // Validate type
        if (!file.type.startsWith('image/')) {
            return NextResponse.json({ error: 'Nur Bilder erlaubt' }, { status: 400 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const filename = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '')}`;
        const filepath = path.join(UPLOAD_DIR, filename);

        await fs.writeFile(filepath, buffer);

        return NextResponse.json({
            url: `/api/images/${filename}`,
            filename
        });
    } catch (error) {
        console.error('Image upload error:', error);
        return NextResponse.json({ error: 'Upload fehlgeschlagen' }, { status: 500 });
    }
}
