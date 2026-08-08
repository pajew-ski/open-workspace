import { AppShell } from '@/components/layout';
import { Card, CardContent } from '@/components/ui';
import styles from './page.module.css';

/**
 * Matrix chat is on the roadmap but not implemented yet. This page states
 * that honestly instead of rendering non-functional buttons and inputs.
 */
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
                    <Card className={styles.chatArea} elevated>
                        <CardContent>
                            <div className={styles.chatEmpty}>
                                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                                </svg>
                                <h3>Matrix-Integration geplant</h3>
                                <p>
                                    Dieses Modul ist in Vorbereitung: Anbindung an einen
                                    Matrix-Homeserver mit Räumen, Direktnachrichten und
                                    Ende-zu-Ende-Verschlüsselung.
                                </p>
                                <p>
                                    Den aktuellen Stand findest du in der Roadmap
                                    (<code>TODO.md</code>). Bis dahin erreichst du deinen
                                    persönlichen Assistenten jederzeit über das
                                    Chat-Widget unten rechts.
                                </p>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </AppShell>
    );
}
