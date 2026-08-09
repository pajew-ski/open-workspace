/**
 * Obsidian-Markdown-Analyse (SPEC §10) — pur, ohne Store- oder
 * Dateisystem-Bindung.
 *
 * Round-Trip-Prinzip: Der Body wird NIE verändert oder getrimmt — er ist
 * byte-genau der Text nach dem Frontmatter-Block (bzw. die ganze Datei).
 * Wikilinks und Tags werden nur ZUSÄTZLICH extrahiert; ihr Träger bleibt
 * der Text selbst. Der Frontmatter-Block wird beim Export aus den
 * geparsten Werten neu serialisiert (Reihenfolge normalisiert, YAML-
 * Formatierung kanonisch) — genau die Toleranz, die die M4-Abnahme
 * erlaubt („markdown-identisch bis auf normalisierte Frontmatter-
 * Reihenfolge").
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** Frontmatter-Werte, wie YAML sie liefert (Core-Schema, keine Dates). */
export type FrontmatterValue = string | number | boolean | null | FrontmatterValue[] | { [key: string]: FrontmatterValue };

export interface SplitNote {
    /** YAML-Quelltext zwischen den `---`-Zeilen; null ohne Block. */
    frontmatterSource: string | null;
    /** Byte-genauer Rest der Datei nach dem schließenden `---`. */
    body: string;
}

/**
 * Trennt den Frontmatter-Block vom Body. Ein leerer Block (`---\n---`)
 * zählt als vorhanden, aber leer. Der Body wird nicht normalisiert.
 */
export function splitFrontmatter(content: string): SplitNote {
    const match = content.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/);
    if (!match) {
        return { frontmatterSource: null, body: content };
    }
    return {
        frontmatterSource: match[1] ?? '',
        body: content.slice(match[0].length),
    };
}

/** Geparster Frontmatter als Key→Wert-Abbildung. Wirft bei kaputtem YAML. */
export function parseFrontmatter(source: string): Record<string, FrontmatterValue> {
    if (source.trim() === '') return {};
    const parsed: unknown = parseYaml(source);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Frontmatter ist kein YAML-Mapping (Key: Wert).');
    }
    return parsed as Record<string, FrontmatterValue>;
}

/**
 * Normalisierte Frontmatter-Reihenfolge (M4-Abnahme): erst die
 * Obsidian-üblichen Keys in fester Folge, danach alle weiteren
 * alphabetisch. Deterministisch, damit Export-Dumps git-stabil sind.
 */
const CANONICAL_KEY_ORDER = ['title', 'aliases', 'tags'] as const;

export function orderFrontmatterKeys(keys: Iterable<string>): string[] {
    const all = [...keys];
    const head = CANONICAL_KEY_ORDER.filter(key => all.includes(key));
    const rest = all.filter(key => !(CANONICAL_KEY_ORDER as readonly string[]).includes(key)).sort();
    return [...head, ...rest];
}

/**
 * Serialisiert Frontmatter + Body zu einer Markdown-Datei. Keys in
 * normalisierter Reihenfolge, YAML kanonisch (Block-Stil, ohne
 * Zeilenumbruch-Begrenzung). Ohne Einträge entsteht KEIN leerer Block —
 * eine Datei ohne Frontmatter bleibt eine Datei ohne Frontmatter.
 */
export function serializeNote(frontmatter: Record<string, FrontmatterValue>, body: string): string {
    const keys = orderFrontmatterKeys(Object.keys(frontmatter));
    if (keys.length === 0) return body;
    const ordered: Record<string, FrontmatterValue> = {};
    for (const key of keys) {
        ordered[key] = frontmatter[key];
    }
    // lineWidth: 0 — kein Umbruch langer Werte, sonst wäre der Round-Trip
    // von der Zeilenlänge abhängig.
    const yaml = stringifyYaml(ordered, { lineWidth: 0 });
    return `---\n${yaml}---\n${body}`;
}

export interface WikilinkOccurrence {
    /** Ziel wie geschrieben, ohne Heading-/Alias-Anteil, getrimmt. */
    target: string;
    /** `#Überschrift`-Anteil (ohne #), falls vorhanden. */
    heading?: string;
    /** Alias nach `|`, falls vorhanden. */
    alias?: string;
    /** true bei `![[…]]` (Einbettung/Transklusion). */
    embed: boolean;
    /** Reihenfolge des Auftretens im Dokument (0-basiert). */
    index: number;
}

/**
 * Blendet Code-Bereiche aus, bevor Links/Tags extrahiert werden:
 * Fenced-Blöcke (```/~~~) zeilenweise, Inline-Spans (`…`) je Zeile.
 * Positionen bleiben unerheblich — es zählt nur die Reihenfolge.
 */
