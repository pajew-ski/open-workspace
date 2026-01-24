import { AppShell } from '@/components/layout';
import { Card, CardHeader, CardContent, Button } from '@/components/ui';
import styles from './page.module.css';

export default function AgentsPage() {
    return (
        <AppShell title="Agenten">
            <div className={styles.container}>
                <div className={styles.header}>
                    <div>
                        <h2>AI Agenten</h2>
                        <p>Verwalte deine Agent2Agent (A2A) Agenten und deren Fähigkeiten.</p>
                    </div>
                    <Button variant="primary">+ Neuer Agent</Button>
                </div>

                <div className={styles.grid}>
                    <Card elevated>
                        <CardHeader>
                            <h3>Aktive Agenten</h3>
                        </CardHeader>
                        <CardContent>
                            <div className={styles.empty}>
                                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <circle cx="12" cy="8" r="5" />
                                    <path d="M3 21v-2a7 7 0 0 1 7-7h4a7 7 0 0 1 7 7v2" />
                                </svg>
                                <h4>Keine Agenten konfiguriert</h4>
                                <p>Erstelle deinen ersten A2A-Agenten, um mit der Automatisierung zu beginnen.</p>
                                <Button variant="primary">Ersten Agenten erstellen</Button>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <h3>Agent-Konfiguration</h3>
                        </CardHeader>
                        <CardContent>
                            <div className={styles.configItem}>
                                <span className={styles.configLabel}>Inference-Endpunkt</span>
                                <span className={styles.configValue}>192.168.42.2:11434</span>
                            </div>
                            <div className={styles.configItem}>
                                <span className={styles.configLabel}>Standard-Modell</span>
                                <span className={styles.configValue}>gpt-oss-20</span>
                            </div>
                            <div className={styles.configItem}>
                                <span className={styles.configLabel}>A2A-Protokoll</span>
                                <span className={styles.configValue}>Aktiviert</span>
                            </div>
                            <div className={styles.configItem}>
                                <span className={styles.configLabel}>MCP-Server</span>
                                <span className={styles.configValue}>Bereit</span>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <h3>Agent-Fähigkeiten</h3>
                        </CardHeader>
                        <CardContent>
                            <ul className={styles.capabilities}>
                                <li>Wissensbasis-Zugriff</li>
                                <li>Canvas-Bearbeitung</li>
                                <li>Aufgaben-Verwaltung</li>
                                <li>Code-Generierung</li>
                                <li>Dokumenten-Analyse</li>
                            </ul>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </AppShell>
    );
}
