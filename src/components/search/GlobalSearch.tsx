'use client';

import { useState, useEffect, useRef } from 'react';
import styles from './GlobalSearch.module.css';

interface GlobalSearchProps {
    placeholder?: string;
}

export function GlobalSearch({ placeholder = 'Suchen... (Cmd+K)' }: GlobalSearchProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                setIsOpen(true);
            }
            if (e.key === 'Escape') {
                setIsOpen(false);
                setQuery('');
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, []);

    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isOpen]);

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        // TODO: Implement search functionality
        console.log('Search:', query);
    };

    return (
        <>
            <button
                className={styles.trigger}
                onClick={() => setIsOpen(true)}
                aria-label="Suche oeffnen"
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35" />
                </svg>
                <span className={styles.triggerText}>{placeholder}</span>
                <kbd className={styles.kbd}>Cmd+K</kbd>
            </button>

            {isOpen && (
                <>
                    <div className={styles.overlay} onClick={() => setIsOpen(false)} />
                    <div className={styles.modal}>
                        <form onSubmit={handleSearch} className={styles.searchForm}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="11" cy="11" r="8" />
                                <path d="M21 21l-4.35-4.35" />
                            </svg>
                            <input
                                ref={inputRef}
                                type="text"
                                className={styles.input}
                                placeholder="In allen Modulen suchen..."
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                            />
                            <kbd className={styles.kbd}>Esc</kbd>
                        </form>

                        {query && (
                            <div className={styles.results}>
                                <p className={styles.noResults}>Keine Ergebnisse gefunden</p>
                            </div>
                        )}
                    </div>
                </>
            )}
        </>
    );
}
