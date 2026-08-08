'use client';

import Link from 'next/link';
import { useAIState, useBackendAvailability } from '@/lib/ai/useAI';
import { getPreset } from '@/lib/ai/presets';
import styles from './page.module.css';

/**
 * Compact AI summary in the settings — the full provider management
 * lives in the AI-Hub (/ai): multi-provider, routing (browser/server),
 * WebLLM, diagnostics.
 */
export function AISettings() {
    const { data: state } = useAIState();
    const backend = useBackendAvailability();

    const providers = state?.providers ?? [];
    const enabled = providers.filter(p => p.enabled);
    const defaultProvider = providers.find(p => p.id === state?.defaults.providerId);

    return (
        <>
            <div className={styles.setting}>
                <div className={styles.settingInfo}>
                    <span className={styles.settingLabel}>Inference-Provider</span>
                    <span className={styles.settingDescription}>
                        {enabled.length === 0
                            ? 'Noch kein Provider eingerichtet — Cloud-APIs, lokale Engines (Ollama, LM Studio, …) und WebLLM im Browser werden unterstützt.'
                            : `${enabled.length} aktiv${defaultProvider ? ` — Standard: ${defaultProvider.label} (${getPreset(defaultProvider.kind).label})${state?.defaults.model ? ` · ${state.defaults.model}` : ''}` : ''}`}
                    </span>
                </div>
                <Link href="/ai" className={styles.exportButton}>
                    AI-Hub öffnen
                </Link>
            </div>
            <div className={styles.setting}>
                <div className={styles.settingInfo}>
                    <span className={styles.settingLabel}>Backend-Status</span>
                    <span className={styles.settingDescription}>
                        {backend === 'available'
                            ? 'Workspace-Backend verbunden — Server-gespeicherte Schlüssel und Server-Routen verfügbar.'
                            : backend === 'unavailable'
                                ? 'Serverloser Modus — die AI-Schicht läuft vollständig im Browser (Direktverbindungen, lokale Konfiguration, IndexedDB-Chats).'
                                : 'Prüfe Backend-Erreichbarkeit…'}
                    </span>
                </div>
            </div>
        </>
    );
}
