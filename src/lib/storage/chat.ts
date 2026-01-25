/**
 * Chat Storage - Conversation persistence
 */

import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data', 'chat');
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
}

export interface Conversation {
    id: string;
    title: string;
    messages: ChatMessage[];
    createdAt: string;
    updatedAt: string;
}

export interface ConversationsData {
    conversations: Conversation[];
    activeId: string | null;
}

async function ensureDataFile(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
        await fs.access(CONVERSATIONS_FILE);
    } catch {
        const initialData: ConversationsData = {
            conversations: [],
            activeId: null,
        };
        await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify(initialData, null, 2));
    }
}

async function readData(): Promise<ConversationsData> {
    await ensureDataFile();
    const content = await fs.readFile(CONVERSATIONS_FILE, 'utf-8');
    return JSON.parse(content);
}

async function writeData(data: ConversationsData): Promise<void> {
    await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify(data, null, 2));
}

function generateId(): string {
    return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateMessageId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// CRUD Operations
export async function listConversations(): Promise<Conversation[]> {
    const data = await readData();
    return data.conversations.sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
}

export async function getConversation(id: string): Promise<Conversation | null> {
    const data = await readData();
    return data.conversations.find(c => c.id === id) || null;
}

export async function createConversation(title?: string): Promise<Conversation> {
    const data = await readData();
    const now = new Date().toISOString();

    const conversation: Conversation = {
        id: generateId(),
        title: title || `Chat ${new Date().toLocaleDateString('de-DE')}`,
        messages: [],
        createdAt: now,
        updatedAt: now,
    };

    data.conversations.unshift(conversation);
    data.activeId = conversation.id;
    await writeData(data);

    return conversation;
}

export async function addMessage(conversationId: string, role: 'user' | 'assistant', content: string): Promise<ChatMessage | null> {
    const data = await readData();
    const conv = data.conversations.find(c => c.id === conversationId);
    if (!conv) return null;

    const message: ChatMessage = {
        id: generateMessageId(),
        role,
        content,
        timestamp: new Date().toISOString(),
    };

    conv.messages.push(message);
    conv.updatedAt = new Date().toISOString();

    // Auto-title from first user message
    if (conv.messages.filter(m => m.role === 'user').length === 1 && role === 'user') {
        conv.title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
    }

    await writeData(data);
    return message;
}

export async function updateMessage(conversationId: string, messageId: string, content: string): Promise<ChatMessage | null> {
    const data = await readData();
    const conv = data.conversations.find(c => c.id === conversationId);
    if (!conv) return null;

    const msg = conv.messages.find(m => m.id === messageId);
    if (!msg) return null;

    msg.content = content;
    conv.updatedAt = new Date().toISOString();

    await writeData(data);
    return msg;
}

export async function renameConversation(id: string, title: string): Promise<Conversation | null> {
    const data = await readData();
    const conv = data.conversations.find(c => c.id === id);
    if (!conv) return null;

    conv.title = title;
    conv.updatedAt = new Date().toISOString();

    await writeData(data);
    return conv;
}

export async function deleteConversation(id: string): Promise<boolean> {
    const data = await readData();
    const index = data.conversations.findIndex(c => c.id === id);
    if (index === -1) return false;

    data.conversations.splice(index, 1);
    if (data.activeId === id) {
        data.activeId = data.conversations[0]?.id || null;
    }

    await writeData(data);
    return true;
}

export async function setActiveConversation(id: string): Promise<void> {
    const data = await readData();
    data.activeId = id;
    await writeData(data);
}

export async function getActiveConversation(): Promise<Conversation | null> {
    const data = await readData();
    if (!data.activeId) return null;
    return data.conversations.find(c => c.id === data.activeId) || null;
}

export async function getActiveId(): Promise<string | null> {
    const data = await readData();
    return data.activeId;
}

export async function clearAllConversations(): Promise<void> {
    const data: ConversationsData = {
        conversations: [],
        activeId: null,
    };
    await writeData(data);
}
