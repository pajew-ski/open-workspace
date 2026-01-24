import React from 'react';
import { ActionHandler } from '../types';

interface ComponentProps {
    props: any;
    onAction: ActionHandler;
    children?: React.ReactNode;
}

// Basic Display Components
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

// Layout Components
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

// Interaction Components
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

export const ComponentRegistry: Record<string, React.FC<ComponentProps>> = {
    Text,
    Card,
    Column,
    Row,
    Divider,
    Button
};
