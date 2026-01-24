'use client';

import { useState, useCallback, useMemo } from 'react';
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

    const handleContentChange = useCallback((newContent: string) => {
        setLocalContent(newContent);
        onChange?.(newContent);
    }, [onChange]);

    const renderedHtml = useMemo(() => parseMarkdown(localContent), [localContent]);

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
                        <button
                            className={`${styles.modeButton} ${mode === 'read' ? styles.active : ''}`}
                            onClick={() => setMode('read')}
                            title="Lesemodus"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                <circle cx="12" cy="12" r="3" />
                            </svg>
                            <span>Lesen</span>
                        </button>
                        <button
                            className={`${styles.modeButton} ${mode === 'wysiwyg' ? styles.active : ''}`}
                            onClick={() => setMode('wysiwyg')}
                            title="WYSIWYG Editor"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 20h9" />
                                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                            </svg>
                            <span>Bearbeiten</span>
                        </button>
                        <button
                            className={`${styles.modeButton} ${mode === 'raw' ? styles.active : ''}`}
                            onClick={() => setMode('raw')}
                            title="Markdown Quelltext"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="16 18 22 12 16 6" />
                                <polyline points="8 6 2 12 8 18" />
                            </svg>
                            <span>Quelltext</span>
                        </button>
                    </div>
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
