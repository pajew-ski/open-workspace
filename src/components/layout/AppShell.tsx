'use client';

import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
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
    // Der Drawer merkt sich den Pfad, auf dem er geöffnet wurde — jede
    // Navigation schließt ihn dadurch implizit (kein Effect nötig)
    const [mobileMenu, setMobileMenu] = useState<{ open: boolean; path: string }>({ open: false, path: '' });
    const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
    const pathname = usePathname();
    const collapsed = storedCollapsed === 'true';
    const isMobileMenuOpen = mobileMenu.open && mobileMenu.path === pathname;

    const closeMobileMenu = useCallback(() => {
        setMobileMenu((menu) => (menu.open ? { ...menu, open: false } : menu));
    }, []);

    const handleToggle = () => {
        setStoredCollapsed(String(!collapsed));
    };

    const handleMobileToggle = () => {
        setMobileMenu(isMobileMenuOpen ? { open: false, path: pathname } : { open: true, path: pathname });
    };

    // Offener Drawer: Hintergrund-Scroll sperren; beim Wechsel auf
    // Desktop-Breite (Rotation, Resize) schließen statt hängen bleiben
    useEffect(() => {
        if (!isMobileMenuOpen) return;
        document.body.setAttribute('data-scroll-locked', '');
        const desktop = window.matchMedia('(min-width: 769px)');
        const onChange = (event: MediaQueryListEvent) => {
            if (event.matches) closeMobileMenu();
        };
        desktop.addEventListener('change', onChange);
        return () => {
            document.body.removeAttribute('data-scroll-locked');
            desktop.removeEventListener('change', onChange);
        };
    }, [isMobileMenuOpen, closeMobileMenu]);

    return (
        <div className={`${styles.container} ${collapsed ? styles.collapsed : ''} ${isMobileMenuOpen ? styles.mobileOpen : ''}`}>
            <a href="#main-content" className="skip-link">
                Zum Inhalt springen
            </a>
            {isMobileMenuOpen && (
                <div
                    className={styles.mobileOverlay}
                    onClick={closeMobileMenu}
                    aria-hidden="true"
                    data-testid="mobile-nav-overlay"
                />
            )}
            <Sidebar
                isCollapsed={collapsed}
                onToggle={handleToggle}
                isMobileOpen={isMobileMenuOpen}
                onMobileClose={closeMobileMenu}
            />
            <div className={styles.main} inert={isMobileMenuOpen || undefined}>
                <Header
                    title={title}
                    onMobileMenuClick={handleMobileToggle}
                    isMobileMenuOpen={isMobileMenuOpen}
                    mobileMenuButtonRef={mobileMenuButtonRef}
                />
                <main
                    id="main-content"
                    tabIndex={-1}
                    className={`${styles.content} ${fluid ? styles.fluid : ''}`}
                >
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
