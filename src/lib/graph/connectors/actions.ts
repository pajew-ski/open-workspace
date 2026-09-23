/**
 * Aktionen der Connectors (ACTIONS_SPEC, A4; GRAPH_CORE_SPEC §6): Katalog
 * und Instanzen, Anlegen, Löschen, Sync- und Export-Lauf. Die Instanz ist
 * ein Registry-Eintrag des Aufrufers in graph/meta, ihr Import-Graph
 * liegt im eigenen Namensraum — Ziel der schreibenden Aktionen ist dieser
 * Graph. Ein Lauf braucht Dateibaum und Runtime (`platform`).
 *
 * §17.4: Ein Git-Backup nimmt den ganzen Snapshot mit. Wer ihn ausliefert,
 * muss jeden enthaltenen Graphen verwalten dürfen — abgeleitet aus dem
 * Grant (`snapshotExportRefusal`), keine eigene Regel.
 */

import { z } from 'zod';
import { ActionDeniedError, ActionError, defineAction, notFound, type ActionContext } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { snapshotExportRefusal } from '../authz/resolve';
import { OW, PROV } from '../vocab';
import { getConnectorKind, listConnectorKinds } from './catalog';
import { createConnector, deleteConnector, getConnector, listConnectors } from './registry';
import { pushConnector, syncConnector } from './sync';

const connectorIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/i, 'Ungültige Connector-ID');

async function refuseSnapshotExport(ctx: ActionContext, kind: string): Promise<void> {
    if (kind !== 'git-backup') return;
    const existing = (await ctx.graph.store.graphs()).map(g => g.value);
    const refusal = snapshotExportRefusal(ctx.grant, ctx.graph.iri.instanceBase, existing);
    if (refusal) throw new ActionDeniedError('Backup nicht erlaubt', refusal);
}

export const listConnectorsAction = defineAction({
    name: 'graph_list_connectors',
    title: 'Connectors auflisten',
    description: 'Listet die Connector-Instanzen des Aufrufers und den Katalog der implementierten Arten (mit Konfigurations-Schema).',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'registry' },
    async run(_input, ctx) {
        const connectors = await listConnectors(ctx.graph);
        const kinds = listConnectorKinds().map(kind => ({
            kind: kind.kind,
            mode: kind.mode,
            label: kind.label,
            description: kind.description,
            capabilities: kind.capabilities,
            configSchema: kind.configSchema(),
        }));
        return { connectors, kinds };
    },
});

export const getConnectorAction = defineAction({
    name: 'graph_get_connector',
    title: 'Connector lesen',
    description: 'Liest eine Connector-Instanz mit Sync-Zustand und letztem Lauf.',
    input: z.object({ id: connectorIdSchema }),
    effect: 'read',
    target: { kind: 'registry' },
    async run(input, ctx) {
        const connector = await getConnector(ctx.graph, input.id);
        if (!connector) throw notFound('Connector nicht gefunden');
        return { connector };
    },
});

export const createConnectorAction = defineAction({
    name: 'graph_create_connector',
    title: 'Connector anlegen',
    description: 'Legt eine Connector-Instanz an; die kind-spezifische Konfiguration prüft der Connector selbst.',
    input: z.object({
        kind: z.string().min(1).max(100).describe('Connector-Art aus dem Katalog'),
        name: z.string().min(1, 'Name ist erforderlich').max(200),
        config: z.unknown().describe('Konfiguration nach dem configSchema der Art'),
    }),
    effect: 'constructive',
    // Die Kennung entsteht erst beim Anlegen: Ziel ist ein neuer
    // Import-Graph im eigenen Namensraum.
    target: { kind: 'graph', scope: 'import/*' },
    changes: [OW.Connector],
    async run(input, ctx) {
        const impl = getConnectorKind(input.kind);
        if (!impl) throw new ActionError(400, `Connector-Art "${input.kind}" ist nicht implementiert.`);
        // Konfigurationsfehler des Connectors sind Zod-Fehler und werden vom
        // Adapter als 400 ausgegeben.
        const locator = impl.locatorFor(impl.parseConfig(input.config));
        await refuseSnapshotExport(ctx, impl.kind);
        const connector = await createConnector(ctx.graph, { name: input.name, kind: impl.kind, locator });
        await ctx.persist?.snapshot();
        return { connector };
    },
});

export const deleteConnectorAction = defineAction({
    name: 'graph_delete_connector',
    title: 'Connector löschen',
    description: 'Entfernt eine Connector-Instanz samt ihrem Import-Graphen.',
    input: z.object({ id: connectorIdSchema }),
    effect: 'destructive',
    target: { kind: 'graph', scope: input => `import/${(input as { id: string }).id}` },
    changes: [OW.Connector],
    async run(input, ctx) {
        const deleted = await deleteConnector(ctx.graph, input.id);
        if (!deleted) throw notFound('Connector nicht gefunden');
        await ctx.persist?.snapshot();
        return { success: true as const };
    },
});

/**
 * Antwortet immer mit dem vollständigen Laufbericht inkl. Quarantäne —
 * Quell-Qualität bricht einen Import nie ab (M3-Abnahme). Nur wenn die
 * Infrastruktur scheitert, meldet `status: 'failed'` das ehrlich.
 */
export const syncConnectorAction = defineAction({
    name: 'graph_sync_connector',
    title: 'Connector synchronisieren',
    description: 'Führt den Sync-Lauf einer Connector-Instanz aus (Import mit Replace-Semantik und Quarantäne-Bericht).',
    input: z.object({ id: connectorIdSchema }),
    effect: 'constructive',
    target: { kind: 'graph', scope: input => `import/${(input as { id: string }).id}` },
    requires: ['platform'],
    changes: [OW.Connector, PROV.Activity],
    async run(input, ctx) {
        const existing = await getConnector(ctx.graph, input.id);
        if (!existing) throw notFound('Connector nicht gefunden');
        await refuseSnapshotExport(ctx, existing.kind);
        const result = await syncConnector(ctx.graph, input.id, {
            files: ctx.platform!.files,
            runtime: ctx.platform!.runtime,
        });
        // Wiederhergestellte kanonische Graphen (git-backup, SPEC §8.2):
        // die Datei-Projektionen folgen dem Store.
        if (result.restoredGraphs.length > 0) await ctx.persist?.reproject();
        await ctx.persist?.snapshot();
        return { result, connector: await getConnector(ctx.graph, input.id) };
    },
});

export const pushConnectorAction = defineAction({
    name: 'graph_push_connector',
    title: 'Connector exportieren',
    description: 'Schreibt den Import-Graphen einer Connector-Instanz zurück in die Quelle (Konfliktregel SPEC §6.2).',
    input: z.object({ id: connectorIdSchema }),
    effect: 'constructive',
    target: { kind: 'graph', scope: input => `import/${(input as { id: string }).id}` },
    requires: ['platform'],
    changes: [OW.Connector, PROV.Activity],
    async run(input, ctx) {
        const existing = await getConnector(ctx.graph, input.id);
        if (!existing) throw notFound('Connector nicht gefunden');
        await refuseSnapshotExport(ctx, existing.kind);
        const result = await pushConnector(ctx.graph, input.id, {
            files: ctx.platform!.files,
            runtime: ctx.platform!.runtime,
        });
        await ctx.persist?.snapshot();
        return { result, connector: await getConnector(ctx.graph, input.id) };
    },
});

registerActions('graph/connectors', [
    listConnectorsAction, getConnectorAction, createConnectorAction, deleteConnectorAction, syncConnectorAction, pushConnectorAction,
]);
