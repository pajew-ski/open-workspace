'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { ConfirmDialog } from '@/components/ui';
import styles from './AssistantChat.module.css';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
}

interface Conversation {
    id: string;
    title: string;
    messages: Message[];
    createdAt: string;
    updatedAt: string;
}

interface StreamChunk {
    message: { content: string };
    done: boolean;
}

const MODULE_CONTEXT: Record<string, { name: string; description: string }> = {
    '/': { name: 'Dashboard', description: 'Übersicht und Schnellzugriff' },
    '/knowledge': { name: 'Wissensbasis', description: 'Notizen und Dokumente' },
    '/canvas': { name: 'Canvas', description: 'Visuelle Planung' },
    '/tasks': { name: 'Aufgaben', description: 'Projekt- und Aufgabenverwaltung' },
    '/calendar': { name: 'Kalender', description: 'Termine und Zeitplanung' },
    '/agents': { name: 'Agenten', description: 'A2A Agent-Konfiguration' },
    '/communication': { name: 'Kommunikation', description: 'Matrix Chat' },
    '/settings': { name: 'Einstellungen', description: 'App-Konfiguration' },
};

const MIN_WIDTH = 320;
const MIN_HEIGHT = 400;
const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 500;

export function AssistantChat() {
    // UI State
    const [isOpen, setIsOpen] = useState(false);
    const [showSidebar, setShowSidebar] = useState(false);
    const [width, setWidth] = useState(DEFAULT_WIDTH);
    const [height, setHeight] = useState(DEFAULT_HEIGHT);
    const [isMobile, setIsMobile] = useState(false);

    // Conversations State
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);

    // Input State
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState<'unknown' | 'online' | 'offline'>('unknown');

    // Dialogs
    const [deleteConfirm, setDeleteConfirm] = useState<Conversation | null>(null);
    const [renameConv, setRenameConv] = useState<Conversation | null>(null);
    const [renameValue, setRenameValue] = useState('');

    // Refs
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const resizeRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);
    const pathname = usePathname();

    // Improved context matching
    const currentModule = useMemo(() => {
        const routes = Object.keys(MODULE_CONTEXT).sort((a, b) => b.length - a.length);
        const match = routes.find(r => pathname === r || (r !== '/' && pathname.startsWith(r)));
        return match ? MODULE_CONTEXT[match] : MODULE_CONTEXT['/'];
    }, [pathname]);

    // Check mobile
    useEffect(() => {
        const checkMobile = () => setIsMobile(window.innerWidth < 768);
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    // Load persisted state
    useEffect(() => {
        const savedOpen = localStorage.getItem('assistant-open');
        const savedWidth = localStorage.getItem('assistant-width');
        const savedHeight = localStorage.getItem('assistant-height');

        if (savedOpen === 'true') setIsOpen(true);
        if (savedWidth) setWidth(Math.max(MIN_WIDTH, parseInt(savedWidth)));
        if (savedHeight) setHeight(Math.max(MIN_HEIGHT, parseInt(savedHeight)));
    }, []);

    // Save open state
    useEffect(() => {
        localStorage.setItem('assistant-open', String(isOpen));
    }, [isOpen]);

    // Save size
    useEffect(() => {
        localStorage.setItem('assistant-width', String(width));
        localStorage.setItem('assistant-height', String(height));
    }, [width, height]);

    // Check connection
    useEffect(() => {
        const checkConnection = async () => {
            try {
                const response = await fetch('/api/chat/health');
                const data = await response.json();
                setConnectionStatus(data.status === 'online' ? 'online' : 'offline');
            } catch {
                setConnectionStatus('offline');
            }
        };
        checkConnection();
    }, []);

    // Load conversations
    useEffect(() => {
        loadConversations();
    }, []);

    // Scroll to bottom
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Focus input
    useEffect(() => {
        if (isOpen && inputRef.current) inputRef.current.focus();
    }, [isOpen, activeConversation]);

    // Keyboard shortcut
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'a') {
                e.preventDefault();
                setIsOpen(prev => !prev);
            }
            if ((e.metaKey || e.ctrlKey) && e.key === 'n' && isOpen) {
                e.preventDefault();
                createNewConversation();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen]);

    const loadConversations = async () => {
        try {
            const response = await fetch('/api/chat/conversations');
            const data = await response.json();
            setConversations(data.conversations || []);

            if (data.activeId) {
                const active = data.conversations?.find((c: Conversation) => c.id === data.activeId);
                if (active) {
                    setActiveConversation(active);
                    setMessages(active.messages || []);
                }
            }

            // Create default if none exist
            if (!data.conversations?.length) {
                await createNewConversation();
            }
        } catch (error) {
            console.error('Failed to load conversations:', error);
        }
    };

    const createNewConversation = async () => {
        try {
            const response = await fetch('/api/chat/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'create' }),
            });
            const data = await response.json();
            setConversations(prev => [data.conversation, ...prev]);
            setActiveConversation(data.conversation);
            setMessages([]);
            setShowSidebar(false);
        } catch (error) {
            console.error('Failed to create conversation:', error);
        }
    };

    const selectConversation = async (conv: Conversation) => {
        setActiveConversation(conv);
        setMessages(conv.messages || []);
        setShowSidebar(false);

        await fetch('/api/chat/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'setActive', id: conv.id }),
        });
    };

    const handleRename = async () => {
        if (!renameConv || !renameValue.trim()) return;

        try {
            await fetch('/api/chat/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'rename', id: renameConv.id, title: renameValue }),
            });

            setConversations(prev => prev.map(c =>
                c.id === renameConv.id ? { ...c, title: renameValue } : c
            ));
            if (activeConversation?.id === renameConv.id) {
                setActiveConversation(prev => prev ? { ...prev, title: renameValue } : prev);
            }
            setRenameConv(null);
        } catch (error) {
            console.error('Failed to rename:', error);
        }
    };

    const handleDelete = async () => {
        if (!deleteConfirm) return;

        try {
            await fetch('/api/chat/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'delete', id: deleteConfirm.id }),
            });

            setConversations(prev => prev.filter(c => c.id !== deleteConfirm.id));
            if (activeConversation?.id === deleteConfirm.id) {
                const remaining = conversations.filter(c => c.id !== deleteConfirm.id);
                if (remaining.length > 0) {
                    selectConversation(remaining[0]);
                } else {
                    await createNewConversation();
                }
            }
            setDeleteConfirm(null);
        } catch (error) {
            console.error('Failed to delete:', error);
        }
    };

    const sendMessage = useCallback(async (userInput: string) => {
        if (!activeConversation) return;

        const userMessage: Message = {
            id: `msg-${Date.now()}`,
            role: 'user',
            content: userInput,
            timestamp: new Date().toISOString(),
        };

        setMessages(prev => [...prev, userMessage]);
        setIsLoading(true);

        // Save user message
        await fetch('/api/chat/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'addMessage',
                conversationId: activeConversation.id,
                role: 'user',
                content: userInput,
            }),
        });

        // Create placeholder
        const assistantId = `msg-${Date.now() + 1}`;
        setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '', timestamp: new Date().toISOString() }]);

        try {
            // Fetch calendar events if on calendar page
            let additionalContext = '';
            if (pathname === '/calendar') {
                try {
                    const start = new Date();
                    const end = new Date();
                    end.setDate(end.getDate() + 7); // Next 7 days

                    const res = await fetch(`/api/calendar?action=events&start=${start.toISOString()}&end=${end.toISOString()}`);
                    const data = await res.json();
                    if (data.events && data.events.length > 0) {
                        additionalContext = `\nAKTUELLE TERMINE (nächste 7 Tage):\n${data.events.map((e: any) =>
                            `- ${new Date(e.startDate).toLocaleString('de-DE')}: ${e.title} ${e.location ? `(${e.location})` : ''}`
                        ).join('\n')}`;
                    } else {
                        additionalContext = '\nAKTUELLE TERMINE: Keine Termine in den nächsten 7 Tagen gefunden.';
                    }
                } catch (e) {
                    console.error('Failed to fetch calendar context', e);
                }
            }

            // Fetch tasks and projects if on tasks page
            if (pathname === '/tasks') {
                try {
                    const [tasksRes, projsRes] = await Promise.all([
                        fetch('/api/tasks'),
                        fetch('/api/projects')
                    ]);
                    const [tasksData, projsData] = await Promise.all([
                        tasksRes.json(),
                        projsRes.json()
                    ]);

                    if (tasksData.tasks) {
                        const projectMap: Record<string, string> = {};
                        (projsData.projects || []).forEach((p: any) => projectMap[p.id] = p.title);

                        additionalContext = `\nAKTUELLE AUFGABEN & PROJEKTE:\n`;
                        additionalContext += `Projekte: ${(projsData.projects || []).map((p: any) => p.title).join(', ') || 'Keine Projekte'}\n`;
                        additionalContext += `Aufgaben:\n${tasksData.tasks.slice(0, 15).map((t: any) =>
                            `- [${t.status.toUpperCase()}] ${t.title} ${t.projectId ? `(Proj: ${projectMap[t.projectId] || t.projectId})` : ''} [Prio: ${t.priority}]`
                        ).join('\n')}`;
                        if (tasksData.tasks.length > 15) additionalContext += `\n... und ${tasksData.tasks.length - 15} weitere Aufgaben.`;
                    }
                } catch (e) {
                    console.error('Failed to fetch tasks context', e);
                }
            }

            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [...messages, userMessage].filter(m => m.role !== 'assistant' || m.content).map(m => ({
                        role: m.role,
                        content: m.content,
                    })),
                    context: {
                        module: currentModule.name,
                        moduleDescription: currentModule.description + additionalContext,
                        pathname
                    },
                    stream: true,
                }),
            });

            if (!response.ok) throw new Error('API request failed');

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No response body');

            const decoder = new TextDecoder();
            let fullContent = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const text = decoder.decode(value, { stream: true });
                const lines = text.split('\n').filter(line => line.trim());

                for (const line of lines) {
                    try {
                        const chunk: StreamChunk = JSON.parse(line);
                        if (chunk.message?.content) {
                            fullContent += chunk.message.content;
                            setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: fullContent } : m));
                        }
                    } catch { /* skip */ }
                }
            }

            // Save assistant response
            if (fullContent) {
                await fetch('/api/chat/conversations', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'addMessage',
                        conversationId: activeConversation.id,
                        role: 'assistant',
                        content: fullContent,
                    }),
                });

                // Update conversation title if first message
                if (messages.length === 0) {
                    setConversations(prev => prev.map(c =>
                        c.id === activeConversation.id ? { ...c, title: userInput.slice(0, 50) + (userInput.length > 50 ? '...' : '') } : c
                    ));
                }
            }

            if (!fullContent) {
                setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: 'Keine Antwort erhalten.' } : m));
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unbekannter Fehler';
            setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: `Fehler: ${errorMessage}` } : m));
            setConnectionStatus('offline');
        } finally {
            setIsLoading(false);
        }
    }, [messages, activeConversation, currentModule, pathname]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || isLoading) return;
        const userInput = input.trim();
        setInput('');
        await sendMessage(userInput);
    };

    // Resize handlers
    const handleResizeStart = (e: React.MouseEvent) => {
        e.preventDefault();
        resizeRef.current = { startX: e.clientX, startY: e.clientY, startW: width, startH: height };
        document.addEventListener('mousemove', handleResizeMove);
        document.addEventListener('mouseup', handleResizeEnd);
    };

    const handleResizeMove = useCallback((e: MouseEvent) => {
        if (!resizeRef.current) return;
        const deltaX = resizeRef.current.startX - e.clientX;
        const deltaY = resizeRef.current.startY - e.clientY;
        setWidth(Math.max(MIN_WIDTH, resizeRef.current.startW + deltaX));
        setHeight(Math.max(MIN_HEIGHT, resizeRef.current.startH + deltaY));
    }, []);

    const handleResizeEnd = useCallback(() => {
        resizeRef.current = null;
        document.removeEventListener('mousemove', handleResizeMove);
        document.removeEventListener('mouseup', handleResizeEnd);
    }, [handleResizeMove]);

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
    };

    const formatTime = (timestamp: string) => {
        return new Date(timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    };

    return (
        <div className={styles.container}>
            {isOpen && (
                <div
                    className={`${styles.chatWindow} ${isMobile ? styles.mobile : ''} ${showSidebar ? styles.showSidebar : ''}`}
                    style={!isMobile ? { width, height } : undefined}
                >
                    {/* Resize handle */}
                    {!isMobile && <div className={styles.resizeHandle} onMouseDown={handleResizeStart} />}

                    {/* Header */}
                    <div className={styles.header}>
                        <button className={styles.menuButton} onClick={() => setShowSidebar(!showSidebar)}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
                            </svg>
                        </button>
                        <div className={styles.headerInfo}>
                            <span className={styles.title}>{activeConversation?.title || 'Neuer Chat'}</span>
                            <span className={styles.context}>
                                {currentModule.name}
                                <span className={`${styles.status} ${styles[connectionStatus]}`} />
                            </span>
                        </div>
                        <button className={styles.newChatButton} onClick={createNewConversation} title="Neuer Chat (⌘N)">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                        </button>
                        <button className={styles.closeButton} onClick={() => setIsOpen(false)}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                        </button>
                    </div>

                    {/* Sidebar */}
                    <div className={`${styles.sidebar} ${showSidebar ? styles.open : ''}`}>
                        <div className={styles.sidebarHeader}>
                            <span>Konversationen</span>
                            <button onClick={createNewConversation}>+ Neu</button>
                        </div>
                        <div className={styles.conversationList}>
                            {conversations.map(conv => (
                                <div
                                    key={conv.id}
                                    className={`${styles.conversationItem} ${conv.id === activeConversation?.id ? styles.active : ''}`}
                                    onClick={() => selectConversation(conv)}
                                >
                                    <span className={styles.convTitle}>{conv.title}</span>
                                    <div className={styles.convActions}>
                                        <button onClick={(e) => { e.stopPropagation(); setRenameConv(conv); setRenameValue(conv.title); }} title="Umbenennen">Edit</button>
                                        <button onClick={(e) => { e.stopPropagation(); setDeleteConfirm(conv); }} title="Löschen">Del</button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Messages */}
                    <div className={styles.messages} onClick={() => showSidebar && setShowSidebar(false)}>
                        {messages.length === 0 ? (
                            <div className={styles.emptyChat}>
                                <p>Wie kann ich dir helfen?</p>
                                <p className={styles.hint}>Drücke ⌘+Shift+A zum Öffnen/Schließen</p>
                            </div>
                        ) : (
                            messages.map(message => (
                                <div key={message.id} className={`${styles.message} ${styles[message.role]}`}>
                                    {message.content || <span className={styles.typing}><span></span><span></span><span></span></span>}
                                    <div className={styles.messageFooter}>
                                        <span className={styles.timestamp}>{formatTime(message.timestamp)}</span>
                                        {message.role === 'assistant' && message.content && (
                                            <button className={styles.copyButton} onClick={() => copyToClipboard(message.content)} title="Kopieren">Copy</button>
                                        )}
                                    </div>
                                </div>
                            ))
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Input */}
                    <form onSubmit={handleSubmit} className={styles.inputForm}>
                        <input
                            ref={inputRef}
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder={connectionStatus === 'offline' ? 'AI offline...' : 'Schreib mir...'}
                            className={styles.input}
                            disabled={isLoading || connectionStatus === 'offline'}
                            autoComplete="off"
                            name="assistant-chat-input"
                            data-lpignore="true"
                            data-1p-ignore="true"
                        />
                        <button type="submit" className={styles.sendButton} disabled={!input.trim() || isLoading}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                            </svg>
                        </button>
                    </form>
                </div>
            )}

            {/* FAB */}
            <button className={`${styles.fab} ${isOpen ? styles.fabActive : ''}`} onClick={() => setIsOpen(!isOpen)} title="⌘+Shift+A">
                {isOpen ? (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                )}
                {connectionStatus === 'online' && !isOpen && <span className={styles.fabBadge} />}
            </button>

            {/* Rename Dialog */}
            {renameConv && (
                <div className={styles.dialogOverlay} onClick={() => setRenameConv(null)}>
                    <div className={styles.renameDialog} onClick={e => e.stopPropagation()}>
                        <h3>Chat umbenennen</h3>
                        <input
                            type="text"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
                            autoFocus
                        />
                        <div className={styles.dialogButtons}>
                            <button onClick={() => setRenameConv(null)}>Abbrechen</button>
                            <button onClick={handleRename} className={styles.primary}>Speichern</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Confirm */}
            <ConfirmDialog
                isOpen={deleteConfirm !== null}
                title="Chat löschen?"
                message={`Möchtest du "${deleteConfirm?.title}" wirklich löschen?`}
                confirmText="Löschen"
                cancelText="Abbrechen"
                variant="danger"
                onConfirm={handleDelete}
                onCancel={() => setDeleteConfirm(null)}
            />
        </div>
    );
}
