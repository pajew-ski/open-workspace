'use client';

import { createContext, useContext, useEffect, useSyncExternalStore, ReactNode } from 'react';
import { useStoredState } from '@/lib/hooks/useStoredState';

type Theme = 'light' | 'dark' | 'system';

interface ThemeContextType {
    theme: Theme;
    resolvedTheme: 'light' | 'dark';
    setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_KEY = 'ai-workspace-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function isTheme(value: string): value is Theme {
    return value === 'light' || value === 'dark' || value === 'system';
}

function subscribeToSystemTheme(listener: () => void): () => void {
    const mediaQuery = window.matchMedia(DARK_QUERY);
    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
}

function useSystemTheme(): 'light' | 'dark' {
    return useSyncExternalStore(
        subscribeToSystemTheme,
        () => (window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'),
        () => 'light'
    );
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [storedTheme, setStoredTheme] = useStoredState(STORAGE_KEY, 'system');
    const systemTheme = useSystemTheme();
    const theme: Theme = isTheme(storedTheme) ? storedTheme : 'system';
    const resolvedTheme = theme === 'system' ? systemTheme : theme;

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', resolvedTheme);
    }, [resolvedTheme]);

    const setTheme = (newTheme: Theme) => {
        setStoredTheme(newTheme);
    };

    return (
        <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme(): ThemeContextType {
    const context = useContext(ThemeContext);
    // Return default values during SSR when context is not available
    if (context === undefined) {
        return {
            theme: 'system',
            resolvedTheme: 'light',
            setTheme: () => { },
        };
    }
    return context;
}
