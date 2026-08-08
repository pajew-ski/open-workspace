/**
 * PWA-Icon-Generator für Open Workspace.
 *
 * Erzeugt die App-Icons im "Digital Zen Garden"-Stil (Teal #00674F,
 * weißes Zen-Garten-Motiv: drei konzentrische, unvollständige Kreise
 * um einen Stein — das Rechen-Muster eines Zen-Gartens) als PNG:
 *
 *   public/icons/icon-192.png            (purpose: any)
 *   public/icons/icon-512.png            (purpose: any)
 *   public/icons/icon-maskable-192.png   (purpose: maskable, Safe-Zone ~80%)
 *   public/icons/icon-maskable-512.png   (purpose: maskable, Safe-Zone ~80%)
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
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

/** Basis-Koordinatensystem des Motivs (viewBox). */
const ART = 1024;
const CX = ART / 2;
const CY = ART / 2;

/** Teal-Palette (Digital Zen Garden). */
const TEAL = "#00674F";
const TEAL_LIGHT = "#077257";
const TEAL_DEEP = "#015741";

interface IconSpec {
  file: string;
  size: number;
  /**
   * Skalierung des Motivs relativ zur Vollversion. Maskable-Icons müssen
   * ihren Inhalt in der Safe-Zone (~80 % der Kantenlänge) halten, da
   * Launcher den Rand beschneiden (Kreis, Squircle, ...).
   */
  contentScale: number;
}

const SPECS: IconSpec[] = [
  { file: "icon-192.png", size: 192, contentScale: 1 },
  { file: "icon-512.png", size: 512, contentScale: 1 },
  { file: "icon-maskable-192.png", size: 192, contentScale: 0.78 },
  { file: "icon-maskable-512.png", size: 512, contentScale: 0.78 },
];

/**
 * Kreisbogen (unvollständiger Kreis) um den Ursprung.
 * @param r Radius
 * @param gapCenterDeg Winkel (Grad), an dem die Lücke zentriert ist
 * @param gapDeg Breite der Lücke in Grad
 */
function arcPath(r: number, gapCenterDeg: number, gapDeg: number): string {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const startDeg = gapCenterDeg + gapDeg / 2;
  const endDeg = gapCenterDeg - gapDeg / 2 + 360;
  const sweep = endDeg - startDeg;
  const sx = (r * Math.cos(toRad(startDeg))).toFixed(3);
  const sy = (r * Math.sin(toRad(startDeg))).toFixed(3);
  const ex = (r * Math.cos(toRad(endDeg))).toFixed(3);
  const ey = (r * Math.sin(toRad(endDeg))).toFixed(3);
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${sx} ${sy} A ${r} ${r} 0 ${largeArc} 1 ${ex} ${ey}`;
}

/**
 * Das Icon als eigenständiges SVG. Volle Teal-Fläche (full bleed, für
 * maskable zwingend), darüber das weiße Zen-Motiv: Stein + drei
 * konzentrische Rechen-Kreise mit versetzten Lücken, nach außen sanft
 * verblassend. Keine Schrift, keine externen Ressourcen.
 */
function iconSvg(size: number, contentScale: number): string {
  const stroke = 44;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${ART} ${ART}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="80%">
      <stop offset="0%" stop-color="${TEAL_LIGHT}"/>
      <stop offset="55%" stop-color="${TEAL}"/>
      <stop offset="100%" stop-color="${TEAL_DEEP}"/>
    </radialGradient>
  </defs>
  <rect width="${ART}" height="${ART}" fill="url(#bg)"/>
  <g transform="translate(${CX} ${CY}) scale(${contentScale})"
     fill="none" stroke="#FFFFFF" stroke-width="${stroke}" stroke-linecap="round">
    <circle r="62" fill="#FFFFFF" stroke="none"/>
    <path d="${arcPath(160, 200, 78)}" opacity="1"/>
    <path d="${arcPath(256, 330, 62)}" opacity="0.9"/>
    <path d="${arcPath(352, 80, 48)}" opacity="0.8"/>
  </g>
</svg>`;
}

/** Bekannte Chromium-Pfade in dieser Umgebung als Fallback ermitteln. */
function findChromiumExecutable(): string | undefined {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH ?? "", "/opt/pw-browsers"].filter(Boolean);
  for (const root of roots) {
    const direct = join(root, "chromium");
    if (existsSync(direct)) return direct;
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("chromium-")) continue;
      const candidate = join(root, entry, "chrome-linux", "chrome");
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

async function launchBrowser() {
  const options = { headless: true, args: ["--no-sandbox", "--force-color-profile=srgb", "--hide-scrollbars"] };
  try {
    return await chromium.launch(options);
  } catch {
    const executablePath = findChromiumExecutable();
    if (!executablePath) throw new Error("Kein Chromium gefunden (PLAYWRIGHT_BROWSERS_PATH prüfen).");
    return await chromium.launch({ ...options, executablePath });
  }
}

/** PNG-Validierung: Magic Bytes + IHDR-Dimensionen + Mindestgröße. */
function verifyPng(path: string, expectedSize: number): void {
  const buf = readFileSync(path);
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(magic)) throw new Error(`${path}: keine gültigen PNG-Magic-Bytes`);
  if (buf.length <= 1024) throw new Error(`${path}: verdächtig klein (${buf.length} Bytes)`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`${path}: ${width}x${height} statt ${expectedSize}x${expectedSize}`);
  }
  console.log(`  ok ${path} (${width}x${height}, ${buf.length} Bytes)`);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await launchBrowser();
  try {
    for (const spec of SPECS) {
      const page = await browser.newPage({
        viewport: { width: spec.size, height: spec.size },
        deviceScaleFactor: 1,
      });
      const svg = iconSvg(spec.size, spec.contentScale);
      await page.setContent(
        `<!DOCTYPE html><html><head><style>html,body{margin:0;padding:0;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`,
        { waitUntil: "load" },
      );
      const outPath = join(OUT_DIR, spec.file);
      await page.screenshot({ path: outPath, type: "png" });
      await page.close();
      verifyPng(outPath, spec.size);
    }
  } finally {
    await browser.close();
  }
  console.log(`Fertig: ${SPECS.length} Icons in ${OUT_DIR}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
