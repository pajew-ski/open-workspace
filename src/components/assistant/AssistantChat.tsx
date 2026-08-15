'use client';

import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { useAssistantContext } from '@/lib/assistant/context';
import { useSelfModel } from '@/lib/assistant/useSelfModel';
import { moduleForPath } from '@/lib/graph/meta/self-model-view';
import { ConfirmDialog } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { A2UIRenderer } from '../a2ui/A2UIRenderer';
import { A2UINode, UIResourceContent, type A2UIValue } from '../a2ui/types';
import { MessageContent } from './MessageContent';
import { ModelPicker } from './ModelPicker';
import { runAssistantTurn } from '@/lib/ai/transport';
import { uiResourceNodes } from '@/lib/assistant/useConversation';
import { useAIState, useActiveSelection } from '@/lib/ai/useAI';
import { resolveRoute } from '@/lib/ai/store.client';
import * as chatGateway from '@/lib/chat/gateway';
import './MessageContent.css';
import styles from './AssistantChat.module.css';

/**
 * Ausschnitte fremder API-Antworten, die nur in den Kontext-Text
 * einfließen. Bewusst schmal: hier wird gelesen, nicht modelliert.
 */
interface CalendarEventSummary { startDate: string; title: string; location?: string }
interface ProjectSummary { id: string; title: string }
interface TaskSummary { status: string; title: string; projectId?: string }

interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    uiComponents?: A2UINode[];
    timestamp: string;
}

interface Conversation {
    id: string;
    title: string;
    messages: ChatMessage[];
    createdAt: string;
    updatedAt: string;
}


const MIN_WIDTH = 320;
const MIN_HEIGHT = 400;
const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 500;
const DEFAULT_INPUT_HEIGHT = 44;
const MIN_INPUT_HEIGHT = 44;

