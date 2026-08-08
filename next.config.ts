import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) for the Docker image.
  output: "standalone",
  // Oxigraph lädt sein WASM-Artefakt zur Laufzeit über fs — nicht bundeln.
  serverExternalPackages: ["oxigraph"],
  // Die mitgelieferte Ontologie wird beim Start nach graph/vocab geladen
  // und muss im Standalone-Bundle liegen.
  outputFileTracingIncludes: {
    "/**": ["./ontology/**"],
  },
};

export default nextConfig;
