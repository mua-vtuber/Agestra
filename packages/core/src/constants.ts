/**
 * Project-wide constants.
 *
 * Build script injects values from package.json at bundle time (esbuild define).
 * At development time (running source directly via tsx/ts-node), the placeholder
 * is not replaced, so we detect this and fall back to a dev marker.
 */

/** Project version. Replaced by build script with package.json version. */
declare const __PROJECT_VERSION__: string | undefined;
export const PROJECT_VERSION: string =
  typeof __PROJECT_VERSION__ !== "undefined"
    ? __PROJECT_VERSION__
    : "0.0.0-dev";

/** Default Ollama host URL. */
export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";

/** Default maximum context tokens for Ollama provider. */
export const DEFAULT_OLLAMA_MAX_CONTEXT = 32768;

/** Ollama fallback model name (used in error messages, not for silent fallback). */
export const DEFAULT_OLLAMA_FALLBACK_MODEL = "llama3";
