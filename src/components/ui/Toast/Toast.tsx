'use client';

import { useState, useEffect, useCallback } from 'react';
import styles from './Toast.module.css';

interface ToastItem {
    id: string;
    message: string;
    type: 'success' | 'error' | 'info';
    undoAction?: () => void;
    duration?: number;
}

interface ToastStore {
    toasts: ToastItem[];
    add: (toast: Omit<ToastItem, 'id'>) => string;
    remove: (id: string) => void;
}

// Simple global store
let toastStore: ToastStore | null = null;
const listeners: Set<() => void> = new Set();

function createToastStore(): ToastStore {
    let toasts: ToastItem[] = [];

    return {
        get toasts() { return toasts; },
        add(toast) {
            const id = `toast-${Date.now()}`;
            toasts = [...toasts, { ...toast, id }];
            listeners.forEach(l => l());

            // Auto-remove after duration
            const duration = toast.duration ?? 5000;
            setTimeout(() => {
                this.remove(id);
            }, duration);

            return id;
        },
        remove(id) {
            toasts = toasts.filter(t => t.id !== id);
            listeners.forEach(l => l());
        },
    };
}

function getToastStore(): ToastStore {
    if (!toastStore) {
        toastStore = createToastStore();
    }
    return toastStore;
}

// Hook for components
export function useToast() {
    const [, forceUpdate] = useState({});

    useEffect(() => {
        const listener = () => forceUpdate({});
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    }, []);

    const store = getToastStore();

    return {
        toasts: store.toasts,
        success: useCallback((message: string, undoAction?: () => void) => {
            return store.add({ message, type: 'success', undoAction });
        }, []),
        error: useCallback((message: string) => {
            return store.add({ message, type: 'error', duration: 8000 });
        }, []),
        info: useCallback((message: string) => {
            return store.add({ message, type: 'info' });
        }, []),
        remove: useCallback((id: string) => {
            store.remove(id);
        }, []),
    };
}

// Toast Container
export function ToastContainer() {
    const { toasts, remove } = useToast();

    const handleUndo = (toast: ToastItem) => {
        if (toast.undoAction) {
            toast.undoAction();
            remove(toast.id);
        }
    };

    if (toasts.length === 0) return null;

    return (
        <div className={styles.container}>
            {toasts.map(toast => (
                <div key={toast.id} className={`${styles.toast} ${styles[toast.type]}`}>
                    <span className={styles.message}>{toast.message}</span>
                    {toast.undoAction && (
                        <button className={styles.undo} onClick={() => handleUndo(toast)}>
                            Rückgängig
                        </button>
                    )}
                    <button className={styles.close} onClick={() => remove(toast.id)}>×</button>
                </div>
            ))}
        </div>
    );
}
