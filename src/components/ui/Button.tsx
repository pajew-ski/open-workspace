import { ButtonHTMLAttributes, forwardRef } from 'react';
import styles from './Button.module.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'ghost';
    size?: 'sm' | 'md' | 'lg';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant = 'primary', size = 'md', children, ...props }, ref) => {
        const classNames = [
            styles.button,
            styles[variant],
            styles[size],
            className,
        ].filter(Boolean).join(' ');

        return (
            <button ref={ref} className={classNames} {...props}>
                {children}
            </button>
        );
    }
);

Button.displayName = 'Button';
