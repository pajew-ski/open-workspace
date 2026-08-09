'use client';

import { useQuery } from '@tanstack/react-query';
import { Radio, ShieldCheck, ShieldAlert } from 'lucide-react';
import styles from './GraphMcpServer.module.css';

/**
 * Eingehender MCP-Server auf dem Wissensgraphen (GRAPH_CORE_SPEC §7.6,
 * M10) — Lesemodell zu `/api/mcp`.
 *
 * Bewusst read-only: Die Zugänge stehen in der Umgebung (`OW_MCP_TOKENS`),
 * weil sie Geheimnisse sind und zum Deployment gehören, nicht in die
 * Datenbank. Diese Ansicht beantwortet, was man vor dem Anschließen eines
 * externen Clients wissen muss — und sagt ehrlich, wenn nichts
 * konfiguriert ist, statt einen toten Schalter anzubieten.
 */

interface McpStatusToken {
    id: string;
    label: string | null;
    scopes: string[];
    sparql: boolean;
    write: boolean;
    writeScope: string | null;
    rateLimitPerMinute: number;
    readableGraphs: string[];
    tools: string[];
    warning?: string;
}

interface McpStatus {
    available: boolean;
    configured: boolean;
    endpoint: string;
    envVar: string;
    errors: string[];
    sessions: number;
    tokens: McpStatusToken[];
}

const EXAMPLE = `OW_MCP_TOKENS='[{"id":"claude-desktop","token":"<langes-geheimnis>",
  "scopes":["workspace","public","meta","import/*"],"sparql":true}]'`;

export function GraphMcpServer() {
    const { data, isLoading, isError } = useQuery<McpStatus>({
        queryKey: ['mcp-server-status'],
        queryFn: async () => {
            const response = await fetch('/api/mcp/status');
            if (!response.ok) throw new Error('Status nicht abrufbar');
            return response.json();
        },
        retry: false,
    });

    if (isLoading) {
        return <p className={styles.muted}>Status wird geladen …</p>;
    }
    if (isError || !data) {
        return <p className={styles.muted}>Der MCP-Server-Status ist gerade nicht erreichbar.</p>;
    }

    return (
        <div className={styles.container}>
            <p className={styles.intro}>
                Externe Agenten können auf deinem Wissensgraphen retrieven — über
                MCP, ohne SPARQL zu sprechen. Der Endpunkt ist{' '}
                <code className={styles.code}>{data.endpoint}</code> (Streamable HTTP).
            </p>

            {!data.available && (
                <p className={styles.warning}>
                    <ShieldAlert size={16} aria-hidden="true" />
                    Diese Runtime bietet keinen MCP-Server an. Er läuft nur im
                    Server- und im Home-Assistant-Add-on-Betrieb.
                </p>
            )}

            {data.errors.length > 0 && (
                <ul className={styles.errors}>
                    {data.errors.map(error => <li key={error}>{error}</li>)}
                </ul>
            )}

            {data.available && !data.configured && (
                <div className={styles.hint}>
                    <p>
                        Es ist noch kein Zugang eingerichtet — ohne Token lässt der
                        Endpunkt niemanden herein. Lege die Zugänge in{' '}
                        <code className={styles.code}>{data.envVar}</code> an:
                    </p>
                    <pre className={styles.example}>{EXAMPLE}</pre>
                    <p className={styles.muted}>
                        Jeder Zugang nennt seine lesbaren Graphen als Scopes
                        (<code className={styles.code}>workspace</code>,{' '}
                        <code className={styles.code}>public</code>,{' '}
                        <code className={styles.code}>meta</code>,{' '}
                        <code className={styles.code}>import/*</code>). Rohe
                        SPARQL-Queries und Schreibrecht sind einzeln zuschaltbar und
                        standardmäßig aus.
                    </p>
                </div>
            )}

            {data.configured && (
                <>
                    <p className={styles.sessions}>
                        <Radio size={16} aria-hidden="true" />
                        {data.sessions === 1 ? '1 offene Sitzung' : `${data.sessions} offene Sitzungen`}
                    </p>
                    <ul className={styles.tokens}>
                        {data.tokens.map(token => (
                            <li key={token.id} className={styles.token}>
                                <div className={styles.tokenHead}>
                                    <ShieldCheck size={16} aria-hidden="true" />
                                    <strong>{token.label ?? token.id}</strong>
                                    <span className={styles.muted}>({token.id})</span>
                                </div>
                                <dl className={styles.details}>
                                    <dt>Scopes</dt>
                                    <dd>{token.scopes.join(', ')}</dd>
                                    <dt>Sichtbare Graphen</dt>
                                    <dd>{token.readableGraphs.length}</dd>
                                    <dt>Werkzeuge</dt>
                                    <dd>{token.tools.join(', ')}</dd>
                                    <dt>Schreiben</dt>
                                    <dd>{token.write ? `ja — ${token.writeScope}` : 'nein'}</dd>
                                    <dt>Limit</dt>
                                    <dd>{token.rateLimitPerMinute} Anfragen/Minute</dd>
                                </dl>
                                {token.warning && <p className={styles.warning}>{token.warning}</p>}
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </div>
    );
}
