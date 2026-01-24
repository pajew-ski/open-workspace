import { AppShell } from '@/components/layout';
import { Card, CardHeader, CardContent, Button } from '@/components/ui';
import styles from './page.module.css';

export default function TasksPage() {
    return (
        <AppShell title="Aufgaben">
            <div className={styles.container}>
                <div className={styles.header}>
                    <div>
                        <h2>Aufgaben und Projekte</h2>
                        <p>Verwalte deine Aufgaben und behalte den Fortschritt im Blick.</p>
                    </div>
                    <Button variant="primary">+ Neue Aufgabe</Button>
                </div>

                <div className={styles.columns}>
                    <Card className={styles.column}>
                        <CardHeader>
                            <div className={styles.columnHeader}>
                                <h3>Offen</h3>
                                <span className={styles.count}>0</span>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className={styles.emptyColumn}>
                                <p>Keine offenen Aufgaben</p>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className={styles.column}>
                        <CardHeader>
                            <div className={styles.columnHeader}>
                                <h3>In Bearbeitung</h3>
                                <span className={styles.count}>0</span>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className={styles.emptyColumn}>
                                <p>Keine Aufgaben in Bearbeitung</p>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className={styles.column}>
                        <CardHeader>
                            <div className={styles.columnHeader}>
                                <h3>Erledigt</h3>
                                <span className={styles.count}>0</span>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className={styles.emptyColumn}>
                                <p>Keine erledigten Aufgaben</p>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </AppShell>
    );
}
