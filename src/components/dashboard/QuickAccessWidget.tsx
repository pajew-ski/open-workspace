'use client';

import { WidgetWrapper } from './WidgetWrapper';
import Link from 'next/link';
import { FileText, CheckSquare, Calendar, MessageSquare, Layout } from 'lucide-react';
import styles from './Widgets.module.css';

export function QuickAccessWidget({ id, isEditing, onDelete }: any) {
    const links = [
        { href: '/docs', label: 'Dokumente', icon: <FileText size={20} /> },
        { href: '/tasks', label: 'Aufgaben', icon: <CheckSquare size={20} /> },
        { href: '/calendar', label: 'Kalender', icon: <Calendar size={20} /> },
        { href: '/communication', label: 'Chat', icon: <MessageSquare size={20} /> },
        { href: '/canvas', label: 'Canvas', icon: <Layout size={20} /> },
    ];

    return (
        <WidgetWrapper id={id} title="Schnellzugriff" isEditing={isEditing} onDelete={onDelete}>
            <div className={styles.quickAccessGrid}>
                {links.map((link) => (
                    <Link key={link.href} href={link.href} className={styles.quickAccessItem}>
                        <div className={styles.quickAccessIcon}>{link.icon}</div>
                        <span className={styles.quickAccessLabel}>{link.label}</span>
                    </Link>
                ))}
            </div>
        </WidgetWrapper>
    );
}
