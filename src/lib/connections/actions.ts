/**
 * Aktionen der Verbindungen (ACTIONS_SPEC, A4): Zugangsdaten für
 * API-Tools und Agenten. Geheimnisse verlassen die Aktionen nie
 * (`maskConnection`) — gelesen wird nur, DASS ein Geheimnis gesetzt ist.
 */

import { z } from 'zod';
import { defineAction, notFound } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { createConnectionSchema, updateConnectionSchema } from '@/lib/api/validation';
import { OW } from '@/lib/graph/vocab';
import { createConnection, deleteConnection, loadConnections, MASKED_SECRET, updateConnection } from './manager';
import type { Connection } from './types';

/** Never expose stored (encrypted) secrets to clients. */
export function maskConnection(connection: Connection): Connection {
    return {
        ...connection,
        auth: {
            ...connection.auth,
            token: connection.auth.token ? MASKED_SECRET : undefined,
            password: connection.auth.password ? MASKED_SECRET : undefined,
            apiKey: connection.auth.apiKey ? MASKED_SECRET : undefined,
        },
    };
}

export const listConnections = defineAction({
    name: 'connections_list',
    title: 'Verbindungen auflisten',
    description: 'Listet die konfigurierten Verbindungen (REST, MCP, OAuth) mit maskierten Geheimnissen.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'instance' },
    async run() {
        return { connections: (await loadConnections()).map(maskConnection) };
    },
});

export const createConnectionAction = defineAction({
    name: 'connections_create',
    title: 'Verbindung anlegen',
    description: 'Legt eine Verbindung mit Basis-URL und Zugangsdaten an; die Geheimnisse werden verschlüsselt abgelegt.',
    input: createConnectionSchema,
    effect: 'constructive',
    target: { kind: 'instance' },
    changes: [OW.Tool],
    async run(input) {
        return { connection: maskConnection(await createConnection(input)) };
    },
});

export const updateConnectionAction = defineAction({
    name: 'connections_update',
    title: 'Verbindung ändern',
    description: 'Ändert eine Verbindung.',
    input: updateConnectionSchema,
    effect: 'constructive',
    target: { kind: 'instance' },
    changes: [OW.Tool],
    async run(input) {
        const { id, ...updates } = input;
        const connection = await updateConnection(id, updates);
        if (!connection) throw notFound('Connection not found');
        return { connection: maskConnection(connection) };
    },
});

export const deleteConnectionAction = defineAction({
    name: 'connections_delete',
    title: 'Verbindung löschen',
    description: 'Entfernt eine Verbindung samt Geheimnissen.',
    input: z.object({ id: z.string().min(1).max(200) }),
    effect: 'destructive',
    target: { kind: 'instance' },
    changes: [OW.Tool],
    async run(input) {
        await deleteConnection(input.id);
        return { success: true as const };
    },
});

registerActions('connections', [listConnections, createConnectionAction, updateConnectionAction, deleteConnectionAction]);
