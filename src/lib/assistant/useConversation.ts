'use client';

import { useCallback, useState } from 'react';
import type { A2UINode, UIResourceContent } from '@/components/a2ui/types';
import { runAssistantTurn } from '@/lib/ai/transport';
import { addMessage as persistMessage } from '@/lib/chat/gateway';
import type { ClientProviderRecord } from '@/lib/ai/store.client';
import type { SelfModelView } from '@/lib/graph/meta/self-model-view';

/**
 * Conversation + streaming hook used by the full-page assistant.
 *
 * Embodies the generative-surface model: each assistant turn may carry a
 * surface (A2UI nodes) that replaces the stage; the latest non-empty
 * surface across the conversation is exposed as `activeSurface`, and a
 * compact summary of it is sent back into model context so the model can
 * modify or dismiss what is currently shown.
 *
 * Transport-agnostic: runAssistantTurn decides per selected provider
 * whether the turn runs on the server or directly in this browser.
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
    /** Selbstmodell für den Browser-Pfad (SPEC §18) — serverseitig liest die Route es selbst. */
    selfModel?: SelfModelView;
}

export interface ConversationOptions {
    provider?: ClientProviderRecord;
    model?: string;
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

/** Tool-delivered MCP-UI resources become UIResource nodes on the surface. */
export function uiResourceNodes(resources: UIResourceContent[]): A2UINode[] {
    return resources.map((resource, index) => ({
        id: `uires-${index}-${resource.uri ?? 'inline'}`,
        component: { UIResource: { resource, height: 360 } },
    }));
}

export function useConversation(
    conversationId: string | null,
    context: ChatContext,
    options: ConversationOptions = {}
) {
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

        // Persist the user turn (server or IndexedDB — gateway decides)
        void persistMessage(conversationId, 'user', text).catch(() => { /* non-blocking */ });

        let fullContent = '';
        let surface: A2UINode[] | undefined;
        const collectedResources: UIResourceContent[] = [];

        const applyUpdate = () => {
            const parsed = extractSurface(fullContent);
            const resourceNodes = uiResourceNodes(collectedResources);
            surface = parsed !== undefined
                ? [...parsed, ...resourceNodes]
                : (resourceNodes.length > 0 ? resourceNodes : surface);
            setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: fullContent, uiComponents: surface } : m
            ));
        };

        try {
            await runAssistantTurn({
                messages: [...priorMessages, userMessage]
                    .filter(m => m.role !== 'assistant' || m.content)
                    .map(m => ({ role: m.role, content: m.content })),
                context: {
                    ...context,
                    activeSurface: summarizeSurface(activeSurface),
                },
                provider: options.provider,
                model: options.model,
                handlers: {
                    onText: chunk => {
                        fullContent += chunk;
                        applyUpdate();
                    },
                    onUiResource: resource => {
                        collectedResources.push(resource);
                        applyUpdate();
                    },
                },
            });

            // Persist the assistant turn with its surface
            if (fullContent || surface) {
                void persistMessage(conversationId, 'assistant', fullContent, surface).catch(() => { /* non-blocking */ });
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unbekannter Fehler';
            setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: `Fehler: ${msg}` } : m
            ));
        } finally {
            setIsLoading(false);
        }
    }, [conversationId, isLoading, messages, context, activeSurface, options.provider, options.model]);

    return { messages, isLoading, activeSurface, sendMessage, loadMessages, setMessages };
}
