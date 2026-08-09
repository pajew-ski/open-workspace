/**
 * M4-Abnahme (GRAPH_CORE_SPEC §13) als Tests:
 *
 *  1. ROUND-TRIP: Vault → Store → Vault ist markdown-identisch bis auf
 *     die normalisierte Frontmatter-Reihenfolge — Bodies byte-genau,
 *     Frontmatter inhaltsgleich; kanonisch formatierte Dateien sind
 *     byte-identisch. Der zweite Round-Trip (Export → Import → Export)
 *     ist vollständig byte-identisch (Fixpunkt der Normalisierung).
 *  2. Mapping nach SPEC §10: ow:Document + schema:text, Frontmatter als
 *     Quelltreue-Properties (fm:) + Wissens-Mapping bekannter Keys,
 *     Wikilinks als ow:linksTo (Alias/Einbettung als RDF-1.2-Annotation
 *     am benannten Reifier), Tags als skos:Concept mit skos:broader,
 *     Ordnerpfad als ow:inFolder.
 *  3. Export-Verlustpositionen als Tests verankert: typisierte Kanten
 *     werden auf generische Wikilinks abgeflacht (Kantentyp weg),
 *     bereits verlinkte Ziele werden nicht dupliziert.
 *  4. Framework-Regeln: Revision-No-Op, Replace bei Änderung,
 *     Konfliktregel beim Push (SPEC §6.2), Pfad-Politik (nur
 *     freigegebene Wurzeln), Fehlertoleranz (kaputtes Frontmatter
 *     quarantäniert die Einheit, der Import läuft weiter).
 */

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { parse as parseYaml } from 'yaml';
import { OxigraphStore } from '@/lib/graph/store/oxigraph';
import { createIriFactory } from '@/lib/graph/iri';
import { factory, namedNode, literal } from '@/lib/graph/rdf';
import { canonicalNQuads, isIsomorphic } from '@/lib/graph/serialize/canonical';
import { parseRdf } from '@/lib/graph/serialize/io';
import { DCTERMS, OW, OW_FRONTMATTER_BASE, PREFIXES, RDF, SCHEMA, SKOS } from '@/lib/graph/vocab';
import { createMemoryFileSystem } from '@/lib/platform/runtime/memfs';
import type { FileSystemLike } from '@/lib/platform/runtime/types';
import { createConnector, getConnector, type GraphHandle } from '@/lib/graph/connectors/registry';
import { pushConnector, syncConnector } from '@/lib/graph/connectors/sync';
import { obsidianVaultConnector } from '@/lib/graph/connectors/obsidian';
import {
    extractInlineTags,
    extractWikilinks,
    orderFrontmatterKeys,
    serializeNote,
    splitFrontmatter,
} from '@/lib/graph/connectors/obsidian/markdown';
import { normalizeVaultPath } from '@/lib/graph/connectors/obsidian/vault';
import { projectDocsToMarkdown } from '@/lib/graph/projection/obsidian';

const INSTANCE_BASE = 'urn:ow:12345678-1234-1234-1234-123456789abc:';
const VAULT = '/vaults/zettelkasten';

/**
 * Fixture-Vault. Frontmatter der „kanonischen" Dateien ist bereits in
 * normalisierter Form autoriert (title/aliases/tags zuerst, Rest
 * alphabetisch, Block-Listen, 2er-Einrückung) — für sie fordert der Test
 * BYTE-Identität. `meta/unsortiert.md` verletzt die Reihenfolge bewusst
 * und darf nur inhaltsgleich zurückkommen.
 */
const FIXTURE: Record<string, string> = {
    'willkommen.md': `---
title: Willkommen
aliases:
  - Start
tags:
  - start
  - projekt/graph
---
# Willkommen

Dieser Vault gehört zu [[Projekt Athen]] und nutzt [[begriffe/ontologie|die Ontologie]].

Eingebettet: ![[begriffe/ontologie]]

Inline: #zettel und #projekt/graph/kern gelten, \`#kein-tag-im-code\` nicht.

\`\`\`
[[kein-link-im-codeblock]] #auch-kein-tag
\`\`\`
`,
    'begriffe/ontologie.md': `---
title: Ontologie
entwurf: false
gewicht: 3
meta:
  stufe: 2
  pfad: tief
quelle: https://example.org/ontologie
typ: begriff
---
Eine Ontologie ordnet Begriffe. Zurück zu [[Willkommen]].

Ein Anhang wird keine Kante: ![[bild.png]]
`,
    'notizen/ohne-frontmatter.md': `Nur Text ohne Frontmatter.

Ein Verweis auf [[fehlt-noch]] bleibt ein Phantom-Knoten.
`,
    'meta/unsortiert.md': `---
zzz: letzter
tags: [beta, alpha]
title: Unsortiert
---
Body bleibt Byte für Byte erhalten.
`,
};

