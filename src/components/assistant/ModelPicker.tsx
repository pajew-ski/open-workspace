'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Cpu, Globe, MonitorSmartphone, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useAIState, useActiveSelection, useBackendAvailability } from '@/lib/ai/useAI';
import { resolveRoute, type ClientProviderRecord, type ResolvedRoute } from '@/lib/ai/store.client';
import { getPreset } from '@/lib/ai/presets';
import styles from './ModelPicker.module.css';

/**
 * Provider/model switcher for the chat surfaces. Shows the active
 * provider · model with a live status dot; the panel lists every enabled
 * provider with its execution route (browser-direct vs. server relay)
 * and models, and links to the AI-Hub for configuration.
 */

interface ModelPickerProps {
    compact?: boolean;
}

function routeIcon(route: ResolvedRoute | undefined) {
    if (!route) return null;
    return route.decision.route === 'browser'
        ? <MonitorSmartphone size={12} aria-hidden="true" />
        : <Globe size={12} aria-hidden="true" />;
}

export function ModelPicker({ compact = false }: ModelPickerProps) {
    const { data: state } = useAIState();
    const backend = useBackendAvailability();
    const { provider, model, setSelection } = useActiveSelection(state);
    const [open, setOpen] = useState(false);
    const [routes, setRoutes] = useState<Record<string, ResolvedRoute>>({});
    const [expanded, setExpanded] = useState<string | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    const probeOne = useCallback(async (record: ClientProviderRecord) => {
        try {
            const route = await resolveRoute(record);
            setRoutes(prev => ({ ...prev, [record.id]: route }));
        } catch {
            // probe errors already encoded in route result normally
        }
    }, []);

    // Probe the active provider once so the status dot is honest.
    // Deferred a tick so the probe's state updates never land in the
    // same render pass that scheduled them.
    useEffect(() => {
        if (!provider) return;
        const record = provider;
        const timer = setTimeout(() => { void probeOne(record); }, 0);
        return () => clearTimeout(timer);
    }, [provider, probeOne]);

    // Close on outside click / Escape.
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (e: PointerEvent) => {
            if (
                panelRef.current && !panelRef.current.contains(e.target as Node) &&
                buttonRef.current && !buttonRef.current.contains(e.target as Node)
            ) {
                setOpen(false);
            }
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setOpen(false);
                buttonRef.current?.focus();
            }
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    const providers = state?.providers.filter(p => p.enabled) ?? [];
    const activeRoute = provider ? routes[provider.id] : undefined;
    const online = activeRoute?.probe?.status === 'online';
    const statusClass = !activeRoute ? styles.dotUnknown : online ? styles.dotOnline : styles.dotOffline;

    const label = provider
        ? `${provider.label}${model ? ` · ${model}` : ''}`
        : 'Kein Provider';

    return (
        <div className={`${styles.picker} ${compact ? styles.compact : ''}`}>
            <button
                ref={buttonRef}
                type="button"
                className={styles.trigger}
                onClick={() => {
                    setOpen(o => !o);
                    if (!open) providers.forEach(p => { if (!routes[p.id]) void probeOne(p); });
                }}
                aria-expanded={open}
                aria-haspopup="dialog"
                title={`Modell wählen — aktuell: ${label}`}
            >
                <span className={`${styles.dot} ${statusClass}`} aria-hidden="true" />
                <Cpu size={13} aria-hidden="true" />
                <span className={styles.triggerLabel}>{label}</span>
                <ChevronDown size={13} aria-hidden="true" />
            </button>

            {open && (
                <div ref={panelRef} className={styles.panel} role="dialog" aria-label="Provider und Modell wählen">
                    <div className={styles.panelHeader}>
                        <span>Inference</span>
                        <span className={`${styles.backendChip} ${backend === 'available' ? styles.backendOn : styles.backendOff}`}>
                            {backend === 'available' ? 'Backend verbunden' : backend === 'unavailable' ? 'Serverlos' : 'Prüfe…'}
                        </span>
                    </div>

                    {providers.length === 0 && (
                        <p className={styles.emptyNote}>
                            Noch kein Provider eingerichtet.
                        </p>
                    )}

                    <ul className={styles.providerList}>
                        {providers.map(record => {
                            const route = routes[record.id];
                            const isActive = provider?.id === record.id;
                            const models = route?.probe?.models?.length
                                ? route.probe.models
                                : [
                                    ...(record.defaultModel ? [record.defaultModel] : []),
                                    ...(record.pinnedModels ?? []),
                                ].filter((m, i, arr) => arr.indexOf(m) === i);
                            const isExpanded = expanded === record.id;
                            return (
                                <li key={record.id} className={styles.providerItem}>
                                    <div className={`${styles.providerRow} ${isActive ? styles.providerActive : ''}`}>
                                        <button
                                            type="button"
                                            className={styles.providerSelect}
                                            onClick={() => {
                                                setSelection(record.id, record.defaultModel);
                                                setOpen(false);
                                            }}
                                        >
                                            <span
                                                className={`${styles.dot} ${!route ? styles.dotUnknown : route.probe?.status === 'online' ? styles.dotOnline : styles.dotOffline}`}
                                                aria-hidden="true"
                                            />
                                            <span className={styles.providerLabel}>{record.label}</span>
                                            <span className={styles.kindTag}>{getPreset(record.kind).label}</span>
                                            {route && (
                                                <span className={styles.routeTag} title={route.decision.reason}>
                                                    {routeIcon(route)}
                                                    {route.decision.route === 'browser' ? 'Browser' : 'Server'}
                                                </span>
                                            )}
                                        </button>
                                        {models.length > 0 && (
                                            <button
                                                type="button"
                                                className={styles.expandButton}
                                                onClick={() => {
                                                    setExpanded(isExpanded ? null : record.id);
                                                    if (!route) void probeOne(record);
                                                }}
                                                aria-expanded={isExpanded}
                                                aria-label={`Modelle von ${record.label} ${isExpanded ? 'einklappen' : 'anzeigen'}`}
                                            >
                                                <ChevronDown size={14} className={isExpanded ? styles.chevronOpen : ''} aria-hidden="true" />
                                            </button>
                                        )}
                                    </div>
                                    {isExpanded && models.length > 0 && (
                                        <ul className={styles.modelList}>
                                            {models.slice(0, 40).map(m => (
                                                <li key={m}>
                                                    <button
                                                        type="button"
                                                        className={`${styles.modelOption} ${isActive && model === m ? styles.modelActive : ''}`}
                                                        onClick={() => {
                                                            setSelection(record.id, m);
                                                            setOpen(false);
                                                        }}
                                                    >
                                                        {m}
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </li>
                            );
                        })}
                    </ul>

                    {activeRoute && activeRoute.probe && activeRoute.probe.status !== 'online' && (
                        <p className={styles.diagnostic}>{activeRoute.probe.detail}</p>
                    )}

                    <Link href="/ai" className={styles.hubLink} onClick={() => setOpen(false)}>
                        <Settings2 size={14} aria-hidden="true" />
                        AI-Hub öffnen
                    </Link>
                </div>
            )}
        </div>
    );
}
