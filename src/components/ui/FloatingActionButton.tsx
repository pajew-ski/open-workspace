'use client';

import { ButtonHTMLAttributes } from 'react';
import styles from './FloatingActionButton.module.css';

interface FloatingActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    icon: React.ReactNode;
    label?: string; // Optional tooltip
}

export function FloatingActionButton({ icon, label, className, ...props }: FloatingActionButtonProps) {
    return (
        <button
            className={`${styles.fab} ${className || ''}`}
            title={label}
            {...props}
        >
            {icon}
        </button>
    );
}
