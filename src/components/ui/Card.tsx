import { ReactNode } from 'react';
import styles from './Card.module.css';

export interface CardProps {
    children: ReactNode;
    className?: string;
    elevated?: boolean;
    padding?: 'none' | 'sm' | 'md' | 'lg';
}

export function Card({
    children,
    className,
    elevated = false,
    padding = 'md'
}: CardProps) {
    const classNames = [
        styles.card,
        elevated && styles.elevated,
        styles[`padding-${padding}`],
        className,
    ].filter(Boolean).join(' ');

    return (
        <div className={classNames}>
            {children}
        </div>
    );
}

export interface CardHeaderProps {
    children: ReactNode;
    className?: string;
}

export function CardHeader({ children, className }: CardHeaderProps) {
    return (
        <div className={`${styles.header} ${className || ''}`}>
            {children}
        </div>
    );
}

export interface CardContentProps {
    children: ReactNode;
    className?: string;
}

export function CardContent({ children, className }: CardContentProps) {
    return (
        <div className={`${styles.content} ${className || ''}`}>
            {children}
        </div>
    );
}
