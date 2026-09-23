/**
 * Aktionskontext auf dem Server: Identität und Grant der laufenden
 * Anfrage (`graph/server/context.ts`) plus alles, was die Installation an
 * Bausteinen hat — Store-first-CRUD, Index-Cache, Dateibaum, Snapshot.
 *
 * Zwei Einstiege: `actionContextFromRequest` für Routen und den
 * Chat-Turn (Identität aus den Headern), `actionContextForIdentity` für
 * Aufrufer, die ihre Identität anders belegen (MCP-Token, Status-Seite).
 */

import { logActivity } from '@/lib/activity';
import { resolveEmbeddingProvider } from '@/lib/ai/embeddings.server';
import type { AccessGrant } from '@/lib/graph/authz/grant';
import { getFulltextIndex, getVectorIndex } from '@/lib/graph/search/cache';
import type { GraphHandle, RetrievalDeps } from '@/lib/graph/search/retrieval';
import { getRequestGraph } from '@/lib/graph/server/context';
import {
    getWorkspaceContextFor,
    persistAclSnapshot,
    persistServerGraphSnapshot,
    refreshAiMirrorAfterMutation,
    reprojectWorkspaceFiles,
    runServerReasoning,
} from '@/lib/graph/server/instance';
import { createNodeFileSystem } from '@/lib/platform/runtime/node-fs';
import { createNodeRuntimeAdapter } from '@/lib/platform/runtime/server';
import type { ActionContext, ActionIdentity, ActionSurface } from './contract';
import './catalog';

export interface ServerContextOptions {
    surface?: ActionSurface;
    origin?: string;
}

/**
 * Seed-Quellen aus dem M8-Index-Cache. Der Vektorindex entsteht nur auf
 * Anforderung und nur mit konfigurierten Embeddings; fehlen sie, sagt
 * `embeddings.reason` ehrlich, warum (Invariante 10).
 */
export async function serverRetrievalDeps(
    handle: GraphHandle,
    dataset: readonly string[],
    options: { vector?: boolean } = {},
): Promise<RetrievalDeps> {
    const deps: RetrievalDeps = { fulltext: await getFulltextIndex(handle, dataset) };
    if (!options.vector) return deps;
    const embedding = await resolveEmbeddingProvider();
    deps.embeddings = embedding.availability;
    if (embedding.provider) {
        const provider = embedding.provider;
        deps.vector = await getVectorIndex(handle, dataset, provider);
        deps.embedQuery = async text => (await provider.embed([text]))[0];
    }
    return deps;
}

export function actionContextForIdentity(
    handle: GraphHandle,
    grant: AccessGrant,
    identity: ActionIdentity,
    options: ServerContextOptions = {},
): ActionContext {
    return {
        identity,
        grant,
        graph: handle,
        workspace: () => getWorkspaceContextFor(identity.userId, identity.displayName),
        retrieval: (dataset, options) => serverRetrievalDeps(handle, dataset, options),
        platform: { files: createNodeFileSystem(), runtime: createNodeRuntimeAdapter() },
        persist: {
            snapshot: async () => { await persistServerGraphSnapshot(); },
            acl: persistAclSnapshot,
            reasoning: runServerReasoning,
            reproject: reprojectWorkspaceFiles,
            aiMirror: refreshAiMirrorAfterMutation,
        },
        activity: async (type, entityId, title) => { await logActivity(type, entityId, title); },
        ...(options.surface ? { surface: options.surface } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
    };
}

export async function actionContextFromRequest(options: ServerContextOptions = {}): Promise<ActionContext> {
    const { store, iri, identity, grant } = await getRequestGraph();
    return actionContextForIdentity({ store, iri }, grant, {
        userId: grant.userId ?? '',
        authenticated: identity.authenticated,
        ...(identity.displayName ? { displayName: identity.displayName } : {}),
        label: grant.identity,
    }, options);
}
