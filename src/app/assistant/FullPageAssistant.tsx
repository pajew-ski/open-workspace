'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Send, Sparkles, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useConversation, UIMessage } from '@/lib/assistant/useConversation';
import { A2UIRenderer } from '@/components/a2ui/A2UIRenderer';
import { MessageContent } from '@/components/assistant/MessageContent';
import { ModelPicker } from '@/components/assistant/ModelPicker';
import { useAIState, useActiveSelection } from '@/lib/ai/useAI';
import { listConversations, createConversation, setActiveConversation } from '@/lib/chat/gateway';
import '@/components/assistant/MessageContent.css';
import styles from './FullPageAssistant.module.css';

const SUGGESTIONS = [
    'Zeig mir meine offenen Aufgaben',
    'Welche Termine habe ich diese Woche?',
    'Durchsuche die Wissensbasis nach Architektur',
    'Gib mir einen Überblick über den Workspace',
];
import { useSelfModel } from '@/lib/assistant/useSelfModel';
import { moduleForPath } from '@/lib/graph/meta/self-model-view';

/**
 * Full-page assistant: dialog on the left, generative stage on the right.
 *
 * The stage renders the conversation's active surface — the most recent
 * A2UI surface the model produced. Interface is emergent: it appears when
 * a turn calls for it and is replaced or dismissed by later turns.
 */
