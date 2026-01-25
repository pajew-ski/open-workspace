'use client';

import { Card, CardContent, Button } from '@/components/ui';
import styles from './ToolsConfig.module.css';

export function ToolsConfig() {
    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.info}>
                    <span className={styles.label}>MCP Server</span>
                    <span className={styles.description}>
                        Konfiguriere Model Context Protocol (MCP) Server für erweiterte Agenten-Funktionen.
                    </span>
                </div>
                <Button variant="primary" size="sm">+ Server verbinden</Button>
            </div>

            <Card className={styles.serverList}>
                <CardContent>
                    <div className={styles.emptyState}>
                        <p>Keine MCP Server konfiguriert.</p>
                        <p className={styles.emptySub}>Verbinde einen Server, um Tools bereitzustellen.</p>
                    </div>
                </CardContent>
            </Card>

            <div className={styles.header} style={{ marginTop: 'var(--space-6)' }}>
                <div className={styles.info}>
                    <span className={styles.label}>API Integrationen</span>
                    <span className={styles.description}>
                        Verbinde externe APIs (z.B. OpenAI, Anthropic, Search), um sie als Tools zu nutzen.
                    </span>
                </div>
                <Button variant="primary" size="sm">+ API verbinden</Button>
            </div>

            <Card className={styles.serverList}>
                <CardContent>
                    <div className={styles.emptyState}>
                        <p>Keine APIs konfiguriert.</p>
                        <p className={styles.emptySub}>Füge API-Keys hinzu, um externe Dienste anzubinden.</p>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
