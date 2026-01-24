import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui';
import styles from './page.module.css';

export default function CanvasPage() {
    return (
        <AppShell title="Canvas">
            <div className={styles.container}>
                <div className={styles.toolbar}>
                    <div className={styles.tools}>
                        <Button variant="ghost" size="sm">Karte hinzufügen</Button>
                        <Button variant="ghost" size="sm">Verbindung erstellen</Button>
                        <Button variant="ghost" size="sm">Zoom zurücksetzen</Button>
                    </div>
                    <Button variant="primary">+ Neue Karte</Button>
                </div>

                <div className={styles.canvas}>
                    <div className={styles.empty}>
                        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <path d="M3 9h18" />
                            <path d="M9 21V9" />
                        </svg>
                        <h2>Leeres Canvas</h2>
                        <p>
                            Beginne mit der visuellen Planung, indem du Karten erstellst
                            und diese miteinander verbinden.
                        </p>
                        <Button variant="primary">Erste Karte erstellen</Button>
                    </div>
                </div>
            </div>
        </AppShell>
    );
}