export function scannableText(body: string): string {
    const lines = body.split('\n');
    const out: string[] = [];
    let fence: string | null = null;
    for (const line of lines) {
        const fenceMatch = line.match(/^\s*(```|~~~)/);
        if (fence === null && fenceMatch) {
            fence = fenceMatch[1];
            out.push('');
            continue;
        }
        if (fence !== null) {
            if (fenceMatch && fenceMatch[1] === fence) fence = null;
            out.push('');
            continue;
        }
        out.push(line.replace(/`[^`\n]*`/g, ' '));
    }
    return out.join('\n');
}

/** Datei-Endungen, die als Anhang gelten (kein Notiz-Link). */
const ATTACHMENT_EXTENSION = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico|pdf|mp3|wav|ogg|m4a|flac|mp4|webm|mov|mkv|zip|7z|gz|tar|docx?|xlsx?|pptx?|json|css|js|ts|excalidraw)$/i;

export function isAttachmentTarget(target: string): boolean {
    return ATTACHMENT_EXTENSION.test(target);
}

/** Canvas-Dateien sind Präsentationsschicht (M5), keine Notizen. */
export function isCanvasTarget(target: string): boolean {
    return /\.canvas$/i.test(target);
}

/**
 * Extrahiert alle Wikilinks (`[[Ziel]]`, `[[Ziel|Alias]]`, `[[Ziel#Kap]]`,
 * `![[Einbettung]]`) außerhalb von Code-Bereichen, in Dokumentreihenfolge.
 */
export function extractWikilinks(body: string): WikilinkOccurrence[] {
    const text = scannableText(body);
    const occurrences: WikilinkOccurrence[] = [];
    for (const match of text.matchAll(/(!?)\[\[([^\][\n]+?)\]\]/g)) {
        const embed = match[1] === '!';
        const inner = match[2];
        const pipeIndex = inner.indexOf('|');
        const targetPart = (pipeIndex === -1 ? inner : inner.slice(0, pipeIndex)).trim();
        const alias = pipeIndex === -1 ? undefined : inner.slice(pipeIndex + 1).trim();
        const hashIndex = targetPart.indexOf('#');
        const target = (hashIndex === -1 ? targetPart : targetPart.slice(0, hashIndex)).trim();
        const heading = hashIndex === -1 ? undefined : targetPart.slice(hashIndex + 1).trim();
        // `[[#Nur-Überschrift]]` verweist ins eigene Dokument — keine Kante.
        if (target === '') continue;
        occurrences.push({
            target,
            heading: heading || undefined,
            alias: alias || undefined,
            embed,
            index: occurrences.length,
        });
    }
    return occurrences;
}

/**
 * Inline-Tags nach Obsidian-Regeln: `#tag`, `#tag/unter`; erlaubt sind
 * Buchstaben (inkl. Umlaute), Ziffern, `_`, `-`, `/`; mindestens ein
 * nicht-numerisches Zeichen. Überschriften (`# Titel`) matchen nicht,
 * Code-Bereiche sind ausgeblendet.
 */
export function extractInlineTags(body: string): string[] {
    const text = scannableText(body);
    const tags = new Set<string>();
    for (const match of text.matchAll(/(^|[^\p{L}\p{N}_#])#([\p{L}\p{N}_/-]+)/gu)) {
        const raw = match[2].replace(/^\/+|\/+$/g, '');
        if (raw === '' || !/[\p{L}_-]/u.test(raw)) continue;
        tags.add(raw);
    }
    return [...tags].sort();
}

/**
 * Frontmatter-Tags: Liste (`tags: [a, b]` / Block-Liste) oder String mit
 * Komma-/Leerzeichen-Trennung; `tag:` (Singular) wird ebenso gelesen.
 */
export function frontmatterTags(frontmatter: Record<string, FrontmatterValue>): string[] {
    const collected = new Set<string>();
    for (const key of ['tags', 'tag']) {
        const value = frontmatter[key];
        if (value === undefined || value === null) continue;
        const entries = Array.isArray(value)
            ? value
            : String(value).split(/[,\s]+/);
        for (const entry of entries) {
            const tag = String(entry).trim().replace(/^#/, '').replace(/^\/+|\/+$/g, '');
            if (tag !== '') collected.add(tag);
        }
    }
    return [...collected].sort();
}

/** Vault-relativer Pfad ohne `.md` — die stabile Identität einer Notiz. */
export function noteIdFromPath(relativePath: string): string {
    return relativePath.replace(/\.md$/i, '');
}

/** Notizname (Basename ohne Endung) — Obsidians Auflösungs-Schlüssel. */
export function noteNameFromPath(relativePath: string): string {
    const id = noteIdFromPath(relativePath);
    const slash = id.lastIndexOf('/');
    return slash === -1 ? id : id.slice(slash + 1);
}

/** Ordner-Anteil eines vault-relativen Pfads ('' für die Wurzel). */
export function folderFromPath(relativePath: string): string {
    const slash = relativePath.lastIndexOf('/');
    return slash === -1 ? '' : relativePath.slice(0, slash);
}
