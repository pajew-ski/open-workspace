import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { loadSettings, saveSettings } from '@/lib/settings';

const UpdateSettingsSchema = z.object({
    inference: z
        .object({
            endpoint: z.string().url().max(500).or(z.literal('')),
            model: z.string().max(200),
        })
        .partial()
        .optional(),
});

export async function GET() {
    try {
        const settings = await loadSettings();
        return NextResponse.json({ settings });
    } catch (error) {
        console.error('Settings GET error:', error);
        return NextResponse.json({ error: 'Einstellungen konnten nicht geladen werden.' }, { status: 500 });
    }
}

export async function PUT(request: NextRequest) {
    try {
        const body = await request.json();
        const parsed = UpdateSettingsSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json(
                { error: 'Ungültige Einstellungen.', details: parsed.error.flatten() },
                { status: 400 }
            );
        }
        const settings = await saveSettings({ inference: parsed.data.inference });
        return NextResponse.json({ settings });
    } catch (error) {
        console.error('Settings PUT error:', error);
        return NextResponse.json({ error: 'Einstellungen konnten nicht gespeichert werden.' }, { status: 500 });
    }
}
