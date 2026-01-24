'use client';

import { ReactNode, useState, useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { AssistantChat } from '@/components/assistant';
import { GlobalFinder } from '@/components/finder/GlobalFinder';
import styles from './AppShell.module.css';

interface AppShellProps {
    children: ReactNode;
    title?: string;
}

const SIDEBAR_COLLAPSED_KEY = 'open-workspace-sidebar-collapsed';

export function AppShell({ children, title }: AppShellProps) {
    const [isCollapsed, setIsCollapsed] = useState(true); // Default to collapsed
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
        if (stored !== null) {
            setIsCollapsed(stored === 'true');
        }
    }, []);

    const handleToggle = () => {
        const newValue = !isCollapsed;
        setIsCollapsed(newValue);
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(newValue));
    };

    // During SSR, render with collapsed state to avoid hydration mismatch
    const collapsed = mounted ? isCollapsed : true;

    return (
        <div className={`${styles.container} ${collapsed ? styles.collapsed : ''}`}>
            <Sidebar isCollapsed={collapsed} onToggle={handleToggle} />
            <div className={styles.main}>
                <Header title={title} />
                <main className={styles.content}>
                    {children}
                </main>
            </div>
            <AssistantChat />
            <GlobalFinder />
        </div>
    );
}
