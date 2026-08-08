/**
 * `github-rdf`-Connector (SPEC §6.3): ein GitHub-Repo (oder ein
 * Unterordner) mit `.ttl`/`.jsonld`/… -Dateien als materialisierte
 * Quelle — Referenzfall: prima-materia.
 *
 * Commit-gepinnt: `probe` löst den konfigurierten Ref (Branch/Tag/SHA,
 * ohne Angabe der Default-Branch) über die GitHub-API zum Commit-SHA
 * auf; `pull` liest Baum und Dateien ausschließlich an diesem SHA.
 * Revision = Commit-SHA → unveränderter Stand ist ein No-Op.
 *
 * Fehlertoleranz (M3-Abnahme): kaputte Dateien werden einzeln
 * quarantäniert, der Rest wird importiert. Ein Import scheitert nie an
 * der Qualität der Quelle.
 */

import type { Quad } from '@rdfjs/types';
import { z } from 'zod';
import type { Connector, ConnectorContext, SourceRef } from './types';
import { readBodyLimited } from './http';
import { isRdfPath, parseRdfLenient, relabelBlankNodes } from './quads';

const configSchema = z.object({
    /** `owner/name` oder eine github.com-URL (auch /tree/<ref>/<pfad>). */
    repo: z.string().min(3),
    /** Branch, Tag oder Commit-SHA; ohne Angabe der Default-Branch. */
    ref: z.string().min(1).optional(),
    /** Unterordner, nur Dateien darunter werden gelesen. */
    path: z.string().optional(),
});

export type GithubRdfConfig = z.infer<typeof configSchema>;

interface RepoTarget {
    owner: string;
    repo: string;
    ref?: string;
    path?: string;
}

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

function normalizePath(path: string | undefined): string | undefined {
    const trimmed = (path ?? '').replace(/^\/+|\/+$/g, '');
    return trimmed === '' ? undefined : trimmed;
}

/** Zerlegt `owner/name` oder eine github.com-URL in ein RepoTarget. */
export function parseRepoInput(config: GithubRdfConfig): RepoTarget {
    const input = config.repo.trim();
    let owner: string | undefined;
    let repo: string | undefined;
    let ref = config.ref?.trim() || undefined;
    let path = normalizePath(config.path);

    if (/^https?:\/\//.test(input)) {
        const url = new URL(input);
        if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
            throw new Error(`"${url.hostname}" ist kein github.com-Host — für andere Quellen nimm den rdf-file-Connector.`);
        }
        const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        if (segments.length < 2) {
            throw new Error('GitHub-URL braucht die Form github.com/<owner>/<repo>[…].');
        }
        [owner, repo] = segments;
        repo = repo.replace(/\.git$/, '');
        if (segments[2] === 'tree' && segments.length >= 4) {
            // Explizite Konfiguration hat Vorrang vor URL-Bestandteilen.
            ref = ref ?? segments[3];
            path = path ?? normalizePath(segments.slice(4).join('/'));
        }
    } else {
        const match = input.match(/^([^/\s]+)\/([^/\s]+)$/);
        if (!match) {
            throw new Error('Repo-Angabe braucht die Form "owner/name" oder eine github.com-URL.');
        }
        owner = match[1];
        repo = match[2].replace(/\.git$/, '');
    }

    return { owner, repo, ref, path };
}

/** Kanonischer Locator: `https://github.com/o/r[/tree/<ref>[/<pfad>]]`. */
function locatorForTarget(target: RepoTarget): string {
    const base = `https://github.com/${target.owner}/${target.repo}`;
    if (!target.ref && !target.path) return base;
    const ref = encodeURIComponent(target.ref ?? 'HEAD');
    const path = target.path
        ? `/${target.path.split('/').map(encodeURIComponent).join('/')}`
        : '';
    return `${base}/tree/${ref}${path}`;
}

function targetFromLocator(locator: string): RepoTarget {
    return parseRepoInput({ repo: locator });
}

function githubHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    const token = typeof process !== 'undefined'
        ? process.env.OW_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN
        : undefined;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

async function githubApi(url: string, ctx: ConnectorContext): Promise<unknown> {
    const response = await ctx.fetch(url, { headers: githubHeaders() });
    if (!response.ok) {
        if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
            throw new Error('GitHub-Rate-Limit erreicht — versuche es später erneut oder hinterlege GITHUB_TOKEN.');
        }
        if (response.status === 404) {
            throw new Error('Repo, Ref oder Pfad nicht gefunden (bei privaten Repos: GITHUB_TOKEN setzen).');
        }
        throw new Error(`GitHub-API antwortet mit HTTP ${response.status}.`);
    }
    return response.json() as Promise<unknown>;
}

