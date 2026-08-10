'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Search, FileText, CheckSquare, Briefcase, MessageSquare, Calendar } from 'lucide-react';
import { useDialogA11y } from '@/lib/hooks/useDialogA11y';
import styles from './GlobalFinder.module.css';

interface SearchResult {
    type: 'doc' | 'task' | 'project' | 'chat' | 'calendar';
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
    const [isGlobal, setIsGlobal] = useState(false);

    const inputRef = useRef<HTMLInputElement>(null);
    const modalRef = useRef<HTMLDivElement>(null);
    const router = useRouter();
    const pathname = usePathname() ?? '';

    const closeFinder = useCallback(() => setIsOpen(false), []);

    // Modal-Verhalten: Fokus ins Suchfeld, Escape schließt (der "ESC"-Hinweis
    // im UI muss stimmen), Fokus kehrt zum Trigger zurück
    useDialogA11y(isOpen, modalRef, closeFinder, inputRef);

    // Context is derived from the pathname — no state needed
    const contextType = useMemo<string | null>(() => {
        if (pathname.startsWith('/tasks')) return 'task';
        if (pathname.startsWith('/docs')) return 'doc';
        if (pathname.startsWith('/communication')) return 'chat';
        if (pathname.startsWith('/calendar')) return 'calendar';
        return null;
    }, [pathname]);

    // ... (Toggle code omitted, staying same)

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
                else if (['doc', 'dokument', 'wissen'].includes(modifier)) activeType = 'doc';
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
            case 'doc': return <FileText size={16} />;
            case 'note': return <FileText size={16} />; // Fallback for old types if any
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
                aria-label="Suchen"
                aria-haspopup="dialog"
                aria-expanded={isOpen}
                data-testid="global-finder-trigger"
            >
                <Search size={20} aria-hidden="true" />
            </button>

            {isOpen && (
                <div className={styles.overlay} onClick={closeFinder}>
                    <div
                        ref={modalRef}
                        className={styles.modal}
                        onClick={e => e.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                        aria-label="Suchen"
                        data-testid="global-finder-dialog"
                    >
                        <div className={styles.searchHeader}>
                            <Search className={styles.searchIcon} size={20} aria-hidden="true" />
                            <input
                                ref={inputRef}
                                type="text"
                                className={styles.input}
                                placeholder={contextType && !isGlobal ? `Finden in ${contextType}... (oder @task, @note...)` : "Alles finden... (nutze @task, @termin...)"}
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                onKeyDown={handleKeyDown}
                                autoComplete="off"
                                aria-label="Suchbegriff"
                                role="combobox"
                                aria-expanded={results.length > 0}
                                aria-controls="finder-results"
                                aria-activedescendant={results[selectedIndex] ? `finder-option-${selectedIndex}` : undefined}
                            />
                            <span className={styles.shortcut} aria-hidden="true">ESC</span>
                        </div>

                        <div className={styles.results} id="finder-results" role="listbox" aria-label="Suchergebnisse">
                            {results.length > 0 ? (
                                results.map((result, index) => (
                                    <div
                                        key={`${result.type}-${result.id}`}
                                        id={`finder-option-${index}`}
                                        role="option"
                                        aria-selected={index === selectedIndex}
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
                                            <span className={styles.shortcut} aria-hidden="true">⏎</span>
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
