import { NextResponse } from 'next/server';
import { checkHealth, getModels, getEffectiveConfig } from '@/lib/inference';

export async function GET() {
    const config = await getEffectiveConfig();
    try {
        const isHealthy = await checkHealth();

        if (!isHealthy) {
            return NextResponse.json({
                status: 'offline',
                endpoint: config.endpoint,
                model: config.model,
                models: [],
            });
        }

        const models = await getModels();

        return NextResponse.json({
            status: 'online',
            endpoint: config.endpoint,
            model: config.model,
            models,
        });
    } catch (error) {
        return NextResponse.json({
            status: 'error',
            endpoint: config.endpoint,
            model: config.model,
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
}
