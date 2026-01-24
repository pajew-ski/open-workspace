'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import styles from './AssistantChat.module.css';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}

interface StreamChunk {
    message: {
        content: string;
    };
    done: boolean;
}

const MODULE_CONTEXT: Record<string, { name: string; description: string }> = {
    '/': { name: 'Dashboard', description: 'Übersicht und Schnellzugriff' },
    '/knowledge': { name: 'Wissensbasis', description: 'Notizen und Dokumente' },
    '/canvas': { name: 'Canvas', description: 'Visuelle Planung' },
    '/tasks': { name: 'Aufgaben', description: 'Projekt- und Aufgabenverwaltung' },
    '/agents': { name: 'Agenten', description: 'A2A Agent-Konfiguration' },
    '/communication': { name: 'Kommunikation', description: 'Matrix Chat' },
    '/settings': { name: 'Einstellungen', description: 'App-Konfiguration' },
};

export function AssistantChat() {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<Message[]>([
        {
            id: '1',
            role: 'assistant',
            content: 'Hey! Ich bin dein persönlicher Assistent. Wie kann ich dir helfen?',
            timestamp: new Date(),
        },
    ]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState<'unknown' | 'online' | 'offline'>('unknown');
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const pathname = usePathname();

    const currentModule = MODULE_CONTEXT[pathname] || MODULE_CONTEXT['/'];

    // Check connection status on mount
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

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isOpen]);

    const sendMessage = useCallback(async (userInput: string) => {
        const userMessage: Message = {
            id: Date.now().toString(),
            role: 'user',
            content: userInput,
            timestamp: new Date(),
        };

        setMessages((prev) => [...prev, userMessage]);
        setIsLoading(true);

        // Create placeholder for assistant response
        const assistantId = (Date.now() + 1).toString();
        setMessages((prev) => [
            ...prev,
            {
                id: assistantId,
                role: 'assistant',
                content: '',
                timestamp: new Date(),
            },
        ]);

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    messages: [...messages, userMessage].filter(m => m.role !== 'assistant' || m.content).map(m => ({
                        role: m.role,
                        content: m.content,
                    })),
                    context: {
                        module: currentModule.name,
                        moduleDescription: currentModule.description,
                        pathname,
                    },
                    stream: true,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'API request failed');
            }

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
                            setMessages((prev) =>
                                prev.map((m) =>
                                    m.id === assistantId
                                        ? { ...m, content: fullContent }
                                        : m
                                )
                            );
                        }
                    } catch {
                        // Skip invalid JSON
                    }
                }
            }

            // Ensure we have content
            if (!fullContent) {
                setMessages((prev) =>
                    prev.map((m) =>
                        m.id === assistantId
                            ? { ...m, content: 'Entschuldigung, ich konnte keine Antwort generieren. Bitte versuche es erneut.' }
                            : m
                    )
                );
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unbekannter Fehler';
            setMessages((prev) =>
                prev.map((m) =>
                    m.id === assistantId
                        ? {
                            ...m,
                            content: `Verbindungsfehler: ${errorMessage}\n\nStelle sicher, dass Ollama unter 192.168.42.2:11434 erreichbar ist.`
                        }
                        : m
                )
            );
            setConnectionStatus('offline');
        } finally {
            setIsLoading(false);
        }
    }, [messages, currentModule, pathname]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || isLoading) return;

        const userInput = input.trim();
        setInput('');
        await sendMessage(userInput);
    };

    return (
        <div className={styles.container}>
            {isOpen && (
                <div className={styles.chatWindow}>
                    <div className={styles.header}>
                        <div className={styles.headerInfo}>
                            <span className={styles.title}>Persönlicher Assistent</span>
                            <span className={styles.context}>
                                {currentModule.name}
                                <span className={`${styles.status} ${styles[connectionStatus]}`} />
                            </span>
                        </div>
                        <button
                            className={styles.closeButton}
                            onClick={() => setIsOpen(false)}
                            aria-label="Chat schließen"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                        </button>
                    </div>

                    <div className={styles.messages}>
                        {messages.map((message) => (
                            <div
                                key={message.id}
                                className={`${styles.message} ${styles[message.role]}`}
                            >
                                {message.content || (
                                    <span className={styles.typing}>
                                        <span></span>
                                        <span></span>
                                        <span></span>
                                    </span>
                                )}
                            </div>
                        ))}
                        <div ref={messagesEndRef} />
                    </div>

                    <form onSubmit={handleSubmit} className={styles.inputForm}>
                        <input
                            ref={inputRef}
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder={connectionStatus === 'offline' ? 'AI offline...' : 'Schreib mir...'}
                            className={styles.input}
                            disabled={isLoading}
                        />
                        <button
                            type="submit"
                            className={styles.sendButton}
                            disabled={!input.trim() || isLoading}
                            aria-label="Nachricht senden"
                        >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                            </svg>
                        </button>
                    </form>
                </div>
            )}

            <button
                className={`${styles.fab} ${isOpen ? styles.fabActive : ''}`}
                onClick={() => setIsOpen(!isOpen)}
                aria-label={isOpen ? 'Chat schließen' : 'Chat öffnen'}
            >
                {isOpen ? (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                )}
                {connectionStatus === 'online' && !isOpen && (
                    <span className={styles.fabBadge} />
                )}
            </button>
        </div>
    );
}
