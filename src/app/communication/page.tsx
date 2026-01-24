import { AppShell } from '@/components/layout';
import { Card, CardHeader, CardContent, Button } from '@/components/ui';
import styles from './page.module.css';

export default function CommunicationPage() {
    return (
        <AppShell title="Kommunikation">
            <div className={styles.container}>
                <div className={styles.header}>
                    <div>
                        <h2>Kommunikation</h2>
                        <p>Matrix-Protokoll Chat für sichere Kommunikation mit deinem Team.</p>
                    </div>
                </div>

                <div className={styles.content}>
                    <Card className={styles.roomList}>
                        <CardHeader>
                            <div className={styles.roomHeader}>
                                <h3>Räume</h3>
                                <Button variant="ghost" size="sm">+</Button>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className={styles.rooms}>
                                <div className={styles.roomEmpty}>
                                    <p>Keine Räume vorhanden</p>
                                    <Button variant="secondary" size="sm">Matrix verbinden</Button>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className={styles.chatArea} elevated>
                        <CardContent>
                            <div className={styles.chatEmpty}>
                                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                                </svg>
                                <h3>Matrix Chat</h3>
                                <p>
                                    Verbinde dich mit einem Matrix-Server, um mit deinem Team
                                    zu kommunizieren. Der Chat unterstützt Ende-zu-Ende-Verschlüsselung.
                                </p>
                                <div className={styles.chatActions}>
                                    <Button variant="primary">Mit Matrix verbinden</Button>
                                    <Button variant="secondary">Server hinzufügen</Button>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                <Card>
                    <CardHeader>
                        <h3>Matrix-Konfiguration</h3>
                    </CardHeader>
                    <CardContent>
                        <div className={styles.configGrid}>
                            <div className={styles.configItem}>
                                <span className={styles.configLabel}>Homeserver</span>
                                <input
                                    type="text"
                                    className={styles.input}
                                    placeholder="https://matrix.example.org"
                                />
                            </div>
                            <div className={styles.configItem}>
                                <span className={styles.configLabel}>Benutzername</span>
                                <input
                                    type="text"
                                    className={styles.input}
                                    placeholder="@user:matrix.example.org"
                                />
                            </div>
                            <div className={styles.configItem}>
                                <span className={styles.configLabel}>Status</span>
                                <span className={styles.statusBadge}>Nicht verbunden</span>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </AppShell>
    );
}
