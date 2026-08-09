import type { NextConfig } from "next";

/**
 * Base-Path (SPEC §5.2, M12): Home-Assistant-Ingress proxied die App unter
 * einem Pfad, der erst zur Installationszeit feststeht
 * (`/api/hassio_ingress/<token>`). Next backt `basePath` in den Build, also
 * baut das Container-Image mit dem Platzhalter `/__ow_base__`
 * (`OW_BASE_PATH`), und `scripts/start.mjs` ersetzt ihn beim Start durch den
 * echten Pfad (bzw. durch nichts). Ohne gesetzte Variable — lokale
 * Entwicklung, `bun run build` — hat die App keinen Base-Path.
 *
 * `OW_DIST_DIR` erlaubt einen zweiten Build neben `.next` (der
 * E2E-Ingress-Lauf braucht ihn, siehe scripts/e2e-ingress-server.mjs).
 */
const basePath = process.env.OW_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) for the Docker image.
  output: "standalone",
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  ...(process.env.OW_DIST_DIR ? { distDir: process.env.OW_DIST_DIR } : {}),
  env: {
    // Clientseitig sichtbarer Base-Path. Wird als Literal in die Bundles
    // eingebacken und beim Start mit demselben Rewrite ersetzt wie der
    // Next-eigene basePath — es gibt genau EINEN Platzhalter.
    NEXT_PUBLIC_OW_BASE_PATH: basePath,
  },
  // Oxigraph lädt sein WASM-Artefakt zur Laufzeit über fs — nicht bundeln.
  serverExternalPackages: ["oxigraph"],
  // Die mitgelieferte Ontologie wird beim Start nach graph/vocab geladen
  // und muss im Standalone-Bundle liegen.
  outputFileTracingIncludes: {
    "/**": ["./ontology/**"],
  },
};

export default nextConfig;
