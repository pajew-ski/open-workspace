'use client';

/**
 * MCP-UI resource renderer (https://mcpui.dev / MCP Apps extension).
 *
 * Renders an embedded UI resource as delivered by MCP servers (or by our
 * own tools) inside a sandboxed iframe:
 *
 *   { resource: { uri: "ui://…", mimeType: "text/html", text: "<html>…" } }
 *   { resource: { uri: "ui://…", mimeType: "text/uri-list", text: "https://…" } }
 *
 * Interactions inside the frame reach the host through postMessage using
 * the mcp-ui event shape { type, payload } with type one of
 * tool | intent | prompt | notify | link. They are forwarded to the
 * A2UI ActionHandler as `mcpui:<type>` so the chat layer can decide what
 * to do (e.g. run a tool round or insert a prompt).
 *
 * Security: rawHtml frames run with sandbox="allow-scripts" only — no
 * same-origin access, no top navigation. External URLs additionally get
 * allow-forms. Height follows ui-size-change messages within bounds.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActionHandler } from '../types';

export interface UIResourcePayload {
    uri?: string;
    mimeType?: string;
    text?: string;
    blob?: string;
}

export interface UIResourceProps {
    resource: UIResourcePayload;
    /** Initial frame height in px (default 240) */
    height?: number;
}

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 1200;
const KNOWN_EVENT_TYPES = new Set(['tool', 'intent', 'prompt', 'notify', 'link']);

function decodeText(resource: UIResourcePayload): string {
    if (typeof resource.text === 'string') return resource.text;
    if (typeof resource.blob === 'string') {
        try {
            return atob(resource.blob);
        } catch {
            return '';
        }
    }
    return '';
}

function firstHttpUri(uriList: string): string | null {
    for (const line of uriList.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (/^https?:\/\//i.test(trimmed)) return trimmed;
    }
    return null;
}

export function UIResource({ props, onAction }: { props: UIResourceProps; onAction: ActionHandler }) {
    const resource = props?.resource || {};
    const [height, setHeight] = useState(() =>
        Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, props?.height || 240))
    );
    const iframeRef = useRef<HTMLIFrameElement>(null);

    const mode: 'html' | 'url' | 'unsupported' = useMemo(() => {
        const mime = (resource.mimeType || '').toLowerCase();
        if (mime.startsWith('text/html')) return 'html';
        if (mime.startsWith('text/uri-list')) return 'url';
        return 'unsupported';
    }, [resource.mimeType]);

    const content = useMemo(() => decodeText(resource), [resource]);
    const externalUrl = mode === 'url' ? firstHttpUri(content) : null;

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            // Only accept messages from our own frame
            if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
            const data = event.data;
            if (!data || typeof data !== 'object') return;

            if (data.type === 'ui-size-change' && typeof data.payload?.height === 'number') {
                setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, data.payload.height)));
                return;
            }
            if (typeof data.type === 'string' && KNOWN_EVENT_TYPES.has(data.type)) {
                onAction(`mcpui:${data.type}`, data.payload);
            }
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [onAction]);

    if (mode === 'unsupported') {
        return (
            <div className="ws-uiresource">
                <p className="ws-uiresource-error">
                    UI-Ressource mit nicht unterstütztem Typ: {resource.mimeType || 'unbekannt'}
                    {resource.uri ? ` (${resource.uri})` : ''}
                </p>
            </div>
        );
    }

    if (mode === 'url' && !externalUrl) {
        return (
            <div className="ws-uiresource">
                <p className="ws-uiresource-error">UI-Ressource enthält keine gültige http(s)-URL.</p>
            </div>
        );
    }

    return (
        <div className="ws-uiresource">
            {mode === 'html' ? (
                <iframe
                    ref={iframeRef}
                    title={resource.uri || 'Eingebettete UI'}
                    srcDoc={content}
                    sandbox="allow-scripts"
                    style={{ height }}
                />
            ) : (
                <iframe
                    ref={iframeRef}
                    title={resource.uri || 'Eingebettete UI'}
                    src={externalUrl || undefined}
                    sandbox="allow-scripts allow-forms"
                    style={{ height }}
                />
            )}
            <div className="ws-uiresource-meta">
                <span>{resource.uri || 'ui-resource'}</span>
                <span>{mode === 'html' ? 'eingebettet (sandboxed)' : 'extern (sandboxed)'}</span>
            </div>
        </div>
    );
}
