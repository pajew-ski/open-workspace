'use client';

import { useState, useEffect, useRef } from 'react';
import styles from './GlobalSearch.module.css';

interface GlobalSearchProps {
    placeholder?: string;
}

export function GlobalSearch({ placeholder = 'Finden... (Cmd+F)' }: GlobalSearchProps) {
    const triggerFinder = () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }));
    };

    return (
        <button
            className={styles.trigger}
            onClick={triggerFinder}
            aria-label="Finder öffnen"
        >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
            </svg>
            <span className={styles.triggerText}>{placeholder}</span>
            <kbd className={styles.kbd}>Cmd+F</kbd>
        </button>
    );
}
