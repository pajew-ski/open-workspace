import { parseSkillMarkdown, type ParsedSkillFile } from './parse';

/**
 * Skill loaders: every way to get instructions into the workspace.
 * - from a raw URL (any SKILL.md/markdown file on the web)
 * - from a GitHub repository (skills folders, SKILL.md convention)
 * - from MCP prompts (see mcp/client.getMcpPromptText — imported where used)
 * All loaders run in the browser (api.github.com and raw URLs are
 * CORS-enabled), so they work without a backend.
 */

const FETCH_TIMEOUT_MS = 15_000;
const MAX_REPO_SKILLS = 20;

export interface LoadedSkill extends ParsedSkillFile {
    sourceRef: string;
}

export async function loadSkillFromUrl(url: string): Promise<LoadedSkill> {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`Abruf fehlgeschlagen: HTTP ${response.status}`);
    }
    const text = await response.text();
    if (!text.trim()) throw new Error('Die Datei ist leer.');
    const fallbackName = decodeURIComponent(url.split('/').filter(Boolean).pop() ?? 'Skill').replace(/\.md$/i, '');
    return { ...parseSkillMarkdown(text, fallbackName), sourceRef: url };
}

interface RepoRef {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
}

/** Accepts "owner/repo", "owner/repo/path", and github.com URLs (incl. /tree/branch/path). */
export function parseRepoRef(input: string): RepoRef {
    let cleaned = input.trim();
    const githubMatch = cleaned.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)\/?(.*))?$/);
    if (githubMatch) {
        return {
            owner: githubMatch[1],
            repo: githubMatch[2].replace(/\.git$/, ''),
            ref: githubMatch[3],
            path: githubMatch[4] ?? '',
        };
    }
    cleaned = cleaned.replace(/^\/+|\/+$/g, '');
    const parts = cleaned.split('/');
    if (parts.length < 2) {
        throw new Error('Erwartetes Format: owner/repo oder owner/repo/pfad');
    }
    const [owner, repo, ...rest] = parts;
    return { owner, repo, path: rest.join('/') };
}

interface GitHubContentEntry {
    type: 'file' | 'dir' | string;
    name: string;
    path: string;
    download_url: string | null;
}

async function githubContents(ref: RepoRef, path: string): Promise<GitHubContentEntry[] | GitHubContentEntry> {
    const url = new URL(`https://api.github.com/repos/${ref.owner}/${ref.repo}/contents/${path}`);
    if (ref.ref) url.searchParams.set('ref', ref.ref);
    const response = await fetch(url, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`GitHub API: HTTP ${response.status} für ${path || '/'}`);
    }
    return response.json();
}

async function fetchDownload(entry: GitHubContentEntry): Promise<string> {
    if (!entry.download_url) throw new Error(`Keine Download-URL für ${entry.path}`);
    const response = await fetch(entry.download_url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Download fehlgeschlagen: HTTP ${response.status}`);
    return response.text();
}

function isSkillFile(name: string): boolean {
    const lower = name.toLowerCase();
    return lower === 'skill.md' || lower === 'skill.markdown';
}

/**
 * Load skills from a GitHub repo following the skills-folder convention:
 * - a direct file path → that file
 * - a directory containing SKILL.md → that one skill
 * - a directory of skill folders (each with SKILL.md) → all of them
 */
export async function loadSkillsFromRepo(input: string): Promise<LoadedSkill[]> {
    const ref = parseRepoRef(input);
    const results: LoadedSkill[] = [];

    const tryPath = async (path: string): Promise<LoadedSkill[]> => {
        const listing = await githubContents(ref, path);

        // Direct file
        if (!Array.isArray(listing)) {
            if (listing.type === 'file') {
                const text = await fetchDownload(listing);
                const fallback = listing.name.replace(/\.md$/i, '');
                return [{ ...parseSkillMarkdown(text, fallback), sourceRef: `${ref.owner}/${ref.repo}/${listing.path}` }];
            }
            return [];
        }

        // Directory containing a SKILL.md directly
        const direct = listing.find(e => e.type === 'file' && isSkillFile(e.name));
        if (direct) {
            const text = await fetchDownload(direct);
            const fallback = path.split('/').filter(Boolean).pop() ?? ref.repo;
            return [{ ...parseSkillMarkdown(text, fallback), sourceRef: `${ref.owner}/${ref.repo}/${direct.path}` }];
        }

        // Directory of skill folders
        const dirs = listing.filter(e => e.type === 'dir').slice(0, MAX_REPO_SKILLS);
        const collected: LoadedSkill[] = [];
        for (const dir of dirs) {
            try {
                const inner = await githubContents(ref, dir.path);
                if (!Array.isArray(inner)) continue;
                const skillFile = inner.find(e => e.type === 'file' && isSkillFile(e.name));
                if (!skillFile) continue;
                const text = await fetchDownload(skillFile);
                collected.push({
                    ...parseSkillMarkdown(text, dir.name),
                    sourceRef: `${ref.owner}/${ref.repo}/${skillFile.path}`,
                });
                if (collected.length >= MAX_REPO_SKILLS) break;
            } catch {
                // skip unreadable folder
            }
        }
        return collected;
    };

    if (ref.path) {
        results.push(...await tryPath(ref.path));
    } else {
        // Root: try SKILL.md, then a skills/ folder, then top-level folders.
        try {
            results.push(...await tryPath('SKILL.md'));
        } catch { /* not present */ }
        if (results.length === 0) {
            try {
                results.push(...await tryPath('skills'));
            } catch { /* not present */ }
        }
        if (results.length === 0) {
            results.push(...await tryPath(''));
        }
    }

    if (results.length === 0) {
        throw new Error('Keine SKILL.md-Dateien gefunden. Erwartet: SKILL.md im Pfad oder Ordner mit Skill-Unterordnern.');
    }
    return results;
}
