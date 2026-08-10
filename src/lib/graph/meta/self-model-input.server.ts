/**
 * Serverseitiger Input des Selbstmodells (SPEC §18, M14).
 *
 * Alle vier Quellen sind Code, keine gepflegten Listen: die Modul-Registry
 * (`lib/app/modules.ts`), der Connector-Katalog, der RuntimeAdapter dieses
 * Prozesses und die Versionsangaben aus `package.json` bzw. dem
 * Snapshot-Manifest. Getrennt von `self-model.ts` (pur) und von
 * `server/instance.ts` (Store-Zustand) — dasselbe Muster wie beim
 * AI-Spiegel.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APP_MODULES } from '@/lib/app/modules';
import { createNodeRuntimeAdapter } from '@/lib/platform/runtime/server';
import { listConnectorKinds } from '../connectors/catalog';
import { SNAPSHOT_SCHEMA_VERSION } from '../serialize/snapshot';
import type { SelfModelInput } from './self-model';

/** Version der Anwendung; ohne lesbare package.json ehrlich „unbekannt". */
function appVersion(): string {
    try {
        const raw = readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        const version = (parsed as { version?: unknown }).version;
        return typeof version === 'string' && version !== '' ? version : 'unbekannt';
    } catch {
        return 'unbekannt';
    }
}

export function loadSelfModelInput(): SelfModelInput {
    const adapter = createNodeRuntimeAdapter();
    return {
        runtime: adapter.id,
        capabilities: adapter.capabilities,
        appVersion: appVersion(),
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        modules: APP_MODULES,
        connectorKinds: listConnectorKinds().map(connector => connector.kind),
    };
}