function makeVault(files: Record<string, string>, root: string = VAULT): FileSystemLike & { files: Map<string, string> } {
    const fs = createMemoryFileSystem();
    for (const [path, content] of Object.entries(files)) {
        fs.files.set(`${root}/${path}`, content);
    }
    return fs;
}

async function dumpGraph(handle: GraphHandle, graphIri: string): Promise<Quad[]> {
    const quads: Quad[] = [];
    for await (const q of handle.store.dump(namedNode(graphIri))) {
        quads.push(q);
    }
    return quads;
}

function fixedClock(): () => Date {
    let tick = 0;
    return () => new Date(Date.UTC(2026, 7, 9, 12, 0, tick += 1));
}

/** M4-Abnahme-Vergleich: byte-identisch ODER (Body byte-genau + Frontmatter inhaltsgleich). */
function expectMarkdownIdentical(exported: string, original: string, path: string): void {
    if (exported === original) return;
    const exportedSplit = splitFrontmatter(exported);
    const originalSplit = splitFrontmatter(original);
    expect(exportedSplit.body, `${path}: Body muss byte-genau erhalten bleiben`).toBe(originalSplit.body);
    expect(originalSplit.frontmatterSource, `${path}: nur Frontmatter darf normalisiert sein`).not.toBeNull();
    expect(
        parseYaml(exportedSplit.frontmatterSource ?? ''),
        `${path}: Frontmatter muss inhaltsgleich sein`,
    ).toEqual(parseYaml(originalSplit.frontmatterSource ?? ''));
}

const originalVaultRoots = process.env.OW_VAULT_ROOTS;
afterAll(() => {
    if (originalVaultRoots === undefined) delete process.env.OW_VAULT_ROOTS;
    else process.env.OW_VAULT_ROOTS = originalVaultRoots;
});

