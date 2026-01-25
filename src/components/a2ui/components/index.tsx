'use client';

import React, { useState, useEffect } from 'react';
import { ActionHandler } from '../types';

import './Display.css';
import './Structure.css';
import './Status.css';
import './Input.css';

interface ComponentProps {
    props: any;
    onAction: ActionHandler;
    children?: React.ReactNode;
}

// ============================================================
// BASIC DISPLAY COMPONENTS (existing)
// ============================================================

export const Text = ({ props }: ComponentProps) => {
    const text = props.text?.literalString || props.text || '';
    const style = props.style || {};
    return <span style={{ ...style }}>{text}</span>;
};

export const Card = ({ props, children }: ComponentProps) => {
    return (
        <div style={{
            padding: '12px',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'var(--color-surface)',
            marginBottom: '8px',
            ...props.style
        }}>
            {props.title && <h3 style={{ margin: '0 0 8px 0', fontSize: '14px' }}>{props.title}</h3>}
            {children}
        </div>
    );
};

// ============================================================
// LAYOUT COMPONENTS (existing)
// ============================================================

export const Column = ({ props, children }: ComponentProps) => {
    const gap = props.gap || '8px';
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: gap, ...props.style }}>
            {children}
        </div>
    );
};

export const Row = ({ props, children }: ComponentProps) => {
    const gap = props.gap || '8px';
    const align = props.align || 'center';
    return (
        <div style={{ display: 'flex', flexDirection: 'row', gap: gap, alignItems: align, ...props.style }}>
            {children}
        </div>
    );
};

export const Divider = () => (
    <hr style={{ border: 0, borderTop: '1px solid var(--color-border)', margin: '8px 0' }} />
);

// ============================================================
// INTERACTION COMPONENTS (existing)
// ============================================================

export const Button = ({ props, onAction }: ComponentProps) => {
    const label = props.label?.literalString || props.label || 'Button';
    const actionId = props.onPress?.actionId;

    return (
        <button
            onClick={() => actionId && onAction(actionId)}
            style={{
                padding: '6px 12px',
                backgroundColor: 'var(--color-primary)',
                color: 'white',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                fontSize: '13px',
                ...props.style
            }}
        >
            {label}
        </button>
    );
};

// ============================================================
// DISPLAY COMPONENTS (new)
// ============================================================

export const Markdown = ({ props }: ComponentProps) => {
    const content = props.content?.literalString || props.content || '';

    // Use dynamic import to load ReactMarkdown and remarkGfm
    const [ReactMarkdownLib, setReactMarkdownLib] = useState<{ default: typeof import('react-markdown').default } | null>(null);
    const [remarkGfm, setRemarkGfm] = useState<any>(null);

    useEffect(() => {
        Promise.all([
            import('react-markdown'),
            import('remark-gfm')
        ]).then(([md, gfm]) => {
            setReactMarkdownLib(md);
            setRemarkGfm(() => gfm.default);
        });
    }, []);

    if (!ReactMarkdownLib) {
        // Fallback to simple text while loading
        return <div className="a2ui-markdown">{content}</div>;
    }

    const ReactMarkdown = ReactMarkdownLib.default;

    return (
        <div className="a2ui-markdown">
            <ReactMarkdown remarkPlugins={remarkGfm ? [remarkGfm] : []}>
                {content}
            </ReactMarkdown>
        </div>
    );
};

export const CodeBlock = ({ props }: ComponentProps) => {
    const code = props.code?.literalString || props.code || '';
    const language = props.language || 'text';
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="a2ui-codeblock">
            <div className="a2ui-codeblock-header">
                <span className="a2ui-codeblock-language">{language}</span>
                <button className="a2ui-codeblock-copy" onClick={handleCopy}>
                    {copied ? 'Kopiert!' : 'Kopieren'}
                </button>
            </div>
            <pre>
                <code>{code}</code>
            </pre>
        </div>
    );
};

export const Image = ({ props }: ComponentProps) => {
    const src = props.src?.literalString || props.src || '';
    const alt = props.alt?.literalString || props.alt || '';
    const caption = props.caption?.literalString || props.caption;
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    if (error) {
        return (
            <div className="a2ui-image-loading">
                Bild konnte nicht geladen werden
            </div>
        );
    }

    return (
        <figure className="a2ui-image">
            {loading && <div className="a2ui-image-loading">Lade Bild...</div>}
            <img
                src={src}
                alt={alt}
                onLoad={() => setLoading(false)}
                onError={() => { setLoading(false); setError(true); }}
                style={{ display: loading ? 'none' : 'block' }}
            />
            {caption && <figcaption className="a2ui-image-caption">{caption}</figcaption>}
        </figure>
    );
};

