'use client';

import { useState, useRef, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import styles from './AssistantChat.module.css';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
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
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const pathname = usePathname();

    const currentModule = MODULE_CONTEXT[pathname] || MODULE_CONTEXT['/'];

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isOpen]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || isLoading) return;

        const userMessage: Message = {
            id: Date.now().toString(),
            role: 'user',
            content: input.trim(),
            timestamp: new Date(),
        };

        setMessages((prev) => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);

        // TODO: Connect to Ollama API with context
        // For now, simulate a response
        setTimeout(() => {
            const assistantMessage: Message = {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: `Ich sehe, dass du gerade im Modul "${currentModule.name}" bist (${currentModule.description}). Ich arbeite an deiner Anfrage...

Die Verbindung zum AI-Server (192.168.42.2:11434) wird in der nächsten Phase implementiert. Dann kann ich dir richtig helfen!`,
                timestamp: new Date(),
            };
            setMessages((prev) => [...prev, assistantMessage]);
            setIsLoading(false);
        }, 1000);
    };

    return (
        <div className={styles.container}>
            {isOpen && (
                <div className={styles.chatWindow}>
                    <div className={styles.header}>
                        <div className={styles.headerInfo}>
                            <span className={styles.title}>Persönlicher Assistent</span>
                            <span className={styles.context}>Kontext: {currentModule.name}</span>
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
                                {message.content}
                            </div>
                        ))}
                        {isLoading && (
                            <div className={`${styles.message} ${styles.assistant}`}>
                                <span className={styles.typing}>
                                    <span></span>
                                    <span></span>
                                    <span></span>
                                </span>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    <form onSubmit={handleSubmit} className={styles.inputForm}>
                        <input
                            ref={inputRef}
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder="Schreib mir..."
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
            </button>
        </div>
    );
}
