import { AppShell } from '@/components/layout';
import { Card, CardHeader, CardContent } from '@/components/ui';
import { ThemeSelector } from './ThemeSelector';
import { CalendarSettings } from './CalendarSettings';
import { AISettings } from './AISettings';
import styles from './page.module.css';

// Force dynamic rendering to use ThemeProvider context
export const dynamic = 'force-dynamic';

export default function SettingsPage() {
    return (
        <AppShell title="Einstellungen" fluid={true}>
            <div className={styles.container}>
                <Card>
                    <CardHeader>
                        <h3>Erscheinungsbild</h3>
                    </CardHeader>
                    <CardContent>
                        <div className={styles.setting}>
                            <div className={styles.settingInfo}>
                                <span className={styles.settingLabel}>Farbschema</span>
                                <span className={styles.settingDescription}>
                                    Wähle zwischen hellem und dunklem Modus
                                </span>
                            </div>
                            <ThemeSelector />
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <h3>AI-Konfiguration</h3>
                    </CardHeader>
                    <CardContent>
                        <AISettings />
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <h3>Kalender</h3>
                    </CardHeader>
                    <CardContent>
                        <CalendarSettings />
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <h3>Daten</h3>
                    </CardHeader>
                    <CardContent>
                        <div className={styles.setting}>
                            <div className={styles.settingInfo}>
                                <span className={styles.settingLabel}>Workspace sichern</span>
                                <span className={styles.settingDescription}>
                                    Lädt alle Dokumente, Aufgaben, Pinnwände und Einstellungen
                                    als JSON-Backup herunter (ohne gespeicherte Zugangsdaten)
                                </span>
                            </div>
                            <a href="/api/export" download className={styles.exportButton}>
                                Backup herunterladen
                            </a>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </AppShell>
    );
}
