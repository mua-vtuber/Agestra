#!/usr/bin/env node

// Bundle script for Agestra plugin distribution
// Produces a single-file ESM bundle at dist/bundle.js

import * as esbuild from "esbuild";
import { cpSync, mkdirSync, statSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

// ── Read package.json version (single source of truth) ──────
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));

// ── ESM compatibility banner ─────────────────────────────────
// fts5-sql-bundle is CJS and uses require(), __dirname, __filename.
// Since we output ESM, we shim these at the top of the bundle.
const banner = [
  `import { createRequire as ___cr } from 'module';`,
  `import { fileURLToPath as ___fu } from 'url';`,
  `import { dirname as ___dn } from 'path';`,
  `const __filename = ___fu(import.meta.url);`,
  `const __dirname = ___dn(__filename);`,
  `const require = ___cr(import.meta.url);`,
].join("");

// ── esbuild plugin: externalize sql-wasm.js ──────────────────
// The Emscripten-generated sql-wasm.js uses dynamic patterns
// (eval, dynamic require, WASM loading) that confuse bundlers.
// We mark the internal require('./sql-wasm.js') as external so
// it loads at runtime from the dist/ directory alongside the bundle.
const sqlWasmExternalPlugin = {
  name: "sql-wasm-external",
  setup(build) {
    // Intercept the require('./sql-wasm.js') from fts5-sql-bundle/dist/index.js
    build.onResolve({ filter: /\.\/sql-wasm\.js$/ }, (args) => {
      // Only externalize when resolved from within fts5-sql-bundle
      if (args.resolveDir.includes("fts5-sql-bundle")) {
        return { path: "./sql-wasm.js", external: true };
      }
      return undefined;
    });
  },
};

// ── Build ────────────────────────────────────────────────────
async function main() {
  const entryPoint = resolve(ROOT, "packages/mcp-server/src/index.ts");
  const outfile = resolve(ROOT, "dist/bundle.js");

  console.log("Building Agestra plugin bundle...");
  console.log(`  Entry: ${entryPoint}`);
  console.log(`  Output: ${outfile}`);

  // Ensure dist/ exists
  mkdirSync(resolve(ROOT, "dist"), { recursive: true });

  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    target: "node18",
    format: "esm",
    outfile,
    sourcemap: true,
    banner: { js: banner },
    plugins: [sqlWasmExternalPlugin],
    // Inject PROJECT_VERSION from package.json at build time
    define: {
      __PROJECT_VERSION__: JSON.stringify(pkg.version),
    },
    // Let esbuild resolve workspace packages via tsconfig paths
    // Node built-ins are automatically external for platform: "node"
  });

  if (result.errors.length > 0) {
    console.error("Build failed with errors:");
    for (const err of result.errors) {
      console.error(`  ${err.text}`);
    }
    process.exit(1);
  }

  if (result.warnings.length > 0) {
    console.warn(`Build completed with ${result.warnings.length} warning(s).`);
  }

  // ── Copy WASM assets to dist/ ────────────────────────────
  const fts5Dist = resolve(ROOT, "node_modules/fts5-sql-bundle/dist");
  const distDir = resolve(ROOT, "dist");

  // Copy sql-wasm.wasm (the WASM binary)
  cpSync(resolve(fts5Dist, "sql-wasm.wasm"), resolve(distDir, "sql-wasm.wasm"));
  console.log("  Copied sql-wasm.wasm to dist/");

  // Copy sql-wasm.js (externalized Emscripten loader)
  cpSync(resolve(fts5Dist, "sql-wasm.js"), resolve(distDir, "sql-wasm.js"));
  console.log("  Copied sql-wasm.js to dist/");

  // ── Sync plugin.json version ────────────────────────────
  const pluginPath = resolve(ROOT, ".claude-plugin/plugin.json");
  const plugin = JSON.parse(readFileSync(pluginPath, "utf-8"));
  if (plugin.version !== pkg.version) {
    plugin.version = pkg.version;
    writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");
    console.log(`  Synced plugin.json version to ${pkg.version}`);
  }

  // ── Report bundle size ───────────────────────────────────
  const bundleStat = statSync(outfile);
  const mapStat = statSync(outfile + ".map");
  const wasmStat = statSync(resolve(distDir, "sql-wasm.wasm"));
  const loaderStat = statSync(resolve(distDir, "sql-wasm.js"));

  const fmt = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  console.log("\nBundle sizes:");
  console.log(`  dist/bundle.js      ${fmt(bundleStat.size)}`);
  console.log(`  dist/bundle.js.map  ${fmt(mapStat.size)}`);
  console.log(`  dist/sql-wasm.js    ${fmt(loaderStat.size)}`);
  console.log(`  dist/sql-wasm.wasm  ${fmt(wasmStat.size)}`);
  console.log(
    `  Total               ${fmt(bundleStat.size + wasmStat.size + loaderStat.size)}`,
  );

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Bundle script failed:", err);
  process.exit(1);
});