export function AssistantChat() {
    // Nur die stabile Einzelfunktion holen: useToast() liefert je Render
    // ein neues Objekt und würde jeden Callback darunter instabil machen.
    const { info: toastInfo } = useToast();
    // UI State - Initialize with defaults for SSR consistency
    const [isOpen, setIsOpen] = useState(false);
    const [showSidebar, setShowSidebar] = useState(false);
    const [width, setWidth] = useState(DEFAULT_WIDTH);
    const [height, setHeight] = useState(DEFAULT_HEIGHT);
    const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
    const [isMobile, setIsMobile] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);

    // Flag to indicate when settings are loaded from localStorage
    const [isSettingsLoaded, setIsSettingsLoaded] = useState(false);

    const [savedWindowState, setSavedWindowState] = useState<{
        width: number;
        height: number;
        position: { x: number; y: number } | null;
    } | null>(null);

    // Conversations State
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);

    // Input State
    const [inputHeight, setInputHeight] = useState(DEFAULT_INPUT_HEIGHT);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState<'unknown' | 'online' | 'offline'>('unknown');

    // Dialogs
    const [deleteConfirm, setDeleteConfirm] = useState<Conversation | null>(null);
    const [renameConv, setRenameConv] = useState<Conversation | null>(null);
    const [renameValue, setRenameValue] = useState('');

    // Refs
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    // Startgeometrie einer Größenänderung — inklusive Position, weil das
    // Ziehen an der linken/oberen Kante das Fenster mitverschiebt.
    const resizeRef = useRef<{
        startX: number; startY: number; startW: number; startH: number;
        startPosX: number; startPosY: number;
    } | null>(null);
    const inputResizeRef = useRef<{ startY: number; startH: number } | null>(null);
    const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
    const scrollRestoredRef = useRef(false);
    const lastInputResizeClickRef = useRef(0);
    const lastMessageCountRef = useRef(0);
    const isAtBottomRef = useRef(true); // Track if user is at bottom
    const lastScrolledMessageIdRef = useRef<string | null>(null); // Track which messages triggered scroll-to-top
    const pathname = usePathname();

    // Get viewState for dashboard and module-specific context
    const { viewState } = useAssistantContext();

    // Active inference selection (provider + model) — drives routing:
    // browser-direct or server relay, decided per provider.
    const { data: aiState } = useAIState();
    const { provider, model } = useActiveSelection(aiState);

    // Load settings from localStorage on mount (Client-side only)
    useEffect(() => {
        if (typeof window !== 'undefined') {
            const savedOpen = localStorage.getItem('assistant-open');
            if (savedOpen) setIsOpen(savedOpen === 'true');

            const savedWidth = localStorage.getItem('assistant-width');
            if (savedWidth) setWidth(Math.max(MIN_WIDTH, parseInt(savedWidth)));

            const savedHeight = localStorage.getItem('assistant-height');
            if (savedHeight) setHeight(Math.max(MIN_HEIGHT, parseInt(savedHeight)));

            const savedPos = localStorage.getItem('assistant-position');
            if (savedPos) {
                try {
                    const pos = JSON.parse(savedPos);
                    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
                        setPosition(pos);
                    }
                } catch { /* ignore */ }
            }

            const savedInputHeight = localStorage.getItem('assistant-input-height');
            if (savedInputHeight) setInputHeight(Math.max(MIN_INPUT_HEIGHT, parseInt(savedInputHeight)));

            setIsSettingsLoaded(true);
        }
    }, []);

    // Modul und Systemkontext kommen aus dem Selbstmodell des Graphen
    // (SPEC §18) — es gibt keine gepflegte Modul-Tabelle mehr. Ohne
    // erreichbares Backend bleibt beides leer statt veraltet.
    const { view: selfModel } = useSelfModel();
    const currentModule = useMemo(
        () => (selfModel ? moduleForPath(selfModel.modules, pathname) : null),
        [selfModel, pathname],
    );

    // Check mobile
    useEffect(() => {
        const checkMobile = () => setIsMobile(window.innerWidth < 768);
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    // Save input height
    useEffect(() => {
        if (isSettingsLoaded) {
            localStorage.setItem('assistant-input-height', String(inputHeight));
        }
    }, [inputHeight, isSettingsLoaded]);

    // Save open state
    useEffect(() => {
        if (isSettingsLoaded) {
            localStorage.setItem('assistant-open', String(isOpen));
        }
    }, [isOpen, isSettingsLoaded]);

    // Save size and position
    useEffect(() => {
        if (isSettingsLoaded) {
            localStorage.setItem('assistant-width', String(width));
            localStorage.setItem('assistant-height', String(height));
        }
    }, [width, height, isSettingsLoaded]);

    useEffect(() => {
        if (isSettingsLoaded && position) {
            localStorage.setItem('assistant-position', JSON.stringify(position));
        }
    }, [position, isSettingsLoaded]);

    // Check connection: probe the ACTIVE provider's resolved route
    // (browser-direct or server) — not just the server's default.
    useEffect(() => {
        let cancelled = false;
        const checkConnection = async () => {
            try {
                if (provider) {
                    const route = await resolveRoute(provider);
                    if (!cancelled) {
                        setConnectionStatus(route.probe?.status === 'online' || route.probe?.status === 'auth' ? 'online' : 'offline');
                    }
                    return;
                }
                const response = await fetch('/api/chat/health');
                const data = await response.json();
                if (!cancelled) setConnectionStatus(data.status === 'online' || data.status === 'browser-only' ? 'online' : 'offline');
            } catch {
                if (!cancelled) setConnectionStatus('offline');
            }
        };
        checkConnection();
        return () => { cancelled = true; };
    }, [provider]);

    // Load conversations — bewusst nur beim Mounten. `loadConversations`
    // legt bei leerem Bestand eine erste Unterhaltung an; als Dependency
    // würde das bei jedem Rendern erneut anlaufen.
    useEffect(() => {
        loadConversations();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Mount-Effekt, siehe oben
    }, []);

    // Simplified Scroll Logic
    // Smart Scroll Logic: "Fill then Stop"
    // Simplified Scroll Logic
    // Smart Scroll Logic: "Fill then Stop"
    const useChatScroll = (messages: ChatMessage[]) => {
        useLayoutEffect(() => {
            const container = messagesContainerRef.current;
            if (!container) return;

            const lastMessage = messages[messages.length - 1];
            const hasNewMessage = messages.length > lastMessageCountRef.current;
            lastMessageCountRef.current = messages.length;

            // 1. User Message: Always scroll to bottom
            if (lastMessage?.role === 'user') {
                messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
                return;
            }

            // 2. Assistant Message (Streaming or New)
            if (lastMessage?.role === 'assistant') {
                // Find the message element
                const msgEl = container.querySelector(`[data-message-id="${lastMessage.id}"]`);

                if (msgEl) {
                    const htmlMsgEl = msgEl as HTMLElement;
                    const msgHeight = htmlMsgEl.getBoundingClientRect().height;
                    const containerHeight = container.clientHeight;

                    // Strategy: "Fill then Anchor"
                    if (msgHeight < containerHeight) {
                        // Case A: Message fits in viewport -> Follow the bottom (Chat style)
                        container.scrollTop = container.scrollHeight;
                    } else {
                        // Case B: Message is taller than viewport -> Anchor to top (Document style)
                        // This ensures we never lose the start of the text.
                        // "End exactly at bottom of user message" = Align Top of Assistant Message to Top of Viewport

                        // We strictly verify if we are currently "below" the start point (cutting it off)
                        // If so, we snap back up.
                        // We use a small threshold (5px) to prevent fighting with manual micro-scrolls
                        if (container.scrollTop > htmlMsgEl.offsetTop - 20) {
                            container.scrollTop = htmlMsgEl.offsetTop - 20;
                        }
                    }
                } else if (hasNewMessage) {
                    // Fallback for first render
                    container.scrollTop = container.scrollHeight;
                }
            }
        }, [messages]);
    };

    useChatScroll(messages);

    // Helper function to find the first visible message element
    const findFirstVisibleMessage = useCallback(() => {
        const container = messagesContainerRef.current;
        if (!container) return null;

        const messageElements = container.querySelectorAll('[data-message-id]');
        for (const el of messageElements) {
            const rect = el.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            // Check if element is at least partially visible
            if (rect.top >= containerRect.top - 50 && rect.top < containerRect.bottom) {
                return {
                    id: el.getAttribute('data-message-id'),
                    offsetFromTop: rect.top - containerRect.top
                };
            }
        }
        return null;
    }, []);

    // Helper to check if scrolled to bottom
    const isAtBottom = useCallback(() => {
        const container = messagesContainerRef.current;
        if (!container) return false;
        // Consider "at bottom" if within 150px of the end (increased tolerance)
        return Math.abs(container.scrollHeight - container.scrollTop - container.clientHeight) < 150;
    }, []);

    // Restore scroll position using anchor-based approach
    // This survives content height changes from async Code/Mermaid rendering
    useLayoutEffect(() => {
        const container = messagesContainerRef.current;
        if (!container || messages.length === 0) return;

        if (!scrollRestoredRef.current) {
            const savedAnchor = localStorage.getItem('assistant-scroll-anchor');
            if (savedAnchor) {
                try {
                    const parsed = JSON.parse(savedAnchor);

                    // Special case: was at bottom - restore to bottom
                    if (parsed.isAtBottom) {
                        container.scrollTop = container.scrollHeight;
                    } else if (parsed.id) {
                        // Normal case: find anchor element and restore position
                        const anchorElement = container.querySelector(`[data-message-id="${parsed.id}"]`);
                        if (anchorElement) {
                            const containerRect = container.getBoundingClientRect();
                            const elementRect = anchorElement.getBoundingClientRect();
                            const currentOffset = elementRect.top - containerRect.top;
                            container.scrollTop += currentOffset - parsed.offsetFromTop;
                        }
                    }
                } catch { /* ignore parse errors */ }
            }
            scrollRestoredRef.current = true;
        }
    }, [messages, pathname]);

    // Save scroll anchor on scroll (debounced) & Track isAtBottom
    useEffect(() => {
        const container = messagesContainerRef.current;
        if (!container) return;

        let timeoutId: ReturnType<typeof setTimeout>;
        const handleScroll = () => {
            // Update tracking ref immediately
            isAtBottomRef.current = isAtBottom();

            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                // Check if at bottom first
                if (isAtBottom()) {
                    localStorage.setItem('assistant-scroll-anchor', JSON.stringify({ isAtBottom: true }));
                } else {
                    const anchor = findFirstVisibleMessage();
                    if (anchor) {
                        localStorage.setItem('assistant-scroll-anchor', JSON.stringify({ ...anchor, isAtBottom: false }));
                    }
                }
            }, 100); // Debounce 100ms
        };

        container.addEventListener('scroll', handleScroll, { passive: true });
        return () => {
            clearTimeout(timeoutId);
            container.removeEventListener('scroll', handleScroll);
        };
    }, [isOpen, findFirstVisibleMessage, isAtBottom]);



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
            const { conversations: loaded, activeId } = await chatGateway.listConversations();
            setConversations(loaded as Conversation[]);

            if (activeId) {
                const active = loaded.find(c => c.id === activeId) as Conversation | undefined;
                if (active) {
                    setActiveConversation(active);
                    setMessages(active.messages || []);
                    lastMessageCountRef.current = active.messages?.length || 0; // Sync count to prevent "new message" false positive
                    lastScrolledMessageIdRef.current = null; // Reset scroll tracker
                }
            }

            // Create default if none exist
            if (!loaded.length) {
                await createNewConversation();
            }
        } catch (error) {
            console.error('Failed to load conversations:', error);
        }
    };

    const createNewConversation = async () => {
        try {
            const conversation = await chatGateway.createConversation() as Conversation;
            setConversations(prev => [conversation, ...prev]);
            setActiveConversation(conversation);
            setMessages([]);
            setShowSidebar(false);
        } catch (error) {
            console.error('Failed to create conversation:', error);
        }
    };

    const selectConversation = async (conv: Conversation) => {
        setActiveConversation(conv);
        setMessages(conv.messages || []);
        lastMessageCountRef.current = conv.messages?.length || 0;
        lastScrolledMessageIdRef.current = null;
        // Prevent auto-scroll to top for existing messages
        if (conv.messages?.length > 0 && conv.messages[conv.messages.length - 1].role === 'assistant') {
            lastScrolledMessageIdRef.current = conv.messages[conv.messages.length - 1].id;
        }
        setShowSidebar(false);

        await chatGateway.setActiveConversation(conv.id);
    };

    const handleRename = async () => {
        if (!renameConv || !renameValue.trim()) return;

        try {
            await chatGateway.renameConversation(renameConv.id, renameValue);

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
            await chatGateway.deleteConversation(deleteConfirm.id);

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

        // User Message
        const userMessage: ChatMessage = {
            id: `msg-${Date.now()}`,
            role: 'user',
            content: userInput,
            timestamp: new Date().toISOString(),
        };

        setMessages(prev => [...prev, userMessage]);
        setIsLoading(true);

        try {
            await chatGateway.addMessage(activeConversation.id, 'user', userInput);
        } catch (e) { console.error('Failed to save user message', e); }

        // Assistant Placeholder
        const assistantId = `msg-${Date.now() + 1}`;
        setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '', timestamp: new Date().toISOString() }]);

        try {
            // Context Logic
            let additionalContext = '';

            // Re-implementing Context fetching
            if (pathname === '/calendar') {
                try {
                    const start = new Date();
                    const end = new Date();
                    end.setDate(end.getDate() + 7);
                    const res = await fetch(`/api/calendar?action=events&start=${start.toISOString()}&end=${end.toISOString()}`);
                    const data = await res.json();
                    if (data.events && data.events.length > 0) {
                        additionalContext += `\nAKTUELLE TERMINE (nachste 7 Tage):\n${data.events.map((e: CalendarEventSummary) =>
                            `- ${new Date(e.startDate).toLocaleString('de-DE')}: ${e.title} ${e.location ? `(${e.location})` : ''}`
                        ).join('\n')}`;
                    }
                } catch { /* ignore */ }
            }
            if (pathname === '/tasks') {
                try {
                    const [tasksRes, projsRes] = await Promise.all([fetch('/api/tasks'), fetch('/api/projects')]);
                    const [tasksData, projsData] = await Promise.all([tasksRes.json(), projsRes.json()]);
                    if (tasksData.tasks) {
                        const projectMap: Record<string, string> = {};
                        (projsData.projects || []).forEach((p: ProjectSummary) => projectMap[p.id] = p.title);
                        additionalContext += `\nAKTUELLE AUFGABEN:\n` + tasksData.tasks.slice(0, 20).map((t: TaskSummary) => {
                            let info = `- [${t.status.toUpperCase()}] ${t.title}`;
                            if (t.projectId) info += ` [${projectMap[t.projectId] || t.projectId}]`;
                            return info;
                        }).join('\n');
                    }
                } catch { /* ignore */ }
            }

            // Surface state flows back into model context: the model must
            // know what is currently on stage to modify or dismiss it
            // ("hide the map"). We send a compact structural summary, not
            // the full node tree.
            const lastSurface = [...messages].reverse()
                .find(m => m.role === 'assistant' && m.uiComponents?.length)?.uiComponents;
            const activeSurface = lastSurface
                ? lastSurface.map(node => {
                    const type = Object.keys(node.component || {})[0] || 'Unknown';
                    const nodeProps = (node.component as Record<string, Record<string, unknown>>)[type] || {};
                    const summary: Record<string, unknown> = {};
                    for (const key of ['title', 'text', 'label', 'status', 'query', 'days', 'limit', 'uri']) {
                        if (nodeProps[key] !== undefined) summary[key] = nodeProps[key];
                    }
                    return { id: node.id, type, ...summary };
                })
                : [];

            let fullContent = '';
            let currentUiComponents: A2UINode[] | undefined = undefined;
            const collectedResources: UIResourceContent[] = [];

            // The surface merges the model's a2ui block with any MCP-UI
            // resources delivered by tools during this turn.
            const applyUpdate = () => {
                let parsed: A2UINode[] | undefined;
                const match = fullContent.match(/```a2ui\s*([\s\S]*?)\s*```/);
                if (match) {
                    try {
                        const json = JSON.parse(match[1]);
                        const comps = Array.isArray(json) ? json : json.components;
                        if (Array.isArray(comps)) parsed = comps;
                    } catch { /* incomplete block while streaming */ }
                }
                const resourceNodes = uiResourceNodes(collectedResources);
                currentUiComponents = parsed !== undefined
                    ? [...parsed, ...resourceNodes]
                    : (resourceNodes.length > 0 ? resourceNodes : currentUiComponents);
                setMessages(prev => prev.map(m =>
                    m.id === assistantId
                        ? { ...m, content: fullContent, uiComponents: currentUiComponents || m.uiComponents }
                        : m
                ));
            };

            // Routing happens inside runAssistantTurn: server relay or
            // in-browser engine, depending on the selected provider.
            await runAssistantTurn({
                messages: [...messages, userMessage].filter(m => m.role !== 'assistant' || m.content).map(m => ({
                    role: m.role,
                    content: m.content,
                })),
                context: {
                    module: currentModule?.label ?? 'Open Workspace',
                    moduleDescription: (currentModule?.description ?? '') + additionalContext,
                    pathname,
                    viewState,
                    activeSurface,
                    // Für den Browser-Pfad (serverlos): der Serverpfad liest
                    // das Modell selbst aus dem Graphen.
                    ...(selfModel ? { selfModel } : {}),
                },
                provider,
                model,
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

            // Save assistant response
            if (fullContent || currentUiComponents) {
                await chatGateway.addMessage(
                    activeConversation.id,
                    'assistant',
                    fullContent,
                    // Persist the generative surface with the message —
                    // the interface must be reconstructable from the
                    // conversation alone.
                    currentUiComponents || undefined
                );

                if (messages.length === 0) {
                    setConversations(prev => prev.map(c =>
                        c.id === activeConversation.id ? { ...c, title: userInput.slice(0, 50) } : c
                    ));
                }
            } else {
                setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: 'Keine Antwort erhalten.' } : m));
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unbekannter Fehler';
            setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: ` ${errorMessage}` } : m));
            setConnectionStatus('offline');
        } finally {
            setIsLoading(false);
        }
    }, [messages, activeConversation, currentModule, selfModel, pathname, viewState, provider, model]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || isLoading) return;
        const userInput = input.trim();
        setInput('');

        // Keep focus for rapid chatting
        setTimeout(() => inputRef.current?.focus(), 0);

        await sendMessage(userInput);
    };

    // Resize handlers - supports all edges and corners
    type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
    const resizeDirectionRef = useRef<ResizeDirection | null>(null);

    const handleResizeStart = (direction: ResizeDirection) => (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const currentX = position?.x ?? (window.innerWidth - width - 20);
        const currentY = position?.y ?? (window.innerHeight - height - 90);
        resizeRef.current = {
            startX: e.clientX, startY: e.clientY, startW: width, startH: height,
            startPosX: currentX, startPosY: currentY,
        };
        resizeDirectionRef.current = direction;
        document.addEventListener('mousemove', handleResizeMove);
        document.addEventListener('mouseup', handleResizeEnd);
    };

    const handleResizeMove = useCallback((e: MouseEvent) => {
        if (!resizeRef.current || !resizeDirectionRef.current) return;
        const dir = resizeDirectionRef.current;
        const deltaX = e.clientX - resizeRef.current.startX;
        const deltaY = e.clientY - resizeRef.current.startY;
        const startData = resizeRef.current;

        let newWidth = startData.startW;
        let newHeight = startData.startH;
        let newX = startData.startPosX;
        let newY = startData.startPosY;

        // Handle horizontal resize
        if (dir.includes('e')) {
            newWidth = Math.max(MIN_WIDTH, startData.startW + deltaX);
        } else if (dir.includes('w')) {
            newWidth = Math.max(MIN_WIDTH, startData.startW - deltaX);
            newX = startData.startPosX + (startData.startW - newWidth);
        }

        // Handle vertical resize
        if (dir.includes('s')) {
            newHeight = Math.max(MIN_HEIGHT, startData.startH + deltaY);
        } else if (dir.includes('n')) {
            newHeight = Math.max(MIN_HEIGHT, startData.startH - deltaY);
            newY = startData.startPosY + (startData.startH - newHeight);
        }

        setWidth(newWidth);
        setHeight(newHeight);
        setPosition({ x: newX, y: newY });
    }, []);

    const handleResizeEnd = useCallback(() => {
        resizeRef.current = null;
        resizeDirectionRef.current = null;
        document.removeEventListener('mousemove', handleResizeMove);
        document.removeEventListener('mouseup', handleResizeEnd);
    }, [handleResizeMove]);

    // Drag handlers for moving the chat window
    const handleDragStart = (e: React.MouseEvent) => {
        // Don't start drag if clicking on a button
        const target = e.target as HTMLElement;
        if (target.closest('button')) {
            return; // Let the button handle the click
        }
        e.preventDefault();
        const currentX = position?.x ?? (window.innerWidth - width - 20);
        const currentY = position?.y ?? (window.innerHeight - height - 90);
        dragRef.current = { startX: e.clientX, startY: e.clientY, startPosX: currentX, startPosY: currentY };
        setIsDragging(true);
        document.addEventListener('mousemove', handleDragMove);
        document.addEventListener('mouseup', handleDragEnd);
    };

    const handleDragMove = useCallback((e: MouseEvent) => {
        if (!dragRef.current) return;
        const deltaX = e.clientX - dragRef.current.startX;
        const deltaY = e.clientY - dragRef.current.startY;
        const newX = Math.max(0, Math.min(window.innerWidth - width, dragRef.current.startPosX + deltaX));
        const newY = Math.max(0, Math.min(window.innerHeight - height, dragRef.current.startPosY + deltaY));
        setPosition({ x: newX, y: newY });
    }, [width, height]);

    const handleDragEnd = useCallback(() => {
        dragRef.current = null;
        setIsDragging(false);
        document.removeEventListener('mousemove', handleDragMove);
        document.removeEventListener('mouseup', handleDragEnd);
    }, [handleDragMove]);

    // Reset position to default (bottom-right)
    // Reset position to default (bottom-right)
    const resetPosition = () => {
        setPosition(null);
        setWidth(DEFAULT_WIDTH);
        setHeight(DEFAULT_HEIGHT);
        setInputHeight(DEFAULT_INPUT_HEIGHT);
        localStorage.removeItem('assistant-position');
        localStorage.removeItem('assistant-width');
        localStorage.removeItem('assistant-height');
        localStorage.removeItem('assistant-input-height');
    };


    // Input Resize Logic
    const handleInputResizeStart = (e: React.MouseEvent) => {
        const now = Date.now();
        if (now - lastInputResizeClickRef.current < 300) { // 300ms threshold for double click
            // Double click detected - Reset
            setInputHeight(DEFAULT_INPUT_HEIGHT);
            return;
        }
        lastInputResizeClickRef.current = now;

        e.preventDefault();
        inputResizeRef.current = { startY: e.clientY, startH: inputHeight };
        document.addEventListener('mousemove', handleInputResizeMove);
        document.addEventListener('mouseup', handleInputResizeEnd);
    };

    const handleInputResizeMove = useCallback((e: MouseEvent) => {
        if (!inputResizeRef.current) return;
        const deltaY = inputResizeRef.current.startY - e.clientY;

        // Calculate dynamic max height: 50% of current chat window height
        const currentWindowHeight = isFullscreen ? window.innerHeight : height;
        const dynamicMaxHeight = currentWindowHeight * 0.5;

        const newHeight = Math.max(MIN_INPUT_HEIGHT, Math.min(dynamicMaxHeight, inputResizeRef.current.startH + deltaY));
        setInputHeight(newHeight);
    }, [height, isFullscreen]);

    const handleInputResizeEnd = useCallback(() => {
        inputResizeRef.current = null;
        document.removeEventListener('mousemove', handleInputResizeMove);
        document.removeEventListener('mouseup', handleInputResizeEnd);
    }, [handleInputResizeMove]);



    const toggleFullscreen = useCallback(() => {
        if (!isFullscreen) {
            // Enter fullscreen: save current state
            setSavedWindowState({
                width,
                height,
                position
            });
            setIsFullscreen(true);
        } else {
            // Exit fullscreen: restore state
            if (savedWindowState) {
                setWidth(savedWindowState.width);
                setHeight(savedWindowState.height);
                setPosition(savedWindowState.position);
            }
            setIsFullscreen(false);
        }
    }, [isFullscreen, width, height, position, savedWindowState]);

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
    };

    const formatTime = (timestamp: string) => {
        return new Date(timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    };

    const handleUserAction = useCallback(async (actionId: string, payload?: A2UIValue) => {
        // MCP-UI events from embedded resources (sandboxed iframes)
        if (actionId.startsWith('mcpui:')) {
            const kind = actionId.slice('mcpui:'.length);
            if (kind === 'link' && typeof payload?.url === 'string' && /^https?:\/\//i.test(payload.url)) {
                window.open(payload.url, '_blank', 'noopener,noreferrer');
                return;
            }
            if (kind === 'prompt' && typeof payload?.prompt === 'string') {
                await sendMessage(payload.prompt);
                return;
            }
            if (kind === 'tool' && typeof payload?.toolName === 'string') {
                await sendMessage(
                    `[User Action: Führe das Tool "${payload.toolName}" aus mit Parametern ${JSON.stringify(payload.params ?? {})}]`
                );
                return;
            }
            if (kind === 'notify') {
                toastInfo(typeof payload?.message === 'string' ? payload.message : 'Hinweis aus eingebetteter UI');
                return;
            }
            // intent and unknown kinds fall through as context message
            await sendMessage(`[User Action: ${actionId} ${JSON.stringify(payload ?? {})}]`);
            return;
        }

        // A2UI actions return to the model as a user-visible action marker
        await sendMessage(`[User Action: ${actionId}]`);
    }, [sendMessage, toastInfo]);

    // The full-page assistant (/assistant) is the assistant on that route —
    // don't also float the widget there.
    if (pathname === '/assistant') {
        return null;
    }

    return (
        <div className={styles.container}>
            {isOpen && (
                <div
                    data-testid="assistant-chat-window"
                    role="dialog"
                    aria-label="Assistent"
                    aria-modal={isMobile || undefined}
                    className={`${styles.chatWindow} ${isMobile ? styles.mobile : ''} ${showSidebar ? styles.showSidebar : ''} ${isDragging ? styles.dragging : ''} ${isFullscreen ? styles.fullscreen : ''}`}
                    style={(!isMobile && !isFullscreen) ? {
                        width,
                        height,
                        ...(position ? {
                            left: position.x,
                            top: position.y,
                            right: 'auto',
                            bottom: 'auto'
                        } : {})
                    } : undefined}
                >
                    {/* Resize handles - all edges and corners (disabled in fullscreen) */}
                    {(!isMobile && !isFullscreen) && (
                        <>
                            <div className={`${styles.resizeHandle} ${styles.resizeN}`} onMouseDown={handleResizeStart('n')} />
                            <div className={`${styles.resizeHandle} ${styles.resizeS}`} onMouseDown={handleResizeStart('s')} />
                            <div className={`${styles.resizeHandle} ${styles.resizeE}`} onMouseDown={handleResizeStart('e')} />
                            <div className={`${styles.resizeHandle} ${styles.resizeW}`} onMouseDown={handleResizeStart('w')} />
                            <div className={`${styles.resizeHandle} ${styles.resizeNE}`} onMouseDown={handleResizeStart('ne')} />
                            <div className={`${styles.resizeHandle} ${styles.resizeNW}`} onMouseDown={handleResizeStart('nw')} />
                            <div className={`${styles.resizeHandle} ${styles.resizeSE}`} onMouseDown={handleResizeStart('se')} />
                            <div className={`${styles.resizeHandle} ${styles.resizeSW}`} onMouseDown={handleResizeStart('sw')} />
                        </>
                    )}

                    {/* Header - draggable (disabled in fullscreen) */}
                    <div
                        className={`${styles.header} ${(!isMobile && !isFullscreen) ? styles.draggable : ''}`}
                        onMouseDown={(!isMobile && !isFullscreen) ? handleDragStart : undefined}
                        onDoubleClick={toggleFullscreen}
                    >
                        <button className={styles.menuButton} onClick={(e) => { e.stopPropagation(); setShowSidebar(!showSidebar); }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
                            </svg>
                        </button>
                        <div className={styles.headerInfo}>
                            <span className={styles.title}>{activeConversation?.title || 'Neuer Chat'}</span>
                            <span className={styles.context}>
                                {currentModule?.label ?? 'Open Workspace'}
                                <span className={`${styles.status} ${styles[connectionStatus]}`} />
                            </span>
                        </div>
                        {!isMobile && (
                            <button className={styles.actionButton} onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }} title={isFullscreen ? "Fenster wiederherstellen" : "Vollbild"}>
                                {isFullscreen ? (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
                                    </svg>
                                ) : (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                                    </svg>
                                )}
                            </button>
                        )}
                        {(position && !isFullscreen) && (
                            <button className={styles.resetPositionButton} onClick={(e) => { e.stopPropagation(); resetPosition(); }} title="Position zurucksetzen">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                                    <path d="M3 3v5h5" />
                                </svg>
                            </button>
                        )}
                        <button className={styles.newChatButton} onClick={(e) => { e.stopPropagation(); createNewConversation(); }} title="Neuer Chat (Cmd+N)">
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

                    {/* Model bar: active provider · model with routing badge */}
                    <div className={styles.modelBar}>
                        <ModelPicker compact />
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

                    {/*
                      * Messages — Live-Region (TODO P2 „A11y-Feinschliff").
                      *
                      * `role="log"` bringt `aria-live="polite"` mit: neue
                      * Beiträge werden vorgelesen, der Verlauf bleibt
                      * navigierbar. Während der Antwort steht
                      * `aria-busy` — sonst würde jeder gestreamte
                      * Textschnipsel eine eigene Ansage auslösen und der
                      * Screenreader spräche buchstabenweise. Was gerade
                      * passiert, sagt stattdessen die Statuszeile unten.
                      */}
                    <div
                        ref={messagesContainerRef}
                        className={styles.messages}
                        role="log"
                        aria-label="Chat-Verlauf"
                        aria-busy={isLoading || undefined}
                        onClick={() => showSidebar && setShowSidebar(false)}
                    >
                        {messages.length === 0 ? (
                            <div className={styles.emptyChat}>
                                <p>Wie kann ich dir helfen?</p>
                                <p className={styles.hint}>Druecke Cmd+Shift+A zum Oeffnen/Schliessen</p>
                            </div>
                        ) : (
                            messages.map(message => (
                                <div key={message.id} data-message-id={message.id} data-testid={`assistant-chat-message-${message.role}`} className={`${styles.message} ${styles[message.role]}`}>
                                    {message.role === 'user' ? (
                                        <div>{message.content}</div>
                                    ) : message.content ? (
                                        <MessageContent content={message.content} />
                                    ) : null}
                                    {message.uiComponents && (
                                        <div className={styles.uiContainer}>
                                            <A2UIRenderer components={message.uiComponents} onAction={handleUserAction} />
                                        </div>
                                    )}
                                    {(!message.content && !message.uiComponents && message.role === 'assistant') && <span className={styles.typing}><span></span><span></span><span></span></span>}
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

                    {/* Was der Assistent gerade tut — für Screenreader, die
                        den stummgeschalteten Verlauf nicht mitlesen. */}
                    <div className="visually-hidden" role="status">
                        {isLoading ? 'Der Assistent antwortet.' : ''}
                    </div>

                    {/* Input */}
                    <form onSubmit={handleSubmit} className={`${styles.inputForm} ${isMobile ? styles.inputFormMobile : ''}`} style={{ height: isMobile ? 'auto' : inputHeight }}>
                        {!isMobile && (
                            <div
                                className={styles.inputResizeHandle}
                                onMouseDown={handleInputResizeStart}
                                title="Größe ändern"
                            />
                        )}
                        <textarea
                            data-testid="assistant-chat-input"
                            ref={inputRef}
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handleSubmit(e);
                                }
                            }}
                            placeholder={connectionStatus === 'offline' ? 'AI offline...' : 'Schreib mir...'}
                            className={styles.input}
                            disabled={connectionStatus === 'offline'}
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck="false"
                            name="assistant-chat-input"
                            id="assistant-chat-input"
                            data-lpignore="true"
                            data-1p-ignore="true"
                            data-form-type="other"
                            data-bwignore="true"
                            aria-autocomplete="none"
                        />
                        <button type="submit" className={styles.sendButton} disabled={!input.trim() || isLoading}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                            </svg>
                        </button>
                    </form>
                </div>
            )}

            {/* FAB - hide in fullscreen */}
            {!isFullscreen && (
                <button data-testid="assistant-chat-fab" aria-label={isOpen ? 'Assistant schließen' : 'Assistant öffnen'} className={`${styles.fab} ${isOpen ? styles.fabActive : ''}`} onClick={() => setIsOpen(!isOpen)} title="⌘+Shift+A">
                    {isOpen ? (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    ) : (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                    )}
                    {connectionStatus === 'online' && !isOpen && <span className={styles.fabBadge} />}
                </button>
            )}

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
