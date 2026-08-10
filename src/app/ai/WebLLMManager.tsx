'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Trash2, Check, Wrench } from 'lucide-react';
import { Button } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import {
    CURATED_WEBLLM_MODELS,
    checkWebGPU,
    deleteModelFromCache,
    getEngine,
    isModelCached,
    listAllWebLLMModels,
    type WebLLMModelInfo,
} from '@/lib/ai/protocols/webllm';
import styles from './WebLLMManager.module.css';

/**
 * WebLLM model manager: WebGPU capability check, curated model list with
 * cache state, download-with-progress and cache eviction. Everything
 * here runs in the browser — the backend is never involved.
 *
 * Zwei Ebenen, damit nichts versteckt ist: die kuratierte Empfehlung
 * (`CURATED_WEBLLM_MODELS`) und — einen Schalter entfernt — der VOLLE
 * Katalog des mitgelieferten WebLLM-Builds, durchsuchbar und nach
 * Tool-Calling filterbar. Der Filter arbeitet mit der Tatsache aus der
 * Bibliothek (`functionCallingModelIds`), nicht mit einer Einschätzung.
 */

interface DownloadState {
    label: string;
    value?: number;
}

export function WebLLMManager({ onDefaultModel }: { onDefaultModel?: (model: string) => void }) {
    const toast = useToast();
    const [gpu, setGpu] = useState<{ supported: boolean; detail: string } | null>(null);
    const [cached, setCached] = useState<Record<string, boolean>>({});
    const [downloading, setDownloading] = useState<string | null>(null);
    const [progress, setProgress] = useState<DownloadState | null>(null);
    const [showAll, setShowAll] = useState(false);
    const [allModels, setAllModels] = useState<WebLLMModelInfo[] | null>(null);
    const [catalogError, setCatalogError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [toolsOnly, setToolsOnly] = useState(false);

    /** Schon auf Cache geprüfte Modell-Ids — verhindert Doppelprüfungen. */
    const probed = useRef(new Set<string>());

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const result = await checkWebGPU();
            if (!cancelled) setGpu(result);
        })();
        return () => { cancelled = true; };
    }, []);

    // Der volle Katalog kommt aus der Bibliothek und wird erst geladen,
    // wenn er gebraucht wird — das Modul ist groß.
    useEffect(() => {
        if (!showAll || allModels || catalogError) return;
        let cancelled = false;
        (async () => {
            try {
                const models = await listAllWebLLMModels();
                if (!cancelled) setAllModels(models);
            } catch (error) {
                if (!cancelled) setCatalogError(error instanceof Error ? error.message : 'Katalog nicht ladbar');
            }
        })();
        return () => { cancelled = true; };
    }, [showAll, allModels, catalogError]);

    const visible = useMemo(() => {
        const source = showAll ? allModels ?? [] : CURATED_WEBLLM_MODELS;
        const needle = query.trim().toLowerCase();
        return source.filter(model => {
            if (toolsOnly && !model.nativeTools) return false;
            if (!needle) return true;
            return model.id.toLowerCase().includes(needle) || model.label.toLowerCase().includes(needle);
        });
    }, [showAll, allModels, query, toolsOnly]);

    // Cache-Zustand nur für das, was gerade sichtbar ist: der volle
    // Katalog hat ~165 Einträge, und jede Prüfung ist ein Cache-API-Zugriff.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            for (const model of visible) {
                if (probed.current.has(model.id)) continue;
                probed.current.add(model.id);
                const state = await isModelCached(model.id);
                if (cancelled) return;
                if (state) setCached(prev => ({ ...prev, [model.id]: true }));
            }
        })();
        return () => { cancelled = true; };
    }, [visible]);

    const download = async (modelId: string) => {
        setDownloading(modelId);
        setProgress({ label: 'Starte…', value: 0 });
        try {
            await getEngine(modelId, (label, value) => setProgress({ label, value }));
            setCached(prev => ({ ...prev, [modelId]: true }));
            toast.success('Modell bereit — läuft jetzt komplett in deinem Browser');
            onDefaultModel?.(modelId);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Download fehlgeschlagen');
        } finally {
            setDownloading(null);
            setProgress(null);
        }
    };

    const evict = async (modelId: string) => {
        try {
            await deleteModelFromCache(modelId);
            setCached(prev => ({ ...prev, [modelId]: false }));
            toast.info('Modell aus dem Browser-Cache entfernt');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Entfernen fehlgeschlagen');
        }
    };

    return (
        <div className={styles.manager}>
            {gpu && (
                <p className={`${styles.gpuStatus} ${gpu.supported ? styles.gpuOk : styles.gpuFail}`}>
                    {gpu.detail}
                </p>
            )}

            <div className={styles.controls}>
                <label className={styles.searchLabel}>
                    <span className="visually-hidden">Modell suchen</span>
                    <input
                        type="search"
                        className={styles.search}
                        value={query}
                        onChange={event => setQuery(event.target.value)}
                        placeholder={showAll ? 'Im vollen Katalog suchen…' : 'In der Empfehlung suchen…'}
                    />
                </label>
                <label className={styles.toggle}>
                    <input
                        type="checkbox"
                        checked={toolsOnly}
                        onChange={event => setToolsOnly(event.target.checked)}
                    />
                    Nur mit nativem Tool-Calling
                </label>
                <label className={styles.toggle}>
                    <input
                        type="checkbox"
                        checked={showAll}
                        onChange={event => setShowAll(event.target.checked)}
                    />
                    Alle Modelle dieses Builds
                </label>
            </div>

            <p className={styles.hint}>
                Werkzeugaufrufe laufen hier über die universelle Text-Syntax — sie funktioniert mit
                jedem Modell. Die markierten Modelle sind zusätzlich auf Funktionsaufrufe trainiert
                und folgen ihr am zuverlässigsten.
            </p>

            {catalogError && <p className={`${styles.gpuStatus} ${styles.gpuFail}`}>{catalogError}</p>}
            {showAll && !allModels && !catalogError && <p className={styles.hint}>Katalog wird geladen…</p>}

            <ul className={styles.modelList}>
                {visible.map(model => (
                    <li key={model.id} className={styles.modelItem}>
                        <div className={styles.modelInfo}>
                            <strong>
                                {model.label}
                                {model.nativeTools && (
                                    <span className={styles.toolTag}>
                                        <Wrench size={11} aria-hidden="true" /> Tool-Calling
                                    </span>
                                )}
                            </strong>
                            <span className={styles.modelMeta}>{model.sizeHint} · <code>{model.id}</code></span>
                            {model.note && <span className={styles.modelNote}>{model.note}</span>}
                            {downloading === model.id && progress && (
                                <div className={styles.progressWrap}>
                                    <div
                                        className={styles.progressBar}
                                        role="progressbar"
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-valuenow={progress.value !== undefined ? Math.round(progress.value * 100) : undefined}
                                    >
                                        <div
                                            className={styles.progressFill}
                                            style={{ width: `${Math.round((progress.value ?? 0) * 100)}%` }}
                                        />
                                    </div>
                                    <span className={styles.progressLabel}>{progress.label}</span>
                                </div>
                            )}
                        </div>
                        <div className={styles.modelActions}>
                            {cached[model.id] ? (
                                <>
                                    <span className={styles.cachedTag}><Check size={12} aria-hidden="true" /> im Cache (offline-fähig)</span>
                                    <button
                                        type="button"
                                        className={styles.iconAction}
                                        onClick={() => evict(model.id)}
                                        title="Aus Browser-Cache entfernen"
                                        aria-label={`${model.label} aus Cache entfernen`}
                                    >
                                        <Trash2 size={14} aria-hidden="true" />
                                    </button>
                                </>
                            ) : (
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => download(model.id)}
                                    disabled={downloading !== null || gpu?.supported === false}
                                >
                                    <Download size={13} aria-hidden="true" />
                                    {downloading === model.id ? 'Lade…' : 'Laden'}
                                </Button>
                            )}
                        </div>
                    </li>
                ))}
            </ul>

            {visible.length === 0 && (allModels || !showAll) && (
                <p className={styles.hint}>
                    Kein Modell passt zu dieser Suche
                    {toolsOnly ? ' und dem Tool-Calling-Filter' : ''}.
                </p>
            )}
        </div>
    );
}
