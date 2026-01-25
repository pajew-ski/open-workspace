'use client';

import { AppShell } from '@/components/layout';
import { Card, CardHeader, CardContent } from '@/components/ui';
import { ToolsConfig } from './ToolsConfig';

export default function ToolsPage() {
    return (
        <AppShell title="Werkzeuge">
            <Card>
                <CardHeader>
                    <h3>Konfiguration</h3>
                </CardHeader>
                <CardContent>
                    <ToolsConfig />
                </CardContent>
            </Card>
        </AppShell>
    );
}
