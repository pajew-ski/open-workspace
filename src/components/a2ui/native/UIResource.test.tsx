import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UIResource } from './UIResource';
import type { ActionHandler } from '../types';

// React Query is not needed here — UIResource is self-contained.

describe('UIResource (MCP-UI)', () => {
    let onAction: ReturnType<typeof vi.fn<ActionHandler>>;

    beforeEach(() => {
        onAction = vi.fn<ActionHandler>();
    });

    it('renders an inline HTML resource in a sandboxed iframe', () => {
        render(
            <UIResource
                props={{
                    resource: {
                        uri: 'ui://demo/card',
                        mimeType: 'text/html',
                        text: '<h1>Hallo</h1>',
                    },
                }}
                onAction={onAction}
            />
        );
        const frame = screen.getByTitle('ui://demo/card') as HTMLIFrameElement;
        expect(frame).toBeInTheDocument();
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
        expect(frame.getAttribute('srcdoc')).toContain('<h1>Hallo</h1>');
    });

    it('decodes a base64 blob resource', () => {
        const html = '<p>Aus Blob</p>';
        render(
            <UIResource
                props={{
                    resource: {
                        uri: 'ui://demo/blob',
                        mimeType: 'text/html',
                        blob: btoa(html),
                    },
                }}
                onAction={onAction}
            />
        );
        const frame = screen.getByTitle('ui://demo/blob') as HTMLIFrameElement;
        expect(frame.getAttribute('srcdoc')).toContain('Aus Blob');
    });

    it('renders an external URL from a uri-list and allows forms', () => {
        render(
            <UIResource
                props={{
                    resource: {
                        uri: 'ui://demo/ext',
                        mimeType: 'text/uri-list',
                        text: '# comment\nhttps://example.com/app',
                    },
                }}
                onAction={onAction}
            />
        );
        const frame = screen.getByTitle('ui://demo/ext') as HTMLIFrameElement;
        expect(frame.getAttribute('src')).toBe('https://example.com/app');
        expect(frame.getAttribute('sandbox')).toContain('allow-forms');
    });

    it('rejects a non-http uri-list target', () => {
        render(
            <UIResource
                props={{
                    resource: {
                        uri: 'ui://demo/bad',
                        mimeType: 'text/uri-list',
                        text: 'javascript:alert(1)',
                    },
                }}
                onAction={onAction}
            />
        );
        expect(screen.queryByTitle('ui://demo/bad')).not.toBeInTheDocument();
        expect(screen.getByText(/keine gültige http/i)).toBeInTheDocument();
    });

    it('reports an unsupported mime type', () => {
        render(
            <UIResource
                props={{ resource: { uri: 'ui://demo/x', mimeType: 'application/pdf', text: '' } }}
                onAction={onAction}
            />
        );
        expect(screen.getByText(/nicht unterstütztem Typ/i)).toBeInTheDocument();
    });
});
