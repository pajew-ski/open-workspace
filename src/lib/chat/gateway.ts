'use client';

import type { A2UINode } from '@/components/a2ui/types';
import { checkBackend } from '@/lib/platform/backend';
import { idbClear, idbDelete, idbGet, idbGetAll, idbPut, STORES } from '@/lib/platform/idb';

/**
 * Conversation persistence gateway. With a reachable backend it speaks
 * the existing /api/chat/conversations protocol; without one it stores
 * conversations in IndexedDB — chat history works serverless and
 * offline (PWA), which is a precondition for the backend-free assistant.
 */

export interface GatewayMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    uiComponents?: A2UINode[];
    timestamp: string;
}

export interface GatewayConversation {
    id: string;
    title: string;
    messages: GatewayMessage[];
    createdAt: string;
    updatedAt: string;
}

const ACTIVE_KEY = 'activeConversationId';

async function backendAvailable(): Promise<boolean> {
    return (await checkBackend()) === 'available';
}

// ------------------------------------------------------------------
// Local (IndexedDB) implementation
// ------------------------------------------------------------------

function newId(): string {
    return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function localList(): Promise<{ conversations: GatewayConversation[]; activeId: string | null }> {
    try {
        const conversations = await idbGetAll<GatewayConversation>(STORES.conversations);
        conversations.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        const activeId = (await idbGet<string>(STORES.meta, ACTIVE_KEY)) ?? null;
        return { conversations, activeId };
    } catch {
        return { conversations: [], activeId: null };
    }
}

async function localCreate(title?: string): Promise<GatewayConversation> {
    const now = new Date().toISOString();
    const conversation: GatewayConversation = {
        id: newId(),
        title: title || 'Neue Konversation',
        messages: [],
        createdAt: now,
        updatedAt: now,
    };
    await idbPut(STORES.conversations, conversation);
    await idbPut(STORES.meta, conversation.id, ACTIVE_KEY);
    return conversation;
}

async function localAddMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    uiComponents?: A2UINode[]
): Promise<GatewayMessage | null> {
    const conversation = await idbGet<GatewayConversation>(STORES.conversations, conversationId);
    if (!conversation) return null;
    const message: GatewayMessage = {
        id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        role,
        content,
        uiComponents,
        timestamp: new Date().toISOString(),
    };
    conversation.messages.push(message);
    conversation.updatedAt = message.timestamp;
    if (conversation.messages.length === 1 && role === 'user') {
        conversation.title = content.slice(0, 50);
    }
    await idbPut(STORES.conversations, conversation);
    return message;
}

// ------------------------------------------------------------------
// Gateway API
// ------------------------------------------------------------------

export async function listConversations(): Promise<{ conversations: GatewayConversation[]; activeId: string | null }> {
    if (await backendAvailable()) {
        try {
            const response = await fetch('/api/chat/conversations');
            if (response.ok) {
                const data = await response.json();
                return { conversations: data.conversations ?? [], activeId: data.activeId ?? null };
            }
        } catch {
            // fall back to local
        }
    }
    return localList();
}

export async function createConversation(title?: string): Promise<GatewayConversation> {
    if (await backendAvailable()) {
        try {
            const response = await fetch('/api/chat/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'create', title }),
            });
            if (response.ok) {
                const data = await response.json();
                return data.conversation;
            }
        } catch {
            // fall back to local
        }
    }
    return localCreate(title);
}

export async function addMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    uiComponents?: A2UINode[]
): Promise<void> {
    if (await backendAvailable()) {
        try {
            const response = await fetch('/api/chat/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'addMessage', conversationId, role, content, uiComponents }),
            });
            if (response.ok) return;
        } catch {
            // fall back to local
        }
    }
    await localAddMessage(conversationId, role, content, uiComponents);
}

export async function renameConversation(id: string, title: string): Promise<void> {
    if (await backendAvailable()) {
        try {
            const response = await fetch('/api/chat/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'rename', id, title }),
            });
            if (response.ok) return;
        } catch { /* fall back */ }
    }
    const conversation = await idbGet<GatewayConversation>(STORES.conversations, id);
    if (conversation) {
        conversation.title = title;
        conversation.updatedAt = new Date().toISOString();
        await idbPut(STORES.conversations, conversation);
    }
}

export async function deleteConversation(id: string): Promise<void> {
    if (await backendAvailable()) {
        try {
            const response = await fetch('/api/chat/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'delete', id }),
            });
            if (response.ok) return;
        } catch { /* fall back */ }
    }
    await idbDelete(STORES.conversations, id);
}

export async function setActiveConversation(id: string): Promise<void> {
    if (await backendAvailable()) {
        try {
            const response = await fetch('/api/chat/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'setActive', id }),
            });
            if (response.ok) return;
        } catch { /* fall back */ }
    }
    try {
        await idbPut(STORES.meta, id, ACTIVE_KEY);
    } catch { /* storage unavailable */ }
}

export async function clearAllConversations(): Promise<void> {
    if (await backendAvailable()) {
        try {
            const response = await fetch('/api/chat/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'clearAll' }),
            });
            if (response.ok) return;
        } catch { /* fall back */ }
    }
    await idbClear(STORES.conversations);
}
