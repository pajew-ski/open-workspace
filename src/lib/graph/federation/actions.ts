/**
 * Aktionen der Föderation (ACTIONS_SPEC, A4; GRAPH_CORE_SPEC §7.4): die
 * Registry föderierter SPARQL-Endpoints als ow:FederatedEndpoint in
 * graph/meta. Endpoints sind instanzweit (der Resolver löst `SERVICE` für
 * jede Query dagegen auf), deshalb verlangt Ändern `control` auf
 * graph/meta — dieselbe Schwelle wie für Gruppen (§17.1).
 */

import { z } from 'zod';
import { defineAction, notFound, REGISTRY_ERROR_RULES, withStatusFromMessage } from '@/lib/actions/contract';
import { registerActions } from '@/lib/actions/registry';
import { OW } from '../vocab';
import {
    createFederatedEndpoint,
    deleteFederatedEndpoint,
    getFederatedEndpoint,
    listFederatedEndpoints,
    TRUST_LEVEL_LABELS,
    TRUST_LEVELS,
    updateFederatedEndpoint,
} from './registry';
import { FEDERATION_DEFAULTS, probeEndpoint } from './remote';

const endpointIdSchema = z.string().min(1).max(64);
const META_CONTROL = { kind: 'graph', scope: 'meta', mode: 'control' } as const;

export const listEndpoints = defineAction({
    name: 'graph_list_federation_endpoints',
    title: 'Föderierte Endpoints auflisten',
    description: 'Listet die registrierten SPARQL-Endpoints mit Vertrauensstufe, dazu Fähigkeiten und Grenzen dieser Runtime.',
    input: z.object({}),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(_input, ctx) {
        const capabilities = ctx.platform?.runtime.capabilities;
        return {
            endpoints: await listFederatedEndpoints(ctx.graph),
            trustLevels: TRUST_LEVELS.map(level => ({ level, label: TRUST_LEVEL_LABELS[level] })),
            capabilities: {
                outbound: capabilities?.federationOutbound ?? false,
                inbound: capabilities?.federationInbound ?? false,
            },
            inboundEndpoint: '/api/graph/federation/sparql',
            limits: {
                timeoutMs: FEDERATION_DEFAULTS.timeoutMs,
                maxRows: FEDERATION_DEFAULTS.maxRows,
                maxBindings: FEDERATION_DEFAULTS.maxBindings,
            },
        };
    },
});

export const getEndpoint = defineAction({
    name: 'graph_get_federation_endpoint',
    title: 'Föderierten Endpoint lesen',
    description: 'Liest einen registrierten Endpoint.',
    input: z.object({ id: endpointIdSchema }),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(input, ctx) {
        const endpoint = await getFederatedEndpoint(ctx.graph, input.id);
        if (!endpoint) throw notFound(`Endpoint "${input.id}" existiert nicht.`);
        return { endpoint };
    },
});

export const createEndpoint = defineAction({
    name: 'graph_create_federation_endpoint',
    title: 'Endpoint registrieren',
    description: 'Registriert einen fremden SPARQL-Endpoint (Vertrauensstufe „unknown" sperrt ihn bis zur Freigabe).',
    input: z.object({
        id: endpointIdSchema,
        name: z.string().min(1).max(200),
        url: z.string().min(1).max(2000),
        trustLevel: z.enum(TRUST_LEVELS).optional(),
        description: z.string().max(2000).optional(),
    }).strict(),
    effect: 'constructive',
    target: META_CONTROL,
    changes: [OW.FederatedEndpoint],
    async run(input, ctx) {
        try {
            const endpoint = await createFederatedEndpoint(ctx.graph, input);
            await ctx.persist?.snapshot();
            return { endpoint };
        } catch (error) {
            return withStatusFromMessage(error, REGISTRY_ERROR_RULES);
        }
    },
});

export const updateEndpoint = defineAction({
    name: 'graph_update_federation_endpoint',
    title: 'Endpoint ändern',
    description: 'Ändert Name, URL, Beschreibung oder Vertrauensstufe eines Endpoints.',
    input: z.object({
        id: endpointIdSchema,
        name: z.string().min(1).max(200).optional(),
        url: z.string().min(1).max(2000).optional(),
        trustLevel: z.enum(TRUST_LEVELS).optional(),
        description: z.string().max(2000).nullable().optional(),
    }).strict(),
    effect: 'constructive',
    target: META_CONTROL,
    changes: [OW.FederatedEndpoint],
    async run(input, ctx) {
        const { id, ...patch } = input;
        try {
            const endpoint = await updateFederatedEndpoint(ctx.graph, id, patch);
            if (!endpoint) throw notFound(`Endpoint "${id}" existiert nicht.`);
            await ctx.persist?.snapshot();
            return { endpoint };
        } catch (error) {
            return withStatusFromMessage(error, REGISTRY_ERROR_RULES);
        }
    },
});

export const deleteEndpoint = defineAction({
    name: 'graph_delete_federation_endpoint',
    title: 'Endpoint entfernen',
    description: 'Entfernt einen registrierten Endpoint.',
    input: z.object({ id: endpointIdSchema }),
    effect: 'destructive',
    target: META_CONTROL,
    changes: [OW.FederatedEndpoint],
    async run(input, ctx) {
        const removed = await deleteFederatedEndpoint(ctx.graph, input.id);
        if (!removed) throw notFound(`Endpoint "${input.id}" existiert nicht.`);
        await ctx.persist?.snapshot();
        return { ok: true as const };
    },
});

/** Eine echte ASK-Query über den SSRF-geschützten Weg — kein Ping, kein Vermuten. */
export const probeEndpointAction = defineAction({
    name: 'graph_probe_federation_endpoint',
    title: 'Endpoint prüfen',
    description: 'Prüft die Erreichbarkeit eines registrierten Endpoints mit einer ASK-Query.',
    input: z.object({ id: endpointIdSchema }),
    effect: 'read',
    target: { kind: 'dataset' },
    async run(input, ctx) {
        const endpoint = await getFederatedEndpoint(ctx.graph, input.id);
        if (!endpoint) throw notFound(`Endpoint "${input.id}" existiert nicht.`);
        const probe = await probeEndpoint(endpoint.url);
        return { endpointId: endpoint.id, ...probe };
    },
});

registerActions('graph/federation', [listEndpoints, getEndpoint, createEndpoint, updateEndpoint, deleteEndpoint, probeEndpointAction]);
