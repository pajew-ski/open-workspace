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

// Simple Levenshtein distance for fuzzy command matching
const levenshtein = (a: string, b: string): number => {
    const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
    for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
    for (let j = 1; j <= b.length; j++) {
        for (let i = 1; i <= a.length; i++) {
            const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[j][i] = Math.min(
                matrix[j][i - 1] + 1,
                matrix[j - 1][i] + 1,
                matrix[j - 1][i - 1] + indicator
            );
        }
    }
    return matrix[b.length][a.length];
};

const mapModifierToType = (input: string): string | null => {
    const lower = input.toLowerCase();

    // 1. Exact or Prefix Match
    if (['task', 'aufgabe', 'todo', 't'].some(k => k.startsWith(lower))) return 'task';
    if (['note', 'notiz', 'wissen', 'n'].some(k => k.startsWith(lower))) return 'note';
    if (['termin', 'date', 'kalender', 'cal', 'd'].some(k => k.startsWith(lower))) return 'calendar';
    if (['chat', 'nachricht', 'c'].some(k => k.startsWith(lower))) return 'chat';
    if (['project', 'projekt', 'p'].some(k => k.startsWith(lower))) return 'project';

    // 2. Fuzzy Match (Levensthein < 2)
    const keywords: Record<string, string[]> = {
        'task': ['task', 'aufgabe', 'todo'],
        'note': ['note', 'notiz', 'wissen'],
        'calendar': ['termin', 'date', 'kalender', 'cal'],
        'chat': ['chat', 'nachricht'],
        'project': ['project', 'projekt']
    };

    for (const [type, words] of Object.entries(keywords)) {
        for (const word of words) {
            if (levenshtein(lower, word) <= 1) return type;
        }
    }

    return null;
};

export function GlobalFinder() {
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [contextType, setContextType] = useState<string | null>(null);
    const [isGlobal, setIsGlobal] = useState(false);

    const inputRef = useRef<HTMLInputElement>(null);
    const router = useRouter();
    const pathname = typeof window !== 'undefined' ? window.location.pathname : '';

    // Determine context from pathname
    useEffect(() => {
        if (pathname.startsWith('/tasks')) setContextType('task');
        else if (pathname.startsWith('/knowledge')) setContextType('note');
        else if (pathname.startsWith('/communication')) setContextType('chat');
        else if (pathname.startsWith('/calendar')) setContextType('calendar');
        else setContextType(null);
    }, [pathname]);

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

    // Search logic with debounce and modifiers
    useEffect(() => {
        const search = async () => {
            if (!query.trim()) {
                setResults([]);
                return;
            }

            // Parse Modifiers (e.g., "@task fix bug")
            let activeQuery = query;
            let activeType = contextType && !isGlobal ? contextType : null;

            const modifierMatch = query.match(/^@(\w+)\s+(.*)/);
            if (modifierMatch) {
                const modifier = modifierMatch[1].toLowerCase();
                const content = modifierMatch[2];

                // Map modifiers to types
                if (['task', 'aufgabe', 'todo'].includes(modifier)) activeType = 'task';
                else if (['note', 'notiz', 'wissen'].includes(modifier)) activeType = 'note';
                else if (['termin', 'date', 'kalender', 'cal'].includes(modifier)) activeType = 'calendar';
                else if (['chat', 'nachricht'].includes(modifier)) activeType = 'chat';
                else if (['project', 'projekt'].includes(modifier)) activeType = 'project';

                activeQuery = content;
            }

            try {
                // If context exists (either mapped from modifier or path), filter by it
                const typeParam = activeType ? `&type=${activeType}` : '';
                const res = await fetch(`/api/finder?q=${encodeURIComponent(activeQuery)}${typeParam}`);
                const data = await res.json();
                setResults(data.results || []);
                setSelectedIndex(0);
            } catch (error) {
                console.error('Find error:', error);
            }
        };

        const timeoutId = setTimeout(search, 200);
        return () => clearTimeout(timeoutId);
    }, [query, contextType, isGlobal]);

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

    // Removed early return to allow floating button to render

    return (
        <>
            {/* Floating Trigger Button */}
            <button
                className={styles.floatingTrigger}
                onClick={() => { setIsGlobal(false); setIsOpen(true); }}
                title="Finden (CMD+F)"
            >
                <Search size={20} />
            </button>

            {isOpen && (
                <div className={styles.overlay} onClick={() => setIsOpen(false)}>
                    <div className={styles.modal} onClick={e => e.stopPropagation()}>
                        <div className={styles.searchHeader}>
                            <Search className={styles.searchIcon} size={20} />
                            <input
                                ref={inputRef}
                                type="text"
                                className={styles.input}
                                placeholder={contextType && !isGlobal ? `Finden in ${contextType}... (oder @task, @note...)` : "Alles finden... (nutze @task, @termin...)"}
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
                                        <p>Keine Ergebnisse{contextType && !isGlobal ? ` in ${contextType}` : ''} gefunden.</p>
                                        {contextType && !isGlobal && (
                                            <button
                                                className={styles.globalSearchBtn}
                                                onClick={() => setIsGlobal(true)}
                                            >
                                                Global suchen
                                            </button>
                                        )}
                                    </div>
                                )
                            )}
                        </div>

                        <div className={styles.footer}>
                            <span>↑↓ Navigieren</span>
                            <span>⏎ Auswählen</span>
                            {contextType && !isGlobal && (
                                <span>Global suchen: Klick Button</span>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
