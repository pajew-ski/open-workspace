'use client';

import { GlobalSearch } from '@/components/search';
import { NotificationBell } from '@/components/notifications';
import styles from './Header.module.css';

interface HeaderProps {
    title?: string;
}

export function Header({ title }: HeaderProps) {
    return (
        <header className={styles.header}>
            <div className={styles.left}>
                {title && <h1 className={styles.title}>{title}</h1>}
            </div>

            <div className={styles.center}>
                <GlobalSearch />
            </div>

            <div className={styles.right}>
                <NotificationBell />
            </div>
        </header>
    );
}
