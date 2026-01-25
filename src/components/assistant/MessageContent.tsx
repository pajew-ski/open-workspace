'use client';

import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

// Dynamically load Prism for syntax highlighting
let Prism: typeof import('prismjs') | null = null;
if (typeof window !== 'undefined') {
    import('prismjs').then(mod => {
        Prism = mod.default;
        // Import common languages
        import('prismjs/components/prism-javascript');
        import('prismjs/components/prism-typescript');
        import('prismjs/components/prism-python');
        import('prismjs/components/prism-bash');
        import('prismjs/components/prism-json');
        import('prismjs/components/prism-css');
        import('prismjs/components/prism-jsx');
        import('prismjs/components/prism-tsx');
    });
}

interface MessageContentProps {
    content: string;
}

// Mermaid diagram component
const MermaidDiagram = ({ code }: { code: string }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [svg, setSvg] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        const renderMermaid = async () => {
            try {
                const mermaid = (await import('mermaid')).default;
                mermaid.initialize({
                    startOnLoad: false,
                    theme: 'default',
                    securityLevel: 'loose',
                });

                const id = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                const { svg: renderedSvg } = await mermaid.render(id, code);

                if (!cancelled) {
                    setSvg(renderedSvg);
                    setError(null);
                }
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : 'Mermaid rendering failed');
                }
            }
        };

        renderMermaid();

        return () => {
            cancelled = true;
        };
    }, [code]);

    if (error) {
        return (
            <div className="mermaid-error">
                <p>Diagramm-Fehler: {error}</p>
                <pre><code>{code}</code></pre>
            </div>
        );
    }

    if (svg) {
        return (
            <div
                ref={containerRef}
                className="mermaid-diagram"
                dangerouslySetInnerHTML={{ __html: svg }}
            />
        );
    }

    return <div className="mermaid-loading">Lade Diagramm...</div>;
};

// Code block component with syntax highlighting
const CodeBlock = ({ language, code }: { language: string; code: string }) => {
    const [copied, setCopied] = useState(false);
    const [highlighted, setHighlighted] = useState<string | null>(null);

    useEffect(() => {
        if (Prism && language && Prism.languages[language]) {
            try {
                const html = Prism.highlight(code, Prism.languages[language], language);
                setHighlighted(html);
            } catch {
                setHighlighted(null);
            }
        }
    }, [code, language]);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="code-block">
            <div className="code-block-header">
                <span className="code-block-language">{language || 'code'}</span>
                <button className="code-block-copy" onClick={handleCopy}>
                    {copied ? 'Kopiert!' : 'Kopieren'}
                </button>
            </div>
            <pre>
                {highlighted ? (
                    <code dangerouslySetInnerHTML={{ __html: highlighted }} />
                ) : (
                    <code>{code}</code>
                )}
            </pre>
        </div>
    );
};

export function MessageContent({ content }: MessageContentProps) {
    // Filter out a2ui code blocks - these are handled separately by A2UIRenderer
    const filteredContent = content.replace(/```a2ui[\s\S]*?```/g, '');

    // Custom components for react-markdown
    const components: Partial<Components> = {
        code: ({ className, children, ...props }) => {
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';
            const code = String(children).replace(/\n$/, '');

            // Check if this is an inline code or a block
            const isInline = !className;

            if (isInline) {
                return <code className="inline-code" {...props}>{children}</code>;
            }

            // Handle Mermaid diagrams
            if (language === 'mermaid') {
                return <MermaidDiagram code={code} />;
            }

            // Regular code block with syntax highlighting
            return <CodeBlock language={language} code={code} />;
        },
        // Enhance other elements
        a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="md-link">
                {children}
            </a>
        ),
        table: ({ children }) => (
            <div className="table-wrapper">
                <table className="md-table">{children}</table>
            </div>
        ),
        blockquote: ({ children }) => (
            <blockquote className="md-blockquote">{children}</blockquote>
        ),
        ul: ({ children }) => <ul className="md-list">{children}</ul>,
        ol: ({ children }) => <ol className="md-list md-list-ordered">{children}</ol>,
        h1: ({ children }) => <h1 className="md-heading md-h1">{children}</h1>,
        h2: ({ children }) => <h2 className="md-heading md-h2">{children}</h2>,
        h3: ({ children }) => <h3 className="md-heading md-h3">{children}</h3>,
        h4: ({ children }) => <h4 className="md-heading md-h4">{children}</h4>,
    };

    return (
        <div className="message-content-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {filteredContent}
            </ReactMarkdown>
        </div>
    );
}