describe('obsidian-vault-Connector: M4-Abnahme', () => {
    let handle: GraphHandle;
    let vault: ReturnType<typeof makeVault>;

    beforeEach(async () => {
        process.env.OW_VAULT_ROOTS = '/vaults';
        handle = { store: new OxigraphStore(), iri: createIriFactory(INSTANCE_BASE) };
        vault = makeVault(FIXTURE);
        await createConnector(handle, { id: 'vault', name: 'Zettelkasten', kind: 'obsidian-vault', locator: VAULT });
    });

    const doc = (noteId: string) => handle.iri.entity('doc', `vault/${noteId}`);
    const sync = () => syncConnector(handle, 'vault', { files: vault, now: fixedClock() });
    const push = () => pushConnector(handle, 'vault', { files: vault, now: fixedClock() });

    it('ROUND-TRIP: Vault → Store → Vault ist markdown-identisch bis auf normalisierte Frontmatter-Reihenfolge', async () => {
        const result = await sync();
        expect(result.status).toBe('imported');
        expect(result.quarantined).toEqual([]);

        const exported = projectDocsToMarkdown(await dumpGraph(handle, handle.iri.importGraph('vault')));
        const exportedByPath = new Map(exported.files.map(file => [file.path, file.content]));

        // Gleiche Dateimenge, nichts erfunden, nichts verloren.
        expect([...exportedByPath.keys()].sort()).toEqual(Object.keys(FIXTURE).sort());

        for (const [path, original] of Object.entries(FIXTURE)) {
            expectMarkdownIdentical(exportedByPath.get(path) ?? '', original, path);
        }

        // Kanonisch autorierte Dateien kommen BYTE-identisch zurück —
        // inklusive der Datei ganz ohne Frontmatter.
        for (const path of ['willkommen.md', 'begriffe/ontologie.md', 'notizen/ohne-frontmatter.md']) {
            expect(exportedByPath.get(path), `${path}: byte-identisch`).toBe(FIXTURE[path]);
        }

        // Der Push in den unveränderten Vault schreibt folgerichtig nichts
        // Neues an den kanonischen Dateien — nur die Normalisierung von
        // meta/unsortiert.md wird materialisiert.
        const pushResult = await push();
        expect(pushResult.status).toBe('pushed');
        for (const path of ['willkommen.md', 'begriffe/ontologie.md', 'notizen/ohne-frontmatter.md']) {
            expect(vault.files.get(`${VAULT}/${path}`)).toBe(FIXTURE[path]);
        }
    });

    it('ROUND-TRIP-Fixpunkt: Export → Import → Export ist vollständig byte-identisch', async () => {
        await sync();
        const first = projectDocsToMarkdown(await dumpGraph(handle, handle.iri.importGraph('vault')));

        // Ersten Export als zweiten Vault materialisieren und erneut importieren.
        const secondVault = makeVault(Object.fromEntries(first.files.map(f => [f.path, f.content])), '/vaults/kopie');
        await createConnector(handle, { id: 'kopie', name: 'Kopie', kind: 'obsidian-vault', locator: '/vaults/kopie' });
        const second = await syncConnector(handle, 'kopie', { files: secondVault, now: fixedClock() });
        expect(second.status).toBe('imported');
        expect(second.quarantined).toEqual([]);

        const reExported = projectDocsToMarkdown(await dumpGraph(handle, handle.iri.importGraph('kopie')));
        expect(
            Object.fromEntries(reExported.files.map(f => [f.path, f.content])),
        ).toEqual(
            Object.fromEntries(first.files.map(f => [f.path, f.content])),
        );
    });

    it('mappt nach SPEC §10: Dokumente, Frontmatter (Quelltreue + Wissen), Ordner, Tags', async () => {
        await sync();
        const quads = await dumpGraph(handle, handle.iri.importGraph('vault'));
        const of = (subject: string) => quads.filter(q => q.subject.value === subject);

        // Markdown-Datei → ow:Document mit schema:text (byte-genau).
        const onto = of(doc('begriffe/ontologie'));
        expect(onto.some(q => q.predicate.value === RDF.type && q.object.value === OW.Document)).toBe(true);
        expect(onto.some(q => q.predicate.value === RDF.type && q.object.value === SCHEMA.DigitalDocument)).toBe(true);
        expect(onto.find(q => q.predicate.value === SCHEMA.text)?.object.value)
            .toBe(splitFrontmatter(FIXTURE['begriffe/ontologie.md']).body);

        // Ordnerpfad → ow:inFolder (Literal), Identität = vault-relativer Pfad.
        expect(onto.find(q => q.predicate.value === OW.inFolder)?.object.value).toBe('begriffe');
        expect(onto.find(q => q.predicate.value === DCTERMS.identifier)?.object.value).toBe('begriffe/ontologie');

        // Quelltreue: unbekannte Keys als fm:-Properties — Strings wörtlich,
        // Strukturiertes (Zahl, Bool, Map) als rdf:JSON.
        const fm = (key: string) => onto.find(q => q.predicate.value === `${OW_FRONTMATTER_BASE}${key}`)?.object;
        expect(fm('quelle')?.value).toBe('https://example.org/ontologie');
        const gewicht = fm('gewicht');
        expect(gewicht?.value).toBe('3');
        expect(gewicht?.termType === 'Literal' ? gewicht.datatype.value : undefined).toBe(RDF.JSON);
        expect(fm('entwurf')?.value).toBe('false');
        expect(JSON.parse(fm('meta')?.value ?? 'null')).toEqual({ stufe: 2, pfad: 'tief' });

        // Wissen: bekannte Keys gemappt — `typ: begriff` ⇒ skos:Concept (SPEC §10).
        expect(onto.find(q => q.predicate.value === SCHEMA.name)?.object.value).toBe('Ontologie');
        expect(onto.some(q => q.predicate.value === RDF.type && q.object.value === SKOS.Concept)).toBe(true);

        // Aliases → schema:alternateName.
        const willkommen = of(doc('willkommen'));
        expect(willkommen.some(q => q.predicate.value === SCHEMA.alternateName && q.object.value === 'Start')).toBe(true);

        // Tags: Frontmatter + Inline als skos:Concept, verschachtelt über
        // skos:broader; Code-Bereiche zählen nicht.
        const tagIri = (tag: string) => handle.iri.entity('tag', tag);
        const about = new Set(willkommen.filter(q => q.predicate.value === SCHEMA.about).map(q => q.object.value));
        expect(about).toEqual(new Set([
            tagIri('start'), tagIri('projekt/graph'), tagIri('zettel'), tagIri('projekt/graph/kern'),
        ]));
        expect(quads.some(q =>
            q.subject.value === tagIri('projekt/graph/kern') &&
            q.predicate.value === SKOS.broader &&
            q.object.value === tagIri('projekt/graph'),
        )).toBe(true);
        expect(quads.some(q =>
            q.subject.value === tagIri('projekt/graph') &&
            q.predicate.value === SKOS.broader &&
            q.object.value === tagIri('projekt'),
        )).toBe(true);
        expect(quads.some(q => q.object.value === tagIri('auch-kein-tag'))).toBe(false);
    });

    it('mappt Wikilinks: ow:linksTo, Alias und Einbettung als RDF-1.2-Annotation am Reifier, Anhänge ausgenommen', async () => {
        await sync();
        const quads = await dumpGraph(handle, handle.iri.importGraph('vault'));
        const willkommen = doc('willkommen');

        // [[begriffe/ontologie|…]] und ![[begriffe/ontologie]] ⇒ EINE Kante …
        const links = quads.filter(q => q.subject.value === willkommen && q.predicate.value === OW.linksTo);
        const targets = new Set(links.map(q => q.object.value));
        expect(targets.has(doc('begriffe/ontologie'))).toBe(true);
        // … Phantom-Ziel wie in Obsidian; Code-Block-Link existiert nicht.
        expect(targets.has(doc('Projekt Athen'))).toBe(true);
        expect(targets.has(doc('kein-link-im-codeblock'))).toBe(false);
        expect(links).toHaveLength(2);

        // [[Willkommen]] aus dem Unterordner löst über den Basenamen auf.
        expect(quads.some(q =>
            q.subject.value === doc('begriffe/ontologie') &&
            q.predicate.value === OW.linksTo &&
            q.object.value === willkommen,
        )).toBe(true);
        // ![[bild.png]] ist ein Anhang — keine Kante auf eine Phantom-Notiz.
        expect(quads.some(q => q.object.value === doc('bild.png'))).toBe(false);

        // Annotationen: benannter Reifier mit rdf:reifies auf den Triple-Term.
        const reifiers = quads.filter(q => q.predicate.value === RDF.reifies);
        expect(reifiers).toHaveLength(2);
        for (const q of reifiers) {
            expect(q.object.termType).toBe('Quad');
            const inner = q.object as Quad;
            expect(inner.subject.value).toBe(willkommen);
            expect(inner.predicate.value).toBe(OW.linksTo);
            expect(inner.object.value).toBe(doc('begriffe/ontologie'));
        }
        const reifierIris = reifiers.map(q => q.subject.value);
        const alias = quads.find(q => reifierIris.includes(q.subject.value) && q.predicate.value === SCHEMA.alternateName);
        expect(alias?.object.value).toBe('die Ontologie');
        const embedded = quads.find(q => reifierIris.includes(q.subject.value) && q.predicate.value === OW.embedded);
        expect(embedded?.object.value).toBe('true');

        // Die Annotation bleibt serialisier- und wiederherstellbar (SPEC §8):
        // kanonische N-Quads mit Triple-Term parsen zurück ins gleiche Dataset.
        const canonical = await canonicalNQuads(quads);
        expect(canonical).toContain('<<(');
        const reparsed = parseRdf(canonical, { format: 'application/n-quads' });
        expect(await isIsomorphic(quads.map(q => factory.quad(q.subject, q.predicate, q.object)), reparsed.map(q => factory.quad(q.subject, q.predicate, q.object)))).toBe(true);
    });

    it('Revision: unveränderter Vault ist ein No-Op, Änderung ein sauberer Replace', async () => {
        const first = await sync();
        expect(first.status).toBe('imported');

        const second = await sync();
        expect(second.status).toBe('noop');
        expect(second.revision).toBe(first.revision);

        vault.files.set(`${VAULT}/neu.md`, 'Ganz neu, verweist auf [[Willkommen]].\n');
        const third = await sync();
        expect(third.status).toBe('imported');
        expect(third.revision).not.toBe(first.revision);

        const quads = await dumpGraph(handle, handle.iri.importGraph('vault'));
        expect(quads.some(q => q.subject.value === doc('neu'))).toBe(true);

        vault.files.delete(`${VAULT}/neu.md`);
        const fourth = await sync();
        expect(fourth.status).toBe('imported');
        const after = await dumpGraph(handle, handle.iri.importGraph('vault'));
        expect(after.some(q => q.subject.value === doc('neu'))).toBe(false);
    });

    it('Fehlertoleranz: kaputtes Frontmatter quarantäniert die Einheit, der Body wird trotzdem importiert', async () => {
        vault.files.set(`${VAULT}/kaputt.md`, '---\ntitle: [unvollständig\n---\nDer Body überlebt trotzdem.\n');
        const result = await sync();
        expect(result.status).toBe('imported');
        expect(result.quarantined).toHaveLength(1);
        expect(result.quarantined[0].source).toBe('kaputt.md');

        const quads = await dumpGraph(handle, handle.iri.importGraph('vault'));
        expect(quads.find(q => q.subject.value === doc('kaputt') && q.predicate.value === SCHEMA.text)?.object.value)
            .toBe('Der Body überlebt trotzdem.\n');

        // Fehlerbericht in graph/meta (UI-sichtbar), wie bei M3.
        const view = await getConnector(handle, 'vault');
        expect(view?.lastRun?.errors[0]).toContain('kaputt.md');
    });

    it('Pfad-Politik: Vault-Pfade außerhalb der freigegebenen Wurzeln sind blockiert', async () => {
        await createConnector(handle, { id: 'boese', name: 'Systemordner', kind: 'obsidian-vault', locator: '/etc' });
        const result = await syncConnector(handle, 'boese', { files: vault, now: fixedClock() });
        expect(result.status).toBe('failed');
        expect(result.message).toContain('blockiert');

        expect(() => normalizeVaultPath('../ausbruch')).toThrow(/klettert/);
        expect(normalizeVaultPath('/vaults//unter/./ordner/../x')).toBe('/vaults/unter/x');
    });

    it('ohne Dateizugriff in der Runtime scheitert der Lauf ehrlich', async () => {
        const result = await syncConnector(handle, 'vault', { now: fixedClock() });
        expect(result.status).toBe('failed');
        expect(result.message).toContain('Dateizugriff');
    });

    it('Push-Konfliktregel (SPEC §6.2): extern veränderter Vault blockiert den Export, bis erneut synchronisiert wurde', async () => {
        await sync();

        vault.files.set(`${VAULT}/willkommen.md`, 'Extern umgeschrieben.\n');
        const conflicted = await push();
        expect(conflicted.status).toBe('conflict');
        expect(conflicted.message).toContain('extern verändert');
        expect(conflicted.conflicts.some(c => c.path === 'willkommen.md')).toBe(true);
        expect((await getConnector(handle, 'vault'))?.syncState).toBe('conflict');
        // Nichts wurde geschrieben.
        expect(vault.files.get(`${VAULT}/willkommen.md`)).toBe('Extern umgeschrieben.\n');

        // Erneuter Sync nimmt die externe Änderung auf, danach ist der
        // Export wieder erlaubt und der Zustand konsistent.
        await sync();
        const pushed = await push();
        expect(pushed.status).toBe('pushed');
        expect((await getConnector(handle, 'vault'))?.syncState).toBe('idle');
        expect((await getConnector(handle, 'vault'))?.revision).toBe(pushed.revision);
    });

    it('Push in einen nie synchronisierten, nicht-leeren Vault ist verboten; in einen leeren erlaubt', async () => {
        const untouched = await push();
        expect(untouched.status).toBe('conflict');
        expect(untouched.message).toContain('noch nie synchronisiert');

        // Leerer Vault: Export aus dem (leeren) Import-Graphen ist erlaubt
        // und schreibt schlicht nichts.
        const emptyFs = makeVault({}, '/vaults/leer');
        await emptyFs.mkdir('/vaults/leer');
        await createConnector(handle, { id: 'leer', name: 'Leer', kind: 'obsidian-vault', locator: '/vaults/leer' });
        const result = await pushConnector(handle, 'leer', { files: emptyFs, now: fixedClock() });
        expect(result.status).toBe('pushed');
    });

    it('VERLUSTPOSITION: typisierte Kanten flachen beim Export zu generischen Wikilinks ab, ohne Bestehendes zu duplizieren', async () => {
        await sync();
        const graph = namedNode(handle.iri.importGraph('vault'));

        // Nativ ergänzte typisierte Kanten im Import-Graphen:
        //  - unsortiert --prov:wasDerivedFrom--> ohne-frontmatter (nicht im Body ⇒ anhängen)
        //  - ontologie --prov:wasDerivedFrom--> willkommen (im Body verlinkt ⇒ NICHT duplizieren)
        await handle.store.load([
            factory.quad(
                namedNode(doc('meta/unsortiert')),
                namedNode(`${PREFIXES.prov}wasDerivedFrom`),
                namedNode(doc('notizen/ohne-frontmatter')),
            ),
            factory.quad(
                namedNode(doc('begriffe/ontologie')),
                namedNode(`${PREFIXES.prov}wasDerivedFrom`),
                namedNode(doc('willkommen')),
            ),
        ], graph);

        const exported = projectDocsToMarkdown(await dumpGraph(handle, handle.iri.importGraph('vault')));
        expect(exported.flattenedLinks).toBe(1);
        const byPath = new Map(exported.files.map(f => [f.path, f.content]));

        // Kantentyp verloren, Ziel als generischer Wikilink angehängt.
        expect(byPath.get('meta/unsortiert.md')).toContain('\n[[ohne-frontmatter]]\n');
        expect(byPath.get('meta/unsortiert.md')).not.toContain('wasDerivedFrom');
        // Bereits im Body verlinkte Ziele werden nicht dupliziert.
        expect(byPath.get('begriffe/ontologie.md')).toBe(FIXTURE['begriffe/ontologie.md']);
    });

    it('Locator↔Config-Round-Trip und Konfigurationsvalidierung', () => {
        const config = obsidianVaultConnector.parseConfig({ path: 'data/vaults//mein-vault/' });
        const locator = obsidianVaultConnector.locatorFor(config);
        expect(locator).toBe('data/vaults/mein-vault');
        expect(obsidianVaultConnector.configFromLocator(locator)).toEqual({ path: 'data/vaults/mein-vault' });
        expect(() => obsidianVaultConnector.parseConfig({ path: '../ausbruch' })).toThrow(/klettert/);
        expect(() => obsidianVaultConnector.parseConfig({ path: '' })).toThrow();
    });
});

