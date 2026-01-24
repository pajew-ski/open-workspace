'use client';

import { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import styles from './AppShell.module.css';

interface AppShellProps {
    children: ReactNode;
    title?: string;
}

export function AppShell({ children, title }: AppShellProps) {
    return (
        <div className={styles.container}>
            <Sidebar />
            <div className={styles.main}>
                <Header title={title} />
                <main className={styles.content}>
                    {children}
                </main>
            </div>
        </div>
    );
}
