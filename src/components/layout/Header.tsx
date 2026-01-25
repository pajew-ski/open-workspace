'use client';

import { NotificationBell } from '@/components/notifications';
import styles from './Header.module.css';

interface HeaderProps {
    title?: string;
    onMobileMenuClick?: () => void;
}

export function Header({ title, onMobileMenuClick }: HeaderProps) {
    return (
        <header className={styles.header}>
            <div className={styles.left}>
                <button
                    className={styles.mobileMenuBtn}
                    onClick={onMobileMenuClick}
                    aria-label="Menü öffnen"
                >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="3" y1="12" x2="21" y2="12" />
                        <line x1="3" y1="6" x2="21" y2="6" />
                        <line x1="3" y1="18" x2="21" y2="18" />
                    </svg>
                </button>
                {title && <h1 className={styles.title}>{title}</h1>}
            </div>

            <div className={styles.center}>
                {/* Search removed as per user request (Redundant with GlobalFinder Bottom-Right) */}
            </div>

            <div className={styles.right}>
                <NotificationBell />
            </div>
        </header>
    );
}
