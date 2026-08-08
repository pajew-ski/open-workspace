'use client';

import { ReactNode, useState } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { useStoredState } from '@/lib/hooks/useStoredState';
import styles from './AppShell.module.css';

interface AppShellProps {
    children: ReactNode;
    title?: string;
    actions?: ReactNode;
    fluid?: boolean;
}

const SIDEBAR_COLLAPSED_KEY = 'open-workspace-sidebar-collapsed';

export function AppShell({ children, title, actions, fluid = false }: AppShellProps) {
    // Default to collapsed on desktop; stored value wins after hydration
    const [storedCollapsed, setStoredCollapsed] = useStoredState(SIDEBAR_COLLAPSED_KEY, 'true');
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const collapsed = storedCollapsed === 'true';

    const handleToggle = () => {
        setStoredCollapsed(String(!collapsed));
    };

    const handleMobileToggle = () => {
        setIsMobileMenuOpen(!isMobileMenuOpen);
    };

    return (
        <div className={`${styles.container} ${collapsed ? styles.collapsed : ''} ${isMobileMenuOpen ? styles.mobileOpen : ''}`}>
            {isMobileMenuOpen && (
                <div className={styles.mobileOverlay} onClick={() => setIsMobileMenuOpen(false)} />
            )}
            <Sidebar
                isCollapsed={collapsed}
                onToggle={handleToggle}
                isMobileOpen={isMobileMenuOpen}
                onMobileClose={() => setIsMobileMenuOpen(false)}
            />
            <div className={styles.main}>
                <Header title={title} onMobileMenuClick={handleMobileToggle} />
                <main className={`${styles.content} ${fluid ? styles.fluid : ''}`}>
                    {children}
                </main>
            </div>

            {/* Context Actions (FABs) */}
            {actions && (
                <div className={styles.floatingActionContainer}>
                    {actions}
                </div>
            )}


        </div>
    );
}
