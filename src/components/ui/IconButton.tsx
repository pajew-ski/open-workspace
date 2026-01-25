import { ButtonHTMLAttributes, forwardRef, ReactNode } from 'react';
import styles from './IconButton.module.css';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    icon: ReactNode;
    label: string;
    size?: 'sm' | 'md' | 'lg';
    variant?: 'default' | 'primary' | 'ghost';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
    ({ icon, label, size = 'md', variant = 'default', className, ...props }, ref) => {
        const classNames = [
            styles.iconButton,
            styles[size],
            styles[variant],
            className,
        ].filter(Boolean).join(' ');

        return (
            <button
                ref={ref}
                className={classNames}
                aria-label={label}
                title={label}
                {...props}
            >
                {icon}
            </button>
        );
    }
);

IconButton.displayName = 'IconButton';
