import { AppShell } from '@/components/layout';
import { Card, CardHeader, CardContent } from '@/components/ui';
import styles from './page.module.css';

export default function DashboardPage() {
  return (
    <AppShell title="Übersicht">
      <div className={styles.grid}>
        <Card elevated className={styles.welcome}>
          <CardHeader>
            <h2>Willkommen im Open Workspace</h2>
          </CardHeader>
          <CardContent>
            <p>
              Dein zentraler Arbeitsbereich für AI-gestützte Produktivität.
              Nutze die Navigation links, um zwischen den Modulen zu wechseln.
            </p>
          </CardContent>
        </Card>

        <Card className={styles.stats}>
          <CardHeader>
            <h3>Schnellübersicht</h3>
          </CardHeader>
          <CardContent>
            <div className={styles.statGrid}>
              <div className={styles.stat}>
                <span className={styles.statValue}>0</span>
                <span className={styles.statLabel}>Notizen</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statValue}>0</span>
                <span className={styles.statLabel}>Aufgaben</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statValue}>0</span>
                <span className={styles.statLabel}>Pinnwand-Karten</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statValue}>0</span>
                <span className={styles.statLabel}>Artefakte</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={styles.recent}>
          <CardHeader>
            <h3>Letzte Aktivitäten</h3>
          </CardHeader>
          <CardContent>
            <p className={styles.empty}>Keine aktuellen Aktivitäten</p>
          </CardContent>
        </Card>

        <Card className={styles.quick}>
          <CardHeader>
            <h3>Schnellzugriff</h3>
          </CardHeader>
          <CardContent>
            <ul className={styles.quickList}>
              <li>Drücke Cmd+K für die globale Suche</li>
              <li>Nutze das Chat-Widget für AI-Unterstützung</li>
              <li>Erstelle Notizen in der Wissensbasis</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
