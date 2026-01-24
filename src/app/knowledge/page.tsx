import { AppShell } from '@/components/layout';
import { Card, CardHeader, CardContent, Button } from '@/components/ui';
import styles from './page.module.css';

export default function KnowledgePage() {
    return (
        <AppShell title="Wissensbasis">
            <div className={styles.container}>
                <div className={styles.header}>
                    <div>
                        <h2>Notizen und Dokumente</h2>
                        <p>Verwalte deine Wissensbasis mit Markdown-Notizen, Code-Fragmenten und Artefakten.</p>
                    </div>
                    <Button variant="primary">+ Neue Notiz</Button>
                </div>

                <div className={styles.content}>
                    <Card className={styles.sidebar}>
                        <CardHeader>
                            <h3>Kategorien</h3>
                        </CardHeader>
                        <CardContent>
                            <ul className={styles.categories}>
                                <li className={styles.active}>Alle Notizen</li>
                                <li>Dokumente</li>
                                <li>Code-Fragmente</li>
                                <li>Artefakte</li>
                                <li>Links</li>
                            </ul>
                        </CardContent>
                    </Card>

                    <div className={styles.main}>
                        <Card elevated>
                            <CardContent>
                                <div className={styles.empty}>
                                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                                        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                                    </svg>
                                    <h3>Keine Notizen vorhanden</h3>
                                    <p>Erstelle deine erste Notiz, um deine Wissensbasis aufzubauen.</p>
                                    <Button variant="primary">+ Neue Notiz erstellen</Button>
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </div>
        </AppShell>
    );
}
