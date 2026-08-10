/**
 * Chat-Verlauf — Fassade über den Store-first-Schreibpfad (M15).
 *
 * Unterhaltungen und Nachrichten sind seit M15 Graph-Bürger: Wahrheit ist
 * der RDF-Store (`schema:Conversation` + `schema:Message`),
 * `data/chat/conversations.json` ist Projektion. Damit erben sie
 * Nutzergraphen, ACL, Volltextsuche und Export ohne eigenen Mechanismus.
 *
 * Zwei Dinge liegen bewusst im Präsentationsgraphen, nicht im Wissen
 * (Invariante 2): die zu einer Antwort erzeugte A2UI-Oberfläche
 * (`uiComponents`) und die zuletzt geöffnete Unterhaltung (`activeId`).
 */

import { getWorkspaceContext } from '@/lib/graph/server/instance';
import * as crud from '@/lib/graph/workspace/crud';

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    /**
     * Generative surface attached to this message (A2UI nodes).
     * Persisted so surfaces survive reloads — the interface is a function
     * of the conversation, so it must be reconstructable from it.
     */
    uiComponents?: unknown[];
}

export interface Conversation {
    id: string;
    title: string;
    messages: ChatMessage[];
    createdAt: string;
    updatedAt: string;
}

/** Dateiform von `data/chat/conversations.json` (Projektion). */
export interface ConversationsData {
    conversations: Conversation[];
    activeId: string | null;
}

// CRUD Operations
export async function listConversations(): Promise<Conversation[]> {
    return crud.listConversations(await getWorkspaceContext());
}

export async function getConversation(id: string): Promise<Conversation | null> {
    return crud.getConversation(await getWorkspaceContext(), id);
}

export async function createConversation(title?: string): Promise<Conversation> {
    return crud.createConversation(await getWorkspaceContext(), title);
}

export async function addMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    uiComponents?: unknown[],
): Promise<ChatMessage | null> {
    return crud.addMessage(await getWorkspaceContext(), conversationId, role, content, uiComponents);
}

export async function updateMessage(conversationId: string, messageId: string, content: string): Promise<ChatMessage | null> {
    return crud.updateMessage(await getWorkspaceContext(), conversationId, messageId, content);
}

export async function renameConversation(id: string, title: string): Promise<Conversation | null> {
    return crud.renameConversation(await getWorkspaceContext(), id, title);
}

export async function deleteConversation(id: string): Promise<boolean> {
    return crud.deleteConversation(await getWorkspaceContext(), id);
}

export async function setActiveConversation(id: string): Promise<void> {
    return crud.setActiveConversation(await getWorkspaceContext(), id);
}

export async function getActiveConversation(): Promise<Conversation | null> {
    const ctx = await getWorkspaceContext();
    const activeId = await crud.getActiveConversationId(ctx);
    if (!activeId) return null;
    return crud.getConversation(ctx, activeId);
}

export async function getActiveId(): Promise<string | null> {
    return crud.getActiveConversationId(await getWorkspaceContext());
}

export async function clearAllConversations(): Promise<void> {
    return crud.clearConversations(await getWorkspaceContext());
}
