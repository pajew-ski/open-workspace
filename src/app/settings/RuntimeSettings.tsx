'use client';

import { useCallback, useEffect, useState } from 'react';
import { readStorageStatus, requestPersistentStorage, type StorageStatus } from '@/lib/platform/runtime/opfs';
import styles from './page.module.css';

/**
 * Laufzeitumgebung und Browser-Speicher (SPEC §5.2/§8.3, M12).
 *
 * Zwei Fragen, die man vor jedem Vertrauen in eine Installation stellt:
 * Was ist das hier für eine Laufzeit und was kann sie? Und: sind die Daten,
 * die der Browser hält, vor dem Aufräumen geschützt?
 *
 * Beides wird gelesen und angezeigt, nichts wird behauptet: Fähigkeiten
 * kommen aus dem RuntimeAdapter, der Speicher-Zustand aus der Storage-API.
 */

interface RuntimeInfo {
    runtime: 'local' | 'ha-addon' | 'server';
    capabilities: {
        sparqlEndpoint: boolean;
        mcpServer: boolean;
        federationOutbound: boolean;
        federationInbound: boolean;
        multiUser: boolean;
        reasoningTier: 'rl' | 'rl+dl';
        causalTier: 'none' | 'graph' | 'full';
    };
    basePath: string;
    ingress: { active: boolean; basePath: string | null };
    identity: {
        mode: 'single-user' | 'ha-ingress' | 'proxy-header' | 'oidc-bearer';
        authenticated: boolean;
        userId: string;
        displayName: string | null;
        groups: string[];
        reason: string | null;
    };
}

const RUNTIME_LABEL: Record<RuntimeInfo['runtime'], string> = {
    local: 'Browser (local)',
    'ha-addon': 'Home-Assistant-Add-on',
    server: 'Server',
};

const IDENTITY_LABEL: Record<RuntimeInfo['identity']['mode'], string> = {
    'single-user': 'Einzelnutzer ohne Anmeldung',
    'ha-ingress': 'Home Assistant (Ingress)',
    'proxy-header': 'Vorgelagerter Anmelde-Proxy (OIDC)',
    'oidc-bearer': 'OIDC-Token der Anfrage',
};

function formatBytes(value: number | null): string {
    if (value === null) return 'unbekannt';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
    }
    return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function RuntimeSettings() {
    const [info, setInfo] = useState<RuntimeInfo | null>(null);
    const [backendReachable, setBackendReachable] = useState<boolean | null>(null);
    const [storage, setStorage] = useState<StorageStatus | null>(null);
    const [requesting, setRequesting] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const response = await fetch('/api/runtime', { cache: 'no-store' });
                if (!response.ok) throw new Error(String(response.status));
                const payload = (await response.json()) as RuntimeInfo;
                if (!cancelled) {
                    setInfo(payload);
                    setBackendReachable(true);
                }
            } catch {
                if (!cancelled) setBackendReachable(false);
            }
            const status = await readStorageStatus();
            if (!cancelled) setStorage(status);
        })();
        return () => { cancelled = true; };
    }, []);

    const onRequestPersistence = useCallback(async () => {
        setRequesting(true);
        await requestPersistentStorage();
        setStorage(await readStorageStatus());
        setRequesting(false);
    }, []);

    const capabilityText = info
        ? [
            info.capabilities.sparqlEndpoint ? 'SPARQL-Endpoint' : null,
            info.capabilities.mcpServer ? 'MCP-Server' : null,
            info.capabilities.federationOutbound ? 'Föderation ausgehend' : null,
            info.capabilities.federationInbound ? 'Föderation eingehend' : null,
            info.capabilities.multiUser ? 'Mehrbenutzerbetrieb' : null,
            `Reasoning ${info.capabilities.reasoningTier.toUpperCase()}`,
            // Invariante C9: Was die Runtime kausal kann, steht hier —
            // „graph" heißt Identifikation ohne Schätzung (C1).
            info.capabilities.causalTier === 'graph' ? 'Kausal: Identifikation'
                : info.capabilities.causalTier === 'full' ? 'Kausal: Identifikation + Schätzung'
                    : null,
        ].filter(Boolean).join(' · ')
        : '';

    return (
        <>
            <div className={styles.setting}>
                <div className={styles.settingInfo}>
                    <span className={styles.settingLabel}>Laufzeitumgebung</span>
                    <span className={styles.settingDescription}>
                        {backendReachable === false
                            ? 'Kein Workspace-Backend erreichbar — die App läuft im Browser weiter (serverloser Modus).'
                            : info
                                ? `${RUNTIME_LABEL[info.runtime]}${info.ingress.active ? ` · über Home-Assistant-Ingress unter ${info.ingress.basePath}` : info.basePath ? ` · Unterpfad ${info.basePath}` : ''} — ${capabilityText}`
                                : 'Wird ermittelt…'}
                    </span>
                </div>
            </div>

            <div className={styles.setting}>
                <div className={styles.settingInfo}>
                    <span className={styles.settingLabel}>Anmeldung</span>
                    <span className={styles.settingDescription}>
                        {backendReachable === false
                            ? 'Ohne Backend gibt es kein Anmeldeverfahren.'
                            : info
                                ? info.identity.authenticated
                                    ? `${IDENTITY_LABEL[info.identity.mode]} — angemeldet als ${info.identity.displayName ?? info.identity.userId}${info.identity.groups.length > 0 ? ` (${info.identity.groups.join(', ')})` : ''}`
                                    : `${IDENTITY_LABEL[info.identity.mode]}${info.identity.reason ? ` — ${info.identity.reason}` : ''}`
                                : 'Wird ermittelt…'}
                    </span>
                </div>
            </div>

            <div className={styles.setting}>
                <div className={styles.settingInfo}>
                    <span className={styles.settingLabel}>Browser-Speicher</span>
                    <span className={styles.settingDescription}>
                        {storage === null
                            ? 'Wird ermittelt…'
                            : !storage.available
                                ? 'Dieser Browser bietet keinen privaten Dateispeicher (OPFS) — lokale Daten liegen nur in localStorage/IndexedDB.'
                                : `${storage.persisted ? 'Dauerhaft — der Browser räumt diese Daten nicht von selbst weg.' : 'Nicht dauerhaft — der Browser darf diese Daten bei Platzmangel löschen.'} `
                                  + `Belegt: ${formatBytes(storage.usage)}${storage.quota ? ` von ${formatBytes(storage.quota)}` : ''}`
                                  + `${storage.warning ? ' — über 80 % belegt, bitte aufräumen oder exportieren.' : ''}`}
                    </span>
                </div>
                {storage?.available && !storage.persisted && (
                    <button
                        type="button"
                        className={styles.exportButton}
                        onClick={() => { void onRequestPersistence(); }}
                        disabled={requesting}
                    >
                        {requesting ? 'Wird angefragt…' : 'Dauerhaft speichern'}
                    </button>
                )}
            </div>
        </>
    );
}
