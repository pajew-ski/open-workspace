'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Bold, Italic, Code, List, ListOrdered, Link, Image, Quote, Heading } from 'lucide-react';
import styles from './MarkdownEditor.module.css';

export type EditorMode = 'read' | 'raw' | 'wysiwyg';

interface MarkdownEditorProps {
    content: string;
    onChange?: (content: string) => void;
    readOnly?: boolean;
    defaultMode?: EditorMode;
}

/**
 * Simple Markdown to HTML converter for reading mode
 */
function parseMarkdown(md: string): string {
    let html = md
        // Escape HTML
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // Headers
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        // Bold and Italic
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/___(.+?)___/g, '<strong><em>$1</em></strong>')
        .replace(/__(.+?)__/g, '<strong>$1</strong>')
        .replace(/_(.+?)_/g, '<em>$1</em>')
        // Code blocks
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
        // Inline code
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // Links
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        // Images
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')
        // Blockquotes
        .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
        // Horizontal rule
        .replace(/^---$/gm, '<hr />')
        // Unordered lists
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        // Ordered lists
        .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
        // Paragraphs (simple)
        .replace(/\n\n/g, '</p><p>')
        // Line breaks
        .replace(/\n/g, '<br />');

    // Wrap consecutive blockquotes
    html = html.replace(/(<blockquote>.*?<\/blockquote>)(\s*<br \/>)*(<blockquote>)/g, '$1$3');

    // Wrap consecutive list items
    html = html.replace(/(<li>.*?<\/li>)(\s*<br \/>)*(<li>)/g, '$1$3');
    html = html.replace(/(<li>.*?<\/li>)+/g, '<ul>$&</ul>');

    return `<p>${html}</p>`;
}

/**
 * Obsidian-style Markdown Editor with Raw, WYSIWYG, and Reading modes
 */
export function MarkdownEditor({
    content,
    onChange,
    readOnly = false,
    defaultMode = 'read',
}: MarkdownEditorProps) {
    const [mode, setMode] = useState<EditorMode>(readOnly ? 'read' : defaultMode);
    const [localContent, setLocalContent] = useState(content);

    useEffect(() => {
        setLocalContent(content);
    }, [content]);

    const handleContentChange = useCallback((newContent: string) => {
        setLocalContent(newContent);
        onChange?.(newContent);
    }, [onChange]);

    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const checkMobile = () => typeof window !== 'undefined' && window.innerWidth < 768;

    const renderedHtml = useMemo(() => parseMarkdown(localContent), [localContent]);

    const insertFormatting = (prefix: string, suffix: string = '') => {
        if (!textareaRef.current) return;

        const start = textareaRef.current.selectionStart;
        const end = textareaRef.current.selectionEnd;
        const text = textareaRef.current.value;
        const before = text.substring(0, start);
        const selection = text.substring(start, end);
        const after = text.substring(end);

        const newText = before + prefix + selection + suffix + after;
        const newCursor = start + prefix.length + selection.length + suffix.length; // Cursor after insertion

        setLocalContent(newText);
        onChange?.(newText);

        setTimeout(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(start + prefix.length, end + prefix.length);
        }, 10);
    };

    const handleWysiwygInput = useCallback((e: React.FormEvent<HTMLDivElement>) => {
        // For WYSIWYG, we'd need to convert HTML back to Markdown
        // This is a simplified version - a real implementation would use a library
        const html = e.currentTarget.innerHTML;
        // For now, just update with raw text content
        const text = e.currentTarget.innerText;
        handleContentChange(text);
    }, [handleContentChange]);

    return (
        <div className={styles.editor}>
            {!readOnly && (
                <div className={styles.toolbar}>
                    <div className={styles.modeButtons}>
                        <button className={`${styles.modeButton} ${mode === 'read' ? styles.active : ''}`} onClick={() => setMode('read')}>Lesen</button>
                        <button className={`${styles.modeButton} ${mode === 'raw' ? styles.active : ''}`} onClick={() => setMode('raw')}>Editor</button>
                    </div>

                    {mode === 'raw' && (
                        <div className={styles.formatButtons}>
                            <button onClick={() => insertFormatting('**', '**')} title="Fett"><Bold size={16} /></button>
                            <button onClick={() => insertFormatting('*', '*')} title="Kursiv"><Italic size={16} /></button>
                            <div className={styles.divider} />
                            <button onClick={() => insertFormatting('### ')} title="Überschrift"><Heading size={16} /></button>
                            <button onClick={() => insertFormatting('> ')} title="Zitat"><Quote size={16} /></button>
                            <button onClick={() => insertFormatting('`', '`')} title="Code"><Code size={16} /></button>
                            <div className={styles.divider} />
                            <button onClick={() => insertFormatting('- ')} title="Liste"><List size={16} /></button>
                            <button onClick={() => insertFormatting('1. ')} title="Nummerierte Liste"><ListOrdered size={16} /></button>
                            <div className={styles.divider} />
                            <button onClick={() => insertFormatting('[', '](url)')} title="Link"><Link size={16} /></button>
                        </div>
                    )}
                </div>
            )}

            <div className={styles.content}>
                {mode === 'read' && (
                    <div
                        className={styles.readView}
                        dangerouslySetInnerHTML={{ __html: renderedHtml }}
                    />
                )}

                {mode === 'wysiwyg' && (
                    <div
                        className={styles.wysiwygView}
                        contentEditable
                        suppressContentEditableWarning
                        dangerouslySetInnerHTML={{ __html: renderedHtml }}
                        onInput={handleWysiwygInput}
                    />
                )}

                {mode === 'raw' && (
                    <textarea
                        ref={textareaRef}
                        className={styles.rawView}
                        value={localContent}
                        onChange={(e) => handleContentChange(e.target.value)}
                        placeholder="# Schreibe hier deinen Markdown..."
                        spellCheck={false}
                    />
                )}
            </div>
        </div>
    );
}