interface TreeEntry {
    path: string;
    type: string;
    size?: number;
}

export const githubRdfConnector: Connector<GithubRdfConfig> = {
    kind: 'github-rdf',
    mode: 'materialize',
    capabilities: { read: true, write: false, watch: false, lossyExport: false },
    label: 'GitHub-Repo (RDF)',
    description: 'Ordner mit RDF-Dateien (.ttl, .jsonld, .nq, …) aus einem GitHub-Repo, commit-gepinnt — z. B. prima-materia.',

    configSchema: () => z.toJSONSchema(configSchema) as Record<string, unknown>,
    parseConfig: input => configSchema.parse(input),

    locatorFor: config => locatorForTarget(parseRepoInput(config)),
    configFromLocator: locator => {
        const target = targetFromLocator(locator);
        return {
            repo: `${target.owner}/${target.repo}`,
            ref: target.ref,
            path: target.path,
        };
    },

    async probe(config, ctx): Promise<SourceRef> {
        const target = parseRepoInput(config);
        const repoBase = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
        let ref = target.ref;
        if (!ref) {
            const repoInfo = await githubApi(repoBase, ctx) as { default_branch?: string };
            ref = repoInfo.default_branch;
            if (!ref) throw new Error('Default-Branch des Repos nicht ermittelbar.');
        }
        const commit = await githubApi(`${repoBase}/commits/${encodeURIComponent(ref)}`, ctx) as { sha?: string };
        if (!commit.sha) throw new Error(`Ref "${ref}" löst nicht zu einem Commit auf.`);
        return {
            id: '',
            kind: this.kind,
            locator: locatorForTarget(target),
            revision: commit.sha,
            fetchedAt: new Date().toISOString(),
        };
    },

    async *pull(ref: SourceRef, ctx: ConnectorContext): AsyncIterable<Quad> {
        if (!ref.revision) {
            throw new Error('pull() braucht eine per probe() aufgelöste Commit-Revision.');
        }
        const target = targetFromLocator(ref.locator);
        const sha = ref.revision;
        const repoBase = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;

        const tree = await githubApi(`${repoBase}/git/trees/${sha}?recursive=1`, ctx) as {
            tree?: TreeEntry[];
            truncated?: boolean;
        };
        if (tree.truncated) {
            ctx.quarantine({
                source: ref.locator,
                reason: 'GitHub hat die Dateiliste gekürzt (Repo zu groß) — der Import ist unvollständig.',
            });
        }

        const prefix = target.path ? `${target.path}/` : '';
        const candidates = (tree.tree ?? []).filter(entry =>
            entry.type === 'blob' &&
            (prefix === '' || entry.path.startsWith(prefix) || entry.path === target.path) &&
            isRdfPath(entry.path),
        );

        let totalBytes = 0;
        const files: TreeEntry[] = [];
        for (const entry of candidates) {
            if (files.length >= MAX_FILES) {
                ctx.quarantine({ source: entry.path, reason: `Übersprungen — Limit von ${MAX_FILES} Dateien pro Import erreicht.` });
                continue;
            }
            totalBytes += entry.size ?? 0;
            if (totalBytes > MAX_TOTAL_BYTES) {
                ctx.quarantine({ source: entry.path, reason: `Übersprungen — Gesamtlimit von ${MAX_TOTAL_BYTES} Bytes erreicht.` });
                continue;
            }
            files.push(entry);
        }

        for (let i = 0; i < files.length; i += 1) {
            const entry = files[i];
            ctx.report({ done: i, total: files.length, note: entry.path });
            const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/${sha}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
            let body: string;
            try {
                const response = await ctx.fetch(rawUrl, { headers: githubHeaders() });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                body = await readBodyLimited(response);
            } catch (error) {
                ctx.quarantine({
                    source: entry.path,
                    reason: `Abruf fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
                });
                continue;
            }
            const parsed = parseRdfLenient(body, { source: entry.path, path: entry.path, baseIri: rawUrl });
            for (const quarantineEntry of parsed.quarantined) {
                ctx.quarantine(quarantineEntry);
            }
            // Blank Nodes pro Datei präfixen, damit `_:b0` aus zwei
            // Dateien im Import-Graphen nicht kollidiert.
            yield* relabelBlankNodes(parsed.quads, `f${i}`);
        }
        ctx.report({ done: files.length, total: files.length });
    },
};
