'use client';

import { useEffect, useState } from 'react';
import { Download, Trash2, Check } from 'lucide-react';
import { Button } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import {
    CURATED_WEBLLM_MODELS,
    checkWebGPU,
    deleteModelFromCache,
    getEngine,
    isModelCached,
} from '@/lib/ai/protocols/webllm';
import styles from './WebLLMManager.module.css';

/**
 * WebLLM model manager: WebGPU capability check, curated model list with
 * cache state, download-with-progress and cache eviction. Everything
 * here runs in the browser — the backend is never involved.
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

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const result = await checkWebGPU();
            if (!cancelled) setGpu(result);
            const states: Record<string, boolean> = {};
            for (const model of CURATED_WEBLLM_MODELS) {
                states[model.id] = await isModelCached(model.id);
                if (!cancelled) setCached({ ...states });
            }
        })();
        return () => { cancelled = true; };
    }, []);

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

            <ul className={styles.modelList}>
                {CURATED_WEBLLM_MODELS.map(model => (
                    <li key={model.id} className={styles.modelItem}>
                        <div className={styles.modelInfo}>
                            <strong>{model.label}</strong>
                            <span className={styles.modelMeta}>{model.sizeHint} · <code>{model.id}</code></span>
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
        </div>
    );
}
