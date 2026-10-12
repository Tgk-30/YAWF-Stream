/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import packageJson from "./package.json";

// Build-time OMDb "embedded key" obfuscation (Mode 3 - serverless limited
// distribution). `OMDB_EMBED_KEY` is a NON-VITE env (so Vite does not auto-inline
// it as plaintext); we XOR + base64 it here so only the obfuscated bytes land in
// the bundle. NOTE: this only defeats casual bundle inspection - a client calling
// OMDb directly still sends the key in the request URL, so it is NOT untrackable.
// For a truly hidden key, use the server's DS_SERVER_OMDB_API_KEY proxy.
const OMDB_OBFUSCATION_PAD = "ds-omdb-embed-v1";
function obfuscateOmdbKey(plain: string): string {
  if (!plain) return "";
  const bytes = Array.from(plain).map((ch, i) =>
    ch.charCodeAt(0) ^ OMDB_OBFUSCATION_PAD.charCodeAt(i % OMDB_OBFUSCATION_PAD.length),
  );
  return Buffer.from(bytes).toString("base64");
}

// Same mechanism for the TMDB catalog key: `TMDB_EMBED_KEY` (NON-VITE env) is
// obfuscated at build time so a limited-distribution build can ship a working
// catalog with no user setup. Unset by default, so the bundle carries "".
const TMDB_OBFUSCATION_PAD = "ds-tmdb-embed-v1";
function obfuscateTmdbKey(plain: string): string {
  if (!plain) return "";
  const bytes = Array.from(plain).map((ch, i) =>
    ch.charCodeAt(0) ^ TMDB_OBFUSCATION_PAD.charCodeAt(i % TMDB_OBFUSCATION_PAD.length),
  );
  return Buffer.from(bytes).toString("base64");
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __OMDB_EMBED__: JSON.stringify(obfuscateOmdbKey(process.env.OMDB_EMBED_KEY ?? "")),
    __TMDB_EMBED__: JSON.stringify(obfuscateTmdbKey(process.env.TMDB_EMBED_KEY ?? "")),
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  build: {
    // Android 11's WebView 91 does not understand CSS media feature range
    // syntax. Keep both JS and CSS transforms on the five-year support floor
    // so the production minifier retains legacy min/max-width queries.
    target: "chrome90",
    cssTarget: "chrome90",
  },
  test: {
    globals: true,
    // Default env stays node (fast; Node's experimental localStorage). Component
    // tests opt into jsdom per-file with a `// @vitest-environment jsdom` header.
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      // Count the WHOLE source tree (not just files an import-graph happens to
      // pull in), so the reported % reflects real codebase coverage.
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.{test,spec}.{ts,tsx}",
        "src/**/*.d.ts",
        "src/test/**",
        "src/main.tsx", // app entry / bootstrap (not unit-testable)
        "src/vite-env.d.ts",
      ],
    },
  },
});
