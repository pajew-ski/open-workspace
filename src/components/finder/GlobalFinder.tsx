'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Search, FileText, CheckSquare, Briefcase, MessageSquare, Calendar } from 'lucide-react';
import styles from './GlobalFinder.module.css';

interface SearchResult {
    type: 'note' | 'task' | 'project' | 'chat' | 'calendar';
    id: string;
    title: string;
    subtitle?: string;
    url: string;
}

export function GlobalFinder() {
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const router = useRouter();

    // Toggle with CMD+F
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
                e.preventDefault();
                setIsOpen(prev => !prev);
            }
            if (e.key === 'Escape' && isOpen) {
                setIsOpen(false);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen]);

    // Focus input on open
    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
            setQuery('');
            setResults([]);
        }
    }, [isOpen]);

    // Search logic with debounce
    useEffect(() => {
        const search = async () => {
            if (!query.trim()) {
                setResults([]);
                return;
            }

            try {
                const res = await fetch(`/api/finder?q=${encodeURIComponent(query)}`);
                const data = await res.json();
                setResults(data.results || []);
                setSelectedIndex(0);
            } catch (error) {
                console.error('Find error:', error);
            }
        };

        const timeoutId = setTimeout(search, 200);
        return () => clearTimeout(timeoutId);
    }, [query]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(prev => (prev + 1) % results.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(prev => (prev - 1 + results.length) % results.length);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (results[selectedIndex]) {
                handleSelect(results[selectedIndex]);
            }
        }
    };

    const handleSelect = (result: SearchResult) => {
        setIsOpen(false);
        router.push(result.url);
    };

    const getIcon = (type: string) => {
        switch (type) {
            case 'note': return <FileText size={16} />;
            case 'task': return <CheckSquare size={16} />;
            case 'project': return <Briefcase size={16} />;
            case 'chat': return <MessageSquare size={16} />;
            case 'calendar': return <Calendar size={16} />;
            default: return <Search size={16} />;
        }
    };

    if (!isOpen) return null;

    return (
        <div className={styles.overlay} onClick={() => setIsOpen(false)}>
            <div className={styles.modal} onClick={e => e.stopPropagation()}>
                <div className={styles.searchHeader}>
                    <Search className={styles.searchIcon} size={20} />
                    <input
                        ref={inputRef}
                        type="text"
                        className={styles.input}
                        placeholder="Finden..."
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        autoComplete="off"
                    />
                    <span className={styles.shortcut}>ESC</span>
                </div>

                <div className={styles.results}>
                    {results.length > 0 ? (
                        results.map((result, index) => (
                            <div
                                key={`${result.type}-${result.id}`}
                                className={`${styles.resultItem} ${index === selectedIndex ? styles.active : ''}`}
                                onClick={() => handleSelect(result)}
                                onMouseEnter={() => setSelectedIndex(index)}
                            >
                                <div className={styles.resultIcon}>
                                    {getIcon(result.type)}
                                </div>
                                <div className={styles.resultContent}>
                                    <span className={styles.resultTitle}>{result.title}</span>
                                    {result.subtitle && (
                                        <span className={styles.resultSubtitle}>{result.subtitle}</span>
                                    )}
                                </div>
                                {index === selectedIndex && (
                                    <span className={styles.shortcut}>⏎</span>
                                )}
                            </div>
                        ))
                    ) : (
                        query && (
                            <div className={styles.emptyState}>
                                Keine Ergebnisse für "{query}" gefunden.
                            </div>
                        )
                    )}
                </div>

                <div className={styles.footer}>
                    <span>↑↓ Navigieren</span>
                    <span>⏎ Auswählen</span>
                </div>
            </div>
        </div>
    );
}
