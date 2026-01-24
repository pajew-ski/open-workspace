import { AppShell } from '@/components/layout';
import { Card, CardHeader, CardContent, Button } from '@/components/ui';
import { ThemeSelector } from './ThemeSelector';
import styles from './page.module.css';

// Force dynamic rendering to use ThemeProvider context
export const dynamic = 'force-dynamic';

export default function SettingsPage() {
    return (
        <AppShell title="Einstellungen">
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
                        <h3>Sprache</h3>
                    </CardHeader>
                    <CardContent>
                        <div className={styles.setting}>
                            <div className={styles.settingInfo}>
                                <span className={styles.settingLabel}>Anzeigesprache</span>
                                <span className={styles.settingDescription}>
                                    Wähle die Sprache der Benutzeroberfläche
                                </span>
                            </div>
                            <div className={styles.themeButtons}>
                                <Button variant="primary" size="sm">Deutsch</Button>
                                <Button variant="secondary" size="sm">English</Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <h3>AI-Konfiguration</h3>
                    </CardHeader>
                    <CardContent>
                        <div className={styles.setting}>
                            <div className={styles.settingInfo}>
                                <span className={styles.settingLabel}>Inference-Endpunkt</span>
                                <span className={styles.settingDescription}>
                                    URL des lokalen oder entfernten AI-Servers
                                </span>
                            </div>
                            <div className={styles.inputGroup}>
                                <input
                                    type="text"
                                    className={styles.input}
                                    defaultValue="http://192.168.42.2:11434"
                                    placeholder="http://localhost:11434"
                                />
                            </div>
                        </div>
                        <div className={styles.setting}>
                            <div className={styles.settingInfo}>
                                <span className={styles.settingLabel}>Modell</span>
                                <span className={styles.settingDescription}>
                                    Name des zu verwendenden AI-Modells
                                </span>
                            </div>
                            <div className={styles.inputGroup}>
                                <input
                                    type="text"
                                    className={styles.input}
                                    defaultValue="gpt-oss-20"
                                    placeholder="llama3"
                                />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <h3>GitHub-Synchronisierung</h3>
                    </CardHeader>
                    <CardContent>
                        <div className={styles.setting}>
                            <div className={styles.settingInfo}>
                                <span className={styles.settingLabel}>Repository verbinden</span>
                                <span className={styles.settingDescription}>
                                    Synchronisiere deine Notizen und Artefakte mit GitHub
                                </span>
                            </div>
                            <Button variant="secondary" size="sm">Mit GitHub verbinden</Button>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </AppShell>
    );
}