describe('Obsidian-Markdown-Bausteine', () => {
    it('trennt Frontmatter byte-genau vom Body (inkl. Sonderfälle)', () => {
        expect(splitFrontmatter('kein frontmatter')).toEqual({ frontmatterSource: null, body: 'kein frontmatter' });
        expect(splitFrontmatter('---\na: 1\n---\nBody\n')).toEqual({ frontmatterSource: 'a: 1', body: 'Body\n' });
        expect(splitFrontmatter('---\n---\nBody')).toEqual({ frontmatterSource: '', body: 'Body' });
        expect(splitFrontmatter('---\na: 1\n---')).toEqual({ frontmatterSource: 'a: 1', body: '' });
        // Trennlinien im Body bleiben Body.
        const withRule = '---\na: 1\n---\nText\n\n---\n\nMehr Text\n';
        expect(splitFrontmatter(withRule).body).toBe('Text\n\n---\n\nMehr Text\n');
    });

    it('extrahiert Wikilinks mit Alias, Heading und Einbettung in Dokumentreihenfolge', () => {
        const body = 'A [[Ziel]] B [[Ziel#Kapitel|Anders]] C ![[Bild und Text]] D [[#nur-heading]]';
        expect(extractWikilinks(body)).toEqual([
            { target: 'Ziel', heading: undefined, alias: undefined, embed: false, index: 0 },
            { target: 'Ziel', heading: 'Kapitel', alias: 'Anders', embed: false, index: 1 },
            { target: 'Bild und Text', heading: undefined, alias: undefined, embed: true, index: 2 },
        ]);
    });

    it('erkennt Inline-Tags nach Obsidian-Regeln und ignoriert Überschriften, Zahlen und Code', () => {
        const body = '# Überschrift\n\n#gültig #tag/unter #_auch #123 sind Kandidaten, `#code` nicht.\n\n```\n#fence\n```\n';
        expect(extractInlineTags(body)).toEqual(['_auch', 'gültig', 'tag/unter']);
    });

    it('normalisiert die Frontmatter-Reihenfolge deterministisch (title/aliases/tags zuerst, Rest alphabetisch)', () => {
        expect(orderFrontmatterKeys(['zzz', 'tags', 'anfang', 'title'])).toEqual(['title', 'tags', 'anfang', 'zzz']);
        expect(serializeNote({}, 'nur body')).toBe('nur body');
        expect(serializeNote({ title: 'T' }, 'B\n')).toBe('---\ntitle: T\n---\nB\n');
    });
});
