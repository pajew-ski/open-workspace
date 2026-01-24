import { NextResponse } from 'next/server';
import { checkHealth, getModels, DEFAULT_CONFIG } from '@/lib/inference';

export async function GET() {
    try {
        const isHealthy = await checkHealth();

        if (!isHealthy) {
            return NextResponse.json({
                status: 'offline',
                endpoint: DEFAULT_CONFIG.endpoint,
                model: DEFAULT_CONFIG.model,
                models: [],
            });
        }

        const models = await getModels();

        return NextResponse.json({
            status: 'online',
            endpoint: DEFAULT_CONFIG.endpoint,
            model: DEFAULT_CONFIG.model,
            models,
        });
    } catch (error) {
        return NextResponse.json({
            status: 'error',
            endpoint: DEFAULT_CONFIG.endpoint,
            model: DEFAULT_CONFIG.model,
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
}