export function FullPageAssistant() {
    const [conversationId, setConversationId] = useState<string | null>(null);
    const [input, setInput] = useState('');
    const [stageOpen, setStageOpen] = useState(true);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Modul-Angaben aus dem Selbstmodell (SPEC §18) statt aus einer
    // handgeschriebenen Zeile; ohne Backend bleibt es beim Pfad.
    const { view: selfModel } = useSelfModel();
    const currentModule = useMemo(
        () => (selfModel ? moduleForPath(selfModel.modules, '/assistant') : null),
        [selfModel],
    );
    const context = useMemo(() => ({
        module: currentModule?.label ?? 'Assistent',
        moduleDescription: currentModule?.description ?? '',
        pathname: '/assistant',
        ...(selfModel ? { selfModel } : {}),
    }), [currentModule, selfModel]);

    const { data: aiState } = useAIState();
    const { provider, model } = useActiveSelection(aiState);

    const { messages, isLoading, activeSurface, sendMessage, loadMessages } =
        useConversation(conversationId, context, { provider, model });

    // Load or create the active conversation on mount (gateway: server
    // when reachable, IndexedDB when serverless)
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { conversations, activeId } = await listConversations();
                if (cancelled) return;

                // `?id=` öffnet eine bestimmte Unterhaltung — so landet ein
                // Finder-Treffer (M15: Chats sind Graph-Bürger und damit
                // suchbar) im richtigen Dialog statt nur auf der Seite.
                const requestedId = new URLSearchParams(window.location.search).get('id');
                const requested = requestedId ? conversations.find(c => c.id === requestedId) : undefined;
                const active = requested || conversations.find(c => c.id === activeId) || conversations[0];
                if (active) {
                    setConversationId(active.id);
                    loadMessages((active.messages || []) as UIMessage[]);
                    if (requested && requested.id !== activeId) {
                        // Die Auswahl überlebt den nächsten Aufruf ohne Parameter.
                        await setActiveConversation(requested.id).catch(() => undefined);
                    }
                } else {
                    const created = await createConversation();
                    if (!cancelled) setConversationId(created.id);
                }
            } catch {
                /* storage unavailable — chat still streams without persistence */
            }
        })();
        return () => { cancelled = true; };
    }, [loadMessages]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleAction = useCallback(async (actionId: string, payload?: unknown) => {
        if (actionId.startsWith('mcpui:')) {
            const kind = actionId.slice('mcpui:'.length);
            const p = payload as Record<string, unknown> | undefined;
            if (kind === 'link' && typeof p?.url === 'string' && /^https?:\/\//i.test(p.url)) {
                window.open(p.url, '_blank', 'noopener,noreferrer');
                return;
            }
            if (kind === 'prompt' && typeof p?.prompt === 'string') {
                await sendMessage(p.prompt);
                return;
            }
        }
        await sendMessage(`[User Action: ${actionId}]`);
    }, [sendMessage]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const text = input.trim();
        if (!text) return;
        setInput('');
        setStageOpen(true);
        void sendMessage(text);
    };

    const hasSurface = Boolean(activeSurface && activeSurface.length > 0);

    return (
        <div className={`${styles.shell} ${stageOpen && hasSurface ? styles.withStage : ''}`}>
            <section className={styles.dialog}>
                <header className={styles.dialogHeader}>
                    <div className={styles.brand}>
                        <Sparkles size={18} />
                        <span>Persönlicher Assistent</span>
                    </div>
                    <ModelPicker />
                    {hasSurface && (
                        <button
                            className={styles.stageToggle}
                            onClick={() => setStageOpen(o => !o)}
                            aria-label={stageOpen ? 'Bühne ausblenden' : 'Bühne einblenden'}
                            title={stageOpen ? 'Bühne ausblenden' : 'Bühne einblenden'}
                        >
                            {stageOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
                        </button>
                    )}
                </header>

                {/* Live-Region wie im Widget: role="log" spricht neue
                    Beiträge, aria-busy hält die gestreamten Schnipsel
                    zurück (TODO P2 „A11y-Feinschliff"). */}
                <div
                    className={styles.messages}
                    role="log"
                    aria-label="Chat-Verlauf"
                    aria-busy={isLoading || undefined}
                >
                    {messages.length === 0 ? (
                        <div className={styles.empty}>
                            <Sparkles size={32} className={styles.emptyIcon} />
                            <h2>Wie kann ich helfen?</h2>
                            <p>Sprich mit mir — passende Oberflächen entstehen im Gespräch,
                            rechts auf der Bühne.</p>
                            <div className={styles.suggestions}>
                                {SUGGESTIONS.map(s => (
                                    <button
                                        key={s}
                                        className={styles.suggestion}
                                        onClick={() => { setStageOpen(true); void sendMessage(s); }}
                                    >
                                        {s}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : (
                        messages.map(message => (
                            <div key={message.id} className={`${styles.message} ${styles[message.role]}`}>
                                {message.role === 'user' ? (
                                    <div className={styles.userBubble}>{message.content}</div>
                                ) : message.content ? (
                                    <div className={styles.assistantBody}>
                                        <MessageContent content={message.content} />
                                        {/* Compact surface preview inline; full surface lives on the stage */}
                                        {message.uiComponents && message.uiComponents.length > 0 && !stageOpen && (
                                            <div className={styles.inlineSurface}>
                                                <A2UIRenderer components={message.uiComponents} onAction={handleAction} />
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <span className={styles.typing}><span></span><span></span><span></span></span>
                                )}
                            </div>
                        ))
                    )}
                    <div ref={messagesEndRef} />
                </div>

                <div className="visually-hidden" role="status">
                    {isLoading ? 'Der Assistent antwortet.' : ''}
                </div>

                <form className={styles.inputBar} onSubmit={handleSubmit}>
                    <textarea
                        className={styles.input}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleSubmit(e);
                            }
                        }}
                        placeholder="Schreib mir…"
                        rows={1}
                    />
                    <button type="submit" className={styles.send} disabled={!input.trim() || isLoading} aria-label="Senden">
                        <Send size={18} />
                    </button>
                </form>
            </section>

            {stageOpen && hasSurface && (
                <section className={styles.stage} aria-label="Generative Bühne">
                    <header className={styles.stageHeader}>
                        <span>Bühne</span>
                        <span className={styles.stageHint}>Entsteht aus dem Gespräch</span>
                    </header>
                    <div className={styles.stageContent}>
                        <A2UIRenderer components={activeSurface!} onAction={handleAction} />
                    </div>
                </section>
            )}
        </div>
    );
}
