import { AppShell } from '@/components/layout';
import { Card, CardHeader, CardContent } from '@/components/ui';
import styles from './page.module.css';

export default function DashboardPage() {
  return (
    <AppShell title="Dashboard">
      <div className={styles.grid}>
        <Card elevated className={styles.welcome}>
          <CardHeader>
            <h2>Willkommen im AI Workspace</h2>
          </CardHeader>
          <CardContent>
            <p>
              Ihr zentraler Arbeitsbereich fuer AI-gestuetzte Produktivitaet.
              Nutzen Sie die Navigation links, um zwischen den Modulen zu wechseln.
            </p>
          </CardContent>
        </Card>

        <Card className={styles.stats}>
          <CardHeader>
            <h3>Schnelluebersicht</h3>
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
                <span className={styles.statLabel}>Canvas-Karten</span>
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
            <h3>Letzte Aktivitaeten</h3>
          </CardHeader>
          <CardContent>
            <p className={styles.empty}>Keine aktuellen Aktivitaeten</p>
          </CardContent>
        </Card>

        <Card className={styles.quick}>
          <CardHeader>
            <h3>Schnellzugriff</h3>
          </CardHeader>
          <CardContent>
            <ul className={styles.quickList}>
              <li>Druecken Sie Cmd+K fuer die globale Suche</li>
              <li>Nutzen Sie das Chat-Widget fuer AI-Unterstuetzung</li>
              <li>Erstellen Sie Notizen in der Wissensbasis</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