export const Link = ({ props, onAction }: ComponentProps) => {
    const text = props.text?.literalString || props.text || props.href || '';
    const href = props.href?.literalString || props.href || '#';
    const external = props.external !== false;
    const actionId = props.onPress?.actionId;

    const handleClick = (e: React.MouseEvent) => {
        if (actionId) {
            e.preventDefault();
            onAction(actionId, { href });
        }
    };

    return (
        <a
            href={href}
            className={`a2ui-link ${external ? 'a2ui-link-external' : ''}`}
            target={external ? '_blank' : undefined}
            rel={external ? 'noopener noreferrer' : undefined}
            onClick={actionId ? handleClick : undefined}
        >
            {text}
        </a>
    );
};

export const Alert = ({ props, children }: ComponentProps) => {
    const variant = props.variant || 'info';
    const title = props.title?.literalString || props.title;
    const message = props.message?.literalString || props.message || '';

    const icons: Record<string, string> = {
        info: 'i',
        success: '\u2713',
        warning: '!',
        error: '\u2715'
    };

    return (
        <div className={`a2ui-alert a2ui-alert--${variant}`}>
            <div className="a2ui-alert-icon">{icons[variant]}</div>
            <div className="a2ui-alert-content">
                {title && <div className="a2ui-alert-title">{title}</div>}
                <div>{message || children}</div>
            </div>
        </div>
    );
};

// ============================================================
// STRUCTURE COMPONENTS (new)
// ============================================================

export const List = ({ props, children }: ComponentProps) => {
    const ordered = props.ordered === true;
    const items = props.items || [];
    const listStyle = props.listStyle || (ordered ? 'ordered' : 'unordered');

    const ListTag = ordered ? 'ol' : 'ul';

    return (
        <ListTag className={`a2ui-list a2ui-list--${listStyle}`}>
            {items.length > 0
                ? items.map((item: string, idx: number) => (
                    <li key={idx} className="a2ui-list-item">{item}</li>
                ))
                : children
            }
        </ListTag>
    );
};

export const ListItem = ({ props, children }: ComponentProps) => {
    const text = props.text?.literalString || props.text || '';

    return (
        <li className="a2ui-list-item">
            {text || children}
        </li>
    );
};

