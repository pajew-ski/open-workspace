/**
 * Katalog der implementierten Connector-Arten.
 *
 * Nur was hier steht, existiert — die UI bezieht ihre Auswahl aus dieser
 * Liste, damit nie ein nicht implementierter Connector angeboten wird
 * (Invariante 10, keine Attrappen). Weitere Arten (sparql-endpoint,
 * a2a-agent-card, mcp-server, …) kommen mit ihren Meilensteinen (M9+)
 * hierher, nicht vorher in die UI.
 */

import type { Connector } from './types';
import { rdfFileConnector } from './rdf-file';
import { githubRdfConnector } from './github-rdf';
import { obsidianVaultConnector } from './obsidian';
import { jsonCanvasConnector } from './json-canvas';
import { gitBackupConnector } from './git-backup';

const CONNECTORS: ReadonlyArray<Connector<unknown>> = [
    rdfFileConnector as Connector<unknown>,
    githubRdfConnector as Connector<unknown>,
    obsidianVaultConnector as Connector<unknown>,
    jsonCanvasConnector as Connector<unknown>,
    gitBackupConnector as Connector<unknown>,
];

export function listConnectorKinds(): ReadonlyArray<Connector<unknown>> {
    return CONNECTORS;
}

export function getConnectorKind(kind: string): Connector<unknown> | null {
    return CONNECTORS.find(connector => connector.kind === kind) ?? null;
}
