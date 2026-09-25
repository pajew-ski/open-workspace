/**
 * PWA-Icon-Generator für Open Workspace.
 *
 * Erzeugt die App-Icons im Stil der temet-nosce-Familie (achromatisch:
 * dunkle abgerundete Fläche oklch(15 % 0 0), helle Glyphe oklch(95 % 0 0);
 * die Glyphe ist ein kleiner Graph, ein Knoten mit drei Nachbarn) als PNG:
 *
 *   public/icons/icon-192.png            (purpose: any)
 *   public/icons/icon-512.png            (purpose: any)
 *   public/icons/icon-maskable-192.png   (purpose: maskable, Safe-Zone ~80%)
 *   public/icons/icon-maskable-512.png   (purpose: maskable, Safe-Zone ~80%)
 *
 * Dieselbe Glyphe liegt als icon.png in der Home Assistant Apps Collection
 * neben den Icons der Geschwister-Apps; die Familie teilt Fläche, Farbe und
 * Strichstärke, nur das Motiv unterscheidet sich.
 *
 * Aufruf (aus dem Repo-Root):
 *
 *   bun scripts/generate-icons.ts
 *
 * Voraussetzungen: @playwright/test (devDependency) und ein installiertes
 * Playwright-Chromium. In dieser Umgebung ist PLAYWRIGHT_BROWSERS_PATH
 * auf /opt/pw-browsers gesetzt; findet chromium.launch() den Browser
 * nicht, fällt das Skript automatisch auf bekannte Binary-Pfade unter
 * /opt/pw-browsers zurück. Keine weiteren Dependencies, kein Build-Step.
 */

import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

/** Basis-Koordinatensystem des Motivs (viewBox), 128 wie in der Collection. */
const ART = 128;

/** sRGB-Äquivalente der Familien-Token oklch(15 % 0 0) und oklch(95 % 0 0). */
const BG = "#0b0b0b";
const FG = "#ececec";

interface IconSpec {
  file: string;
  size: number;
  /**
   * Maskable-Icons müssen ihren Inhalt in der Safe-Zone (~80 % der
   * Kantenlänge) halten, da Launcher den Rand beschneiden (Kreis,
   * Squircle, ...). Die Fläche füllt dann das ganze Quadrat ohne Rundung.
   */
  maskable: boolean;
}

const SPECS: IconSpec[] = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-maskable-192.png", size: 192, maskable: true },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
];

/** Die Glyphe: ein Knoten in der Mitte, drei Nachbarn, Kanten dazwischen. */
const GLYPH = `
  <path d="M64 64 L34 39 M64 64 L94 39 M64 64 L64 99" stroke="${FG}" stroke-width="6" stroke-linecap="round"/>
  <circle cx="64" cy="64" r="13" fill="${FG}"/>
  <circle cx="34" cy="39" r="9" fill="${FG}"/>
  <circle cx="94" cy="39" r="9" fill="${FG}"/>
  <circle cx="64" cy="99" r="9" fill="${FG}"/>`;

function svg(spec: IconSpec): string {
  const inner = spec.maskable
    ? `<g transform="translate(64 64) scale(0.8) translate(-64 -64)">${GLYPH}</g>`
    : GLYPH;
  const bg = spec.maskable
    ? `<rect width="${ART}" height="${ART}" fill="${BG}"/>`
    : `<rect width="${ART}" height="${ART}" rx="21" fill="${BG}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ART} ${ART}" width="${spec.size}" height="${spec.size}">${bg}${inner}</svg>`;
}

/** Bekannte Browser-Pfade, falls Playwright den eigenen nicht findet. */
function findChromium(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith("chromium-")) continue;
    for (const candidate of ["chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const full = join(root, entry, candidate);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch().catch(() => chromium.launch({ executablePath: findChromium() }));
  for (const spec of SPECS) {
    const page = await browser.newPage({ viewport: { width: spec.size, height: spec.size }, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg(spec)}</body></html>`);
    await page.addStyleTag({ content: `svg{display:block}` });
    const out = join(OUT_DIR, spec.file);
    await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: spec.size, height: spec.size } });
    await page.close();
    console.log(`${spec.file} (${spec.size}px${spec.maskable ? ", maskable" : ""})`);
  }
  await browser.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
