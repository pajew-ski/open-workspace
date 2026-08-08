'use client';

import { useCallback, useState } from 'react';
import type { A2UINode } from '@/components/a2ui/types';

/**
 * Minimal conversation + streaming hook used by the full-page assistant.
 *
 * Embodies the generative-surface model: each assistant turn may carry a
 * surface (A2UI nodes) that replaces the stage; the latest non-empty
 * surface across the conversation is exposed as `activeSurface`, and a
 * compact summary of it is sent back into model context so the model can
 * modify or dismiss what is currently shown.
 */

export interface UIMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    uiComponents?: A2UINode[];
}

interface ChatContext {
    module: string;
    moduleDescription: string;
    pathname: string;
}

function summarizeSurface(nodes: A2UINode[] | undefined): Array<Record<string, unknown>> {
    if (!nodes || nodes.length === 0) return [];
    return nodes.map(node => {
        const type = Object.keys(node.component || {})[0] || 'Unknown';
        const nodeProps = (node.component as Record<string, Record<string, unknown>>)[type] || {};
        const summary: Record<string, unknown> = { id: node.id, type };
        for (const key of ['title', 'text', 'label', 'status', 'query', 'days', 'limit', 'uri']) {
            if (nodeProps[key] !== undefined) summary[key] = nodeProps[key];
        }
        return summary;
    });
}

function extractSurface(content: string): A2UINode[] | undefined {
    const match = content.match(/```a2ui\s*([\s\S]*?)\s*```/);
    if (!match) return undefined;
    try {
        const json = JSON.parse(match[1]);
        const comps = Array.isArray(json) ? json : json.components;
        return Array.isArray(comps) ? comps : undefined;
    } catch {
        return undefined;
    }
}

export function useConversation(conversationId: string | null, context: ChatContext) {
    const [messages, setMessages] = useState<UIMessage[]>([]);
    const [isLoading, setIsLoading] = useState(false);

    // The stage shows the most recent non-empty surface in the conversation.
    const activeSurface = [...messages].reverse()
        .find(m => m.role === 'assistant' && m.uiComponents && m.uiComponents.length > 0)?.uiComponents;

    const loadMessages = useCallback((loaded: UIMessage[]) => {
        setMessages(loaded);
    }, []);

    const sendMessage = useCallback(async (text: string) => {
        if (!text.trim() || !conversationId || isLoading) return;
        setIsLoading(true);

        const userMessage: UIMessage = {
            id: `local-user-${Date.now()}`,
            role: 'user',
            content: text,
            timestamp: new Date().toISOString(),
        };
        const assistantId = `local-assistant-${Date.now()}`;
        const priorMessages = messages;

        setMessages(prev => [
            ...prev,
            userMessage,
            { id: assistantId, role: 'assistant', content: '', timestamp: new Date().toISOString() },
        ]);

        // Persist the user turn
        fetch('/api/chat/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'addMessage', conversationId, role: 'user', content: text }),
        }).catch(() => { /* non-blocking */ });

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [...priorMessages, userMessage]
                        .filter(m => m.role !== 'assistant' || m.content)
                        .map(m => ({ role: m.role, content: m.content })),
                    context: {
                        ...context,
                        activeSurface: summarizeSurface(activeSurface),
                    },
                    stream: true,
                }),
            });

            if (!response.ok || !response.body) {
                let msg = `Fehler: ${response.status}`;
                try {
                    const err = await response.json();
                    msg = err.error || err.details || msg;
                } catch { /* keep default */ }
                throw new Error(msg);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullContent = '';
            let surface: A2UINode[] | undefined;

            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const chunk = JSON.parse(trimmed);
                        if (chunk.error) throw new Error(chunk.error);
                        if (chunk.message?.content) fullContent += chunk.message.content;
                    } catch (e) {
                        if (e instanceof Error && !e.message.includes('JSON')) throw e;
                    }
                }

                const parsed = extractSurface(fullContent);
                if (parsed !== undefined) surface = parsed;

                setMessages(prev => prev.map(m =>
                    m.id === assistantId ? { ...m, content: fullContent, uiComponents: surface } : m
                ));
            }

            // Persist the assistant turn with its surface
            if (fullContent) {
                fetch('/api/chat/conversations', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'addMessage',
                        conversationId,
                        role: 'assistant',
                        content: fullContent,
                        uiComponents: surface,
                    }),
                }).catch(() => { /* non-blocking */ });
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unbekannter Fehler';
            setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: `Fehler: ${msg}` } : m
            ));
        } finally {
            setIsLoading(false);
        }
    }, [conversationId, isLoading, messages, context, activeSurface]);

    return { messages, isLoading, activeSurface, sendMessage, loadMessages, setMessages };
}
