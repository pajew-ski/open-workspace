import { InputHTMLAttributes, forwardRef } from 'react';
import styles from './Input.module.css';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    error?: string;
    hint?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
    ({ className, label, error, hint, id, ...props }, ref) => {
        const inputId = id || `input-${Math.random().toString(36).slice(2)}`;

        return (
            <div className={styles.wrapper}>
                {label && (
                    <label htmlFor={inputId} className={styles.label}>
                        {label}
                    </label>
                )}
                <input
                    ref={ref}
                    id={inputId}
                    className={`${styles.input} ${error ? styles.hasError : ''} ${className || ''}`}
                    aria-invalid={!!error}
                    aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
                    {...props}
                />
                {error && (
                    <span id={`${inputId}-error`} className={styles.error} role="alert">
                        {error}
                    </span>
                )}
                {hint && !error && (
                    <span id={`${inputId}-hint`} className={styles.hint}>
                        {hint}
                    </span>
                )}
            </div>
        );
    }
);

Input.displayName = 'Input';