export const Table = ({ props }: ComponentProps) => {
    const columns = props.columns || [];
    const rows = props.rows || [];
    const striped = props.striped === true;
    const compact = props.compact === true;

    const classNames = [
        'a2ui-table',
        striped && 'a2ui-table--striped',
        compact && 'a2ui-table--compact'
    ].filter(Boolean).join(' ');

    return (
        <div className="a2ui-table-container">
            <table className={classNames}>
                <thead>
                    <tr>
                        {columns.map((col: string | { label: string; key: string }, idx: number) => (
                            <th key={idx}>{typeof col === 'string' ? col : col.label}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row: any, rowIdx: number) => (
                        <tr key={rowIdx}>
                            {columns.map((col: string | { label: string; key: string }, colIdx: number) => {
                                const key = typeof col === 'string' ? col : col.key;
                                const value = Array.isArray(row) ? row[colIdx] : row[key];
                                return <td key={colIdx}>{value}</td>;
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

// ============================================================
// STATUS COMPONENTS (new)
// ============================================================

export const Progress = ({ props }: ComponentProps) => {
    const value = props.value ?? 0;
    const max = props.max ?? 100;
    const label = props.label?.literalString || props.label;
    const showPercent = props.showPercent !== false;
    const indeterminate = props.indeterminate === true;

    const percent = Math.round((value / max) * 100);

    return (
        <div className={`a2ui-progress ${indeterminate ? 'a2ui-progress--indeterminate' : ''}`}>
            {(label || showPercent) && (
                <div className="a2ui-progress-label">
                    <span>{label}</span>
                    {showPercent && !indeterminate && <span>{percent}%</span>}
                </div>
            )}
            <div className="a2ui-progress-track">
                <div
                    className="a2ui-progress-bar"
                    style={{ width: indeterminate ? undefined : `${percent}%` }}
                />
            </div>
        </div>
    );
};

export const Chip = ({ props, onAction }: ComponentProps) => {
    const label = props.label?.literalString || props.label || '';
    const variant = props.variant || 'default';
    const removable = props.removable === true;
    const actionId = props.onRemove?.actionId;

    const handleRemove = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (actionId) {
            onAction(actionId);
        }
    };

    return (
        <span className={`a2ui-chip a2ui-chip--${variant}`}>
            {props.icon && <span className="a2ui-chip-icon">{props.icon}</span>}
            {label}
            {removable && (
                <button className="a2ui-chip-remove" onClick={handleRemove}>
                    \u2715
                </button>
            )}
        </span>
    );
};

export const Badge = ({ props, children }: ComponentProps) => {
    const count = props.count;
    const dot = props.dot === true;
    const variant = props.variant || 'default';
    const inline = props.inline === true;

    const badgeClasses = [
        'a2ui-badge',
        dot && 'a2ui-badge--dot',
        inline && 'a2ui-badge--inline',
        variant !== 'default' && `a2ui-badge--${variant}`
    ].filter(Boolean).join(' ');

    if (inline || !children) {
        return (
            <span className={badgeClasses}>
                {!dot && (count ?? '')}
            </span>
        );
    }

    return (
        <span className="a2ui-badge-wrapper">
            {children}
            <span className={badgeClasses}>
                {!dot && (count ?? '')}
            </span>
        </span>
    );
};

// ============================================================
// INPUT COMPONENTS (new)
// ============================================================

export const Input = ({ props, onAction }: ComponentProps) => {
    const label = props.label?.literalString || props.label;
    const placeholder = props.placeholder?.literalString || props.placeholder || '';
    const defaultValue = props.value?.literalString || props.value || '';
    const type = props.type || 'text';
    const error = props.error?.literalString || props.error;
    const helper = props.helper?.literalString || props.helper;
    const actionId = props.onChange?.actionId;

    const [value, setValue] = useState(defaultValue);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.value;
        setValue(newValue);
        if (actionId) {
            onAction(actionId, { value: newValue });
        }
    };

    return (
        <div className="a2ui-input-wrapper">
            {label && <label className="a2ui-input-label">{label}</label>}
            <input
                type={type}
                className={`a2ui-input ${error ? 'a2ui-input--error' : ''}`}
                placeholder={placeholder}
                value={value}
                onChange={handleChange}
            />
            {(helper || error) && (
                <div className={`a2ui-input-helper ${error ? 'a2ui-input-helper--error' : ''}`}>
                    {error || helper}
                </div>
            )}
        </div>
    );
};

export const Select = ({ props, onAction }: ComponentProps) => {
    const label = props.label?.literalString || props.label;
    const options = props.options || [];
    const defaultValue = props.value?.literalString || props.value || '';
    const placeholder = props.placeholder?.literalString || props.placeholder;
    const actionId = props.onSelect?.actionId;

    const [value, setValue] = useState(defaultValue);

    const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const newValue = e.target.value;
        setValue(newValue);
        if (actionId) {
            onAction(actionId, { value: newValue });
        }
    };

    return (
        <div className="a2ui-select-wrapper">
            {label && <label className="a2ui-select-label">{label}</label>}
            <select className="a2ui-select" value={value} onChange={handleChange}>
                {placeholder && <option value="">{placeholder}</option>}
                {options.map((opt: string | { label: string; value: string }, idx: number) => {
                    const optValue = typeof opt === 'string' ? opt : opt.value;
                    const optLabel = typeof opt === 'string' ? opt : opt.label;
                    return (
                        <option key={idx} value={optValue}>
                            {optLabel}
                        </option>
                    );
                })}
            </select>
        </div>
    );
};

export const Checkbox = ({ props, onAction }: ComponentProps) => {
    const label = props.label?.literalString || props.label || '';
    const defaultChecked = props.checked === true;
    const actionId = props.onChange?.actionId;

    const [checked, setChecked] = useState(defaultChecked);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newChecked = e.target.checked;
        setChecked(newChecked);
        if (actionId) {
            onAction(actionId, { checked: newChecked });
        }
    };

    return (
        <label className="a2ui-checkbox-wrapper">
            <span className="a2ui-checkbox">
                <input type="checkbox" checked={checked} onChange={handleChange} />
                <span className="a2ui-checkbox-box" />
            </span>
            <span className="a2ui-checkbox-label">{label}</span>
        </label>
    );
};

// ============================================================
// COMPONENT REGISTRY
// ============================================================

export const ComponentRegistry: Record<string, React.FC<ComponentProps>> = {
    // Basic Display
    Text,
    Card,
    // Layout
    Column,
    Row,
    Divider,
    // Interaction
    Button,
    // Display (new)
    Markdown,
    CodeBlock,
    Image,
    Link,
    Alert,
    // Structure (new)
    List,
    ListItem,
    Table,
    // Status (new)
    Progress,
    Chip,
    Badge,
    // Input (new)
    Input,
    Select,
    Checkbox,
};
