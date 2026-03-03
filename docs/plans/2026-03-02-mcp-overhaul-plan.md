# MCP Server v4.0 전면 개편 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Overhaul agestra from a 68-tool monolith (v3.2.0) into a modular monorepo (~18 tools) with pluggable AI providers, multi-agent orchestration, and GraphRAG memory.

**Architecture:** Monorepo with 8 packages (`core`, `provider-ollama`, `provider-gemini`, `provider-codex`, `agents`, `workspace`, `memory`, `mcp-server`). Config-driven provider registry, no fallback logic. Hybrid communication (file + message queue) for agent sessions. Memory system ported from AI_Chat_Arena.

**Tech Stack:** TypeScript, Turborepo, Vitest, `@modelcontextprotocol/sdk`, `better-sqlite3`, `sqlite-vec`, Zod

**Review Incorporated:** Gemini CLI 리뷰 + Codex CLI 리뷰 (2026-03-02) — 안정성 게이트, 재시도 정책, CliRunner 견고화, executionPolicy, 메시지 큐 내구성, 메모리 무결성 검증 등 12개 항목 반영

---

## Phase 0: Scope Freeze & Contract Definition

> 구현 시작 전에 범위를 동결하고 핵심 계약을 확정한다. 재작성 중 범위가 흔들리면 끝이 없다.

### Task 0.1: v3→v4 기능 매핑표 작성

**Files:**
- Create: `docs/plans/v3-v4-feature-mapping.md`

**Step 1: v3 전체 도구 68개의 기능을 열거하고, v4에서 어떻게 처리되는지 매핑**

각 도구에 대해:
- `삭제` (Claude Code 중복)
- `통합` (어떤 v4 도구로)
- `포팅` (어떤 패키지로)
- `유지` (그대로)

**Step 2: 누락된 기능이 없는지 확인**

v3에서 제공하던 기능 중 v4에서 의도치 않게 빠진 것이 없어야 한다.

**Step 3: Commit**

```bash
git add docs/plans/v3-v4-feature-mapping.md
git commit -m "docs: create v3→v4 feature mapping table"
```

---

### Task 0.2: AIProvider 인터페이스 및 MCP Tool I/O 스키마 Freeze

**Step 1: 설계문서의 AIProvider 인터페이스를 최종 확정**

다음 필드를 확정 (변경 시 별도 승인 필요):
- `AIProvider` 메서드 시그니처
- `ChatRequest` / `ChatResponse` 필드
- `ProviderCapability` 필드
- 표준 에러 코드 5종
- MCP 18개 도구의 입출력 스키마

**Step 2: 설계문서에 "FROZEN" 마크 추가**

**Step 3: Commit**

```bash
git commit -m "docs: freeze AIProvider interface and tool I/O schemas"
```

**Stability Gate 0:**
- PASS: 매핑표 100% 작성, 누락 기능 0개, 인터페이스 frozen
- FAIL: 매핑표에 "미정" 항목 존재, 인터페이스 변경 요청 발생

---

## Phase 1: Monorepo Scaffolding

### Task 1.1: Initialize Turborepo monorepo structure

**Files:**
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Modify: `package.json` (root)

**Step 1: Create turbo.json**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": []
    },
    "lint": {
      "outputs": []
    },
    "clean": {
      "cache": false
    }
  }
}
```

**Step 2: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

**Step 3: Update root package.json for workspaces**

Add `"workspaces": ["packages/*"]` to root package.json. Update scripts to use turbo. Keep existing `"type": "module"`.

**Step 4: Install turborepo**

Run: `npm install -D turbo`

**Step 5: Commit**

```bash
git add turbo.json tsconfig.base.json package.json package-lock.json
git commit -m "chore: initialize Turborepo monorepo structure"
```

---

### Task 1.2: Create core package skeleton

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts` (barrel export)

**Step 1: Create packages/core/package.json**

```json
{
  "name": "@agestra/core",
  "version": "4.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^2.1.9"
  }
}
```

**Step 2: Create packages/core/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Create packages/core/src/index.ts (empty barrel)**

```typescript
// @agestra/core — barrel export
export {};
```

**Step 4: Verify build**

Run: `cd packages/core && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add packages/core/
git commit -m "chore: scaffold @agestra/core package"
```

---

### Task 1.3: Create remaining package skeletons

Repeat the same skeleton pattern for all other packages. Each gets `package.json`, `tsconfig.json`, `src/index.ts`.

**Files:**
- Create: `packages/provider-ollama/{package.json,tsconfig.json,src/index.ts}`
- Create: `packages/provider-gemini/{package.json,tsconfig.json,src/index.ts}`
- Create: `packages/provider-codex/{package.json,tsconfig.json,src/index.ts}`
- Create: `packages/agents/{package.json,tsconfig.json,src/index.ts}`
- Create: `packages/workspace/{package.json,tsconfig.json,src/index.ts}`
- Create: `packages/memory/{package.json,tsconfig.json,src/index.ts}`
- Create: `packages/mcp-server/{package.json,tsconfig.json,src/index.ts}`

**Step 1: Create all 7 package skeletons**

Each package.json should reference `@agestra/core` as a dependency where appropriate (per design doc dependency graph):
- `provider-ollama`, `provider-gemini`, `provider-codex` → depend on `core`
- `agents` → depends on `core`, `workspace`
- `workspace` → no internal deps
- `memory` → depends on `core`
- `mcp-server` → depends on all packages

**Step 2: Run `npm install` from root**

Run: `npm install`
Expected: workspaces linked, no errors

**Step 3: Run turbo build**

Run: `npx turbo build`
Expected: All 8 packages build with empty barrel exports

**Step 4: Commit**

```bash
git add packages/
git commit -m "chore: scaffold all monorepo packages"
```

**Stability Gate 1:**
- PASS: `npx turbo build` green, 순환 의존 없음, 8개 패키지 모두 빌드 성공
- FAIL: 빌드 실패, 패키지 간 순환 의존 발생, core에 provider 종속 유입

---

## Phase 2: Core Package — Interfaces & Utilities

### Task 2.1: Define AIProvider interface and types

**Files:**
- Create: `packages/core/src/types.ts`
- Test: `packages/core/src/__tests__/types.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect } from "vitest";
import type {
  ChatRequest,
  ChatResponse,
  AIProvider,
  ProviderCapability,
  HealthStatus,
} from "../types.js";

describe("Core types", () => {
  it("ChatRequest should accept minimal fields", () => {
    const req: ChatRequest = { prompt: "hello" };
    expect(req.prompt).toBe("hello");
    expect(req.system).toBeUndefined();
  });

  it("ChatResponse should have required fields", () => {
    const res: ChatResponse = {
      text: "world",
      model: "test-model",
      provider: "test-provider",
    };
    expect(res.text).toBe("world");
  });

  it("HealthStatus should accept valid statuses", () => {
    const ok: HealthStatus = { status: "ok" };
    const err: HealthStatus = { status: "error", message: "down" };
    expect(ok.status).toBe("ok");
    expect(err.message).toBe("down");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/types.test.ts`
Expected: FAIL — `types.js` does not exist

**Step 3: Implement types.ts**

```typescript
export interface FileReference {
  path: string;
  content?: string;
}

export interface ChatRequest {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  files?: FileReference[];
  extra?: Record<string, unknown>;
}

export interface ChatResponse {
  text: string;
  model: string;
  provider: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  metadata?: Record<string, unknown>;
}

export interface ModelInfo {
  name: string;
  description: string;
  strengths: string[];
}

export interface ProviderCapability {
  maxContext: number;
  supportsSystemPrompt: boolean;
  supportsFiles: boolean;
  supportsStreaming: boolean;
  supportsJsonOutput: boolean;   // Gemini -o json, Codex --json
  supportsToolUse: boolean;      // Ollama tool calling
  strengths: string[];
  models: ModelInfo[];
}

export interface HealthStatus {
  status: "ok" | "degraded" | "error";
  message?: string;
  details?: Record<string, unknown>;
}

export interface AIProvider {
  readonly id: string;
  readonly type: string;
  initialize(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  getCapabilities(): ProviderCapability;
  isAvailable(): boolean;
  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat?(request: ChatRequest): AsyncIterable<ChatResponse>;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/__tests__/types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/__tests__/types.test.ts
git commit -m "feat(core): define AIProvider interface and core types"
```

---

### Task 2.2: Implement standard error types

**Files:**
- Create: `packages/core/src/errors.ts`
- Test: `packages/core/src/__tests__/errors.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect } from "vitest";
import {
  ProviderNotFoundError,
  ProviderUnavailableError,
  ProviderAuthError,
  ProviderTimeoutError,
  ProviderExecutionError,
  isProviderError,
} from "../errors.js";

describe("Provider errors", () => {
  it("ProviderNotFoundError should include provider id", () => {
    const err = new ProviderNotFoundError("ollama");
    expect(err.message).toContain("ollama");
    expect(err.providerId).toBe("ollama");
    expect(err instanceof Error).toBe(true);
  });

  it("ProviderTimeoutError should include timeout value", () => {
    const err = new ProviderTimeoutError("gemini", 30000);
    expect(err.timeoutMs).toBe(30000);
  });

  it("isProviderError should type-guard correctly", () => {
    const err = new ProviderExecutionError("codex", "cli failed");
    expect(isProviderError(err)).toBe(true);
    expect(isProviderError(new Error("generic"))).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/errors.test.ts`
Expected: FAIL

**Step 3: Implement errors.ts**

```typescript
export abstract class ProviderError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;  // 재시도 가능 여부
  constructor(public readonly providerId: string, message: string) {
    super(`[${providerId}] ${message}`);
    this.name = this.constructor.name;
  }
}

export class ProviderNotFoundError extends ProviderError {
  readonly code = "PROVIDER_NOT_FOUND";
  readonly retryable = false;  // 설정 오류 — 즉시 실패
  constructor(providerId: string) {
    super(providerId, `Provider not found: ${providerId}`);
  }
}

export class ProviderUnavailableError extends ProviderError {
  readonly code = "PROVIDER_UNAVAILABLE";
  readonly retryable = false;  // 설치 안 됨 — 즉시 실패
  constructor(providerId: string, reason?: string) {
    super(providerId, `Provider unavailable: ${reason || "not installed or not running"}`);
  }
}

export class ProviderAuthError extends ProviderError {
  readonly code = "PROVIDER_AUTH_ERROR";
  readonly retryable = false;  // 인증 오류 — 즉시 실패
  constructor(providerId: string, reason?: string) {
    super(providerId, `Authentication failed: ${reason || "missing or invalid credentials"}`);
  }
}

export class ProviderTimeoutError extends ProviderError {
  readonly code = "PROVIDER_TIMEOUT";
  readonly retryable = true;   // 일시적 — 1회 재시도 (지수 백오프)
  constructor(providerId: string, public readonly timeoutMs: number) {
    super(providerId, `Timeout after ${timeoutMs}ms`);
  }
}

export class ProviderExecutionError extends ProviderError {
  readonly code = "PROVIDER_EXECUTION_ERROR";
  readonly retryable = true;   // 일시적 실행 오류 — 1회 재시도
  constructor(providerId: string, reason: string) {
    super(providerId, `Execution error: ${reason}`);
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

/** 재시도 유틸리티 — retryable 에러에 대해 1회 재시도 (지수 백오프) */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 1,
  baseDelayMs = 1000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && isProviderError(err) && err.retryable) {
        await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/__tests__/errors.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/errors.ts packages/core/src/__tests__/errors.test.ts
git commit -m "feat(core): implement standard provider error types"
```

---

### Task 2.3: Implement CliRunner (shared CLI process executor)

**Files:**
- Create: `packages/core/src/cli-runner.ts`
- Test: `packages/core/src/__tests__/cli-runner.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect } from "vitest";
import { runCli } from "../cli-runner.js";

describe("CliRunner", () => {
  it("should run a simple command and capture stdout", async () => {
    const result = await runCli({ command: "echo", args: ["hello"] });
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("should capture stderr", async () => {
    const result = await runCli({
      command: "node",
      args: ["-e", "console.error('oops')"],
    });
    expect(result.stderr.trim()).toBe("oops");
    expect(result.exitCode).toBe(0);
  });

  it("should reject on timeout", async () => {
    await expect(
      runCli({ command: "sleep", args: ["10"], timeout: 100 })
    ).rejects.toThrow(/timeout/i);
  });

  it("should report non-zero exit code", async () => {
    const result = await runCli({
      command: "node",
      args: ["-e", "process.exit(42)"],
    });
    expect(result.exitCode).toBe(42);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/cli-runner.test.ts`
Expected: FAIL

**Step 3: Implement cli-runner.ts**

Port and generalize from existing `gemini.ts` spawn logic + `config.ts` execFilePromise:

```typescript
import { spawn } from "child_process";

export interface CliRunOptions {
  command: string;
  args: string[];
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT = 120_000;

export function runCli(options: CliRunOptions): Promise<CliRunResult> {
  const { command, args, timeout = DEFAULT_TIMEOUT, cwd, env, stdin } = options;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    if (stdin && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    // SIGTERM → wait 3s → SIGKILL 에스컬레이션 (Gemini/Codex 리뷰 반영)
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }, 3000);
      reject(new Error(`CLI timeout after ${timeout}ms: ${command} ${args.join(" ")}`));
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`CLI spawn error: ${err.message}`));
    });
  });
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/__tests__/cli-runner.test.ts`
Expected: PASS (note: `sleep` test may need `node -e "setTimeout(()=>{},10000)"` on Windows)

**Step 5: Commit**

```bash
git add packages/core/src/cli-runner.ts packages/core/src/__tests__/cli-runner.test.ts
git commit -m "feat(core): implement shared CLI process executor"
```

---

### Task 2.4: Implement ProviderRegistry

**Files:**
- Create: `packages/core/src/registry.ts`
- Test: `packages/core/src/__tests__/registry.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { ProviderRegistry } from "../registry.js";
import type { AIProvider, ProviderCapability, HealthStatus, ChatRequest, ChatResponse } from "../types.js";

function createMockProvider(id: string, available = true, strengths: string[] = []): AIProvider {
  return {
    id,
    type: "mock",
    initialize: async () => {},
    healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
    getCapabilities: (): ProviderCapability => ({
      maxContext: 4096,
      supportsSystemPrompt: true,
      supportsFiles: false,
      supportsStreaming: false,
      strengths,
      models: [],
    }),
    isAvailable: () => available,
    chat: async (req: ChatRequest): Promise<ChatResponse> => ({
      text: "mock",
      model: "mock",
      provider: id,
    }),
  };
}

describe("ProviderRegistry", () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it("should register and retrieve a provider", () => {
    const p = createMockProvider("test");
    registry.register(p);
    expect(registry.get("test")).toBe(p);
  });

  it("should throw on unknown provider", () => {
    expect(() => registry.get("nope")).toThrow(/not found/i);
  });

  it("should list all providers", () => {
    registry.register(createMockProvider("a"));
    registry.register(createMockProvider("b"));
    expect(registry.getAll()).toHaveLength(2);
  });

  it("should filter available providers", () => {
    registry.register(createMockProvider("up", true));
    registry.register(createMockProvider("down", false));
    expect(registry.getAvailable()).toHaveLength(1);
    expect(registry.getAvailable()[0].id).toBe("up");
  });

  it("should find providers by capability", () => {
    registry.register(createMockProvider("coder", true, ["code_review"]));
    registry.register(createMockProvider("translator", true, ["translation"]));
    const coders = registry.getByCapability("code_review");
    expect(coders).toHaveLength(1);
    expect(coders[0].id).toBe("coder");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/registry.test.ts`
Expected: FAIL

**Step 3: Implement registry.ts**

```typescript
import type { AIProvider } from "./types.js";
import { ProviderNotFoundError } from "./errors.js";

export class ProviderRegistry {
  private providers = new Map<string, AIProvider>();

  register(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): AIProvider {
    const p = this.providers.get(id);
    if (!p) throw new ProviderNotFoundError(id);
    return p;
  }

  getAll(): AIProvider[] {
    return [...this.providers.values()];
  }

  getAvailable(): AIProvider[] {
    return this.getAll().filter(p => p.isAvailable());
  }

  getByCapability(strength: string): AIProvider[] {
    return this.getAvailable().filter(p =>
      p.getCapabilities().strengths.includes(strength)
    );
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/__tests__/registry.test.ts`
Expected: PASS

**Step 5: Update barrel export**

Update `packages/core/src/index.ts`:
```typescript
export * from "./types.js";
export * from "./errors.js";
export * from "./cli-runner.js";
export * from "./registry.js";
```

**Step 6: Commit**

```bash
git add packages/core/
git commit -m "feat(core): implement ProviderRegistry with capability-based lookup"
```

---

### Task 2.5: Implement config loader

**Files:**
- Create: `packages/core/src/config-loader.ts`
- Create: `providers.config.json` (root)
- Test: `packages/core/src/__tests__/config-loader.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect } from "vitest";
import { parseProviderConfig, type ProviderConfig } from "../config-loader.js";

describe("Config loader", () => {
  it("should parse valid config JSON", () => {
    const raw = {
      defaultProvider: "ollama",
      providers: [
        { id: "ollama", type: "ollama", enabled: true, config: { host: "http://localhost:11434" } },
      ],
    };
    const result = parseProviderConfig(raw);
    expect(result.defaultProvider).toBe("ollama");
    expect(result.providers).toHaveLength(1);
  });

  it("should reject config with no providers", () => {
    expect(() => parseProviderConfig({ providers: [] })).toThrow();
  });

  it("should filter disabled providers", () => {
    const raw = {
      providers: [
        { id: "a", type: "t", enabled: true, config: {} },
        { id: "b", type: "t", enabled: false, config: {} },
      ],
    };
    const result = parseProviderConfig(raw);
    expect(result.enabledProviders).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/config-loader.test.ts`
Expected: FAIL

**Step 3: Implement config-loader.ts**

```typescript
import { z } from "zod";

// 실행 권한 정책 (Codex 리뷰 반영) — 기본값 최소 권한
const ExecutionPolicy = z.enum(["read-only", "workspace-write", "full-auto"]).default("read-only");

const ProviderConfigSchema = z.object({
  id: z.string(),
  type: z.string(),
  enabled: z.boolean().default(true),
  executionPolicy: ExecutionPolicy,  // provider별 실행 권한
  config: z.record(z.unknown()).default({}),
});

// 선택 정책 (Codex 리뷰 반영) — provider 미지정 시 동작 명확화
const SelectionPolicy = z.enum(["default-only", "auto"]).default("default-only");

const RootConfigSchema = z.object({
  defaultProvider: z.string().optional(),
  selectionPolicy: SelectionPolicy,  // provider 미지정 시: default-only or auto
  providers: z.array(ProviderConfigSchema).min(1, "At least one provider required"),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export interface ParsedConfig {
  defaultProvider?: string;
  providers: ProviderConfig[];
  enabledProviders: ProviderConfig[];
}

export function parseProviderConfig(raw: unknown): ParsedConfig {
  const parsed = RootConfigSchema.parse(raw);
  return {
    defaultProvider: parsed.defaultProvider,
    providers: parsed.providers,
    enabledProviders: parsed.providers.filter(p => p.enabled),
  };
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/__tests__/config-loader.test.ts`
Expected: PASS

**Step 5: Create providers.config.json at project root**

```json
{
  "defaultProvider": "ollama",
  "selectionPolicy": "default-only",
  "providers": [
    {
      "id": "ollama",
      "type": "ollama",
      "enabled": true,
      "executionPolicy": "workspace-write",
      "config": {
        "host": "http://localhost:11434",
        "defaultModel": "auto"
      }
    },
    {
      "id": "gemini",
      "type": "gemini-cli",
      "enabled": true,
      "executionPolicy": "read-only",
      "config": {
        "timeout": 120000
      }
    },
    {
      "id": "codex",
      "type": "codex-cli",
      "enabled": true,
      "executionPolicy": "read-only",
      "config": {
        "timeout": 120000
      }
    }
  ]
}
```

> **selectionPolicy**: `"default-only"` = provider 미지정 시 defaultProvider만 사용. `"auto"` = 능력 기반 자동 선택.
> **executionPolicy**: `"read-only"` = 읽기 전용 (기본값, 최소권한). `"workspace-write"` = .ai_workspace/ 쓰기 허용. `"full-auto"` = 전체 파일시스템 (Codex --full-auto용, 주의 필요).

**Step 6: Commit**

```bash
git add packages/core/src/config-loader.ts packages/core/src/__tests__/config-loader.test.ts providers.config.json
git commit -m "feat(core): add config loader and providers.config.json"
```

---

### Task 2.6: Implement structured logging utility

**Files:**
- Create: `packages/core/src/logger.ts`
- Test: `packages/core/src/__tests__/logger.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect } from "vitest";
import { createLogger } from "../logger.js";

describe("Structured logger", () => {
  it("should include standard fields in log entries", () => {
    const logs: any[] = [];
    const logger = createLogger({ output: (entry) => logs.push(entry) });
    logger.info({ providerId: "ollama", toolName: "ai_chat", latencyMs: 150 }, "call completed");
    expect(logs[0]).toMatchObject({
      level: "info",
      providerId: "ollama",
      toolName: "ai_chat",
      latencyMs: 150,
    });
  });

  it("should include errorCode on error entries", () => {
    const logs: any[] = [];
    const logger = createLogger({ output: (entry) => logs.push(entry) });
    logger.error({ errorCode: "PROVIDER_TIMEOUT", providerId: "gemini" }, "timeout");
    expect(logs[0].errorCode).toBe("PROVIDER_TIMEOUT");
  });
});
```

**Step 2: Implement logger.ts**

공통 로그 키: `providerId`, `toolName`, `latencyMs`, `errorCode`. Pino 기반 또는 minimal structured logger.

**Step 3: Run tests, commit**

```bash
git add packages/core/src/logger.ts packages/core/src/__tests__/logger.test.ts
git commit -m "feat(core): implement structured logging with standard fields"
```

**Stability Gate 2:**
- PASS: `@agestra/core` 전체 테스트 통과, `AIProvider` 인터페이스 frozen과 일치, retry 동작 검증, CliRunner SIGTERM→SIGKILL 검증
- FAIL: 인터페이스 불일치, retry 동작 미검증, CliRunner 프로세스 미정리

---

## Phase 3: Provider Implementations

### Task 3.1: Implement Ollama Provider

**Files:**
- Create: `packages/provider-ollama/src/provider.ts`
- Create: `packages/provider-ollama/src/model-detector.ts`
- Test: `packages/provider-ollama/src/__tests__/provider.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OllamaProvider } from "../provider.js";

// Mock global fetch for Ollama HTTP API tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("OllamaProvider", () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OllamaProvider({
      id: "ollama",
      host: "http://localhost:11434",
    });
  });

  it("should report id and type correctly", () => {
    expect(provider.id).toBe("ollama");
    expect(provider.type).toBe("ollama");
  });

  it("should be unavailable before initialization", () => {
    expect(provider.isAvailable()).toBe(false);
  });

  it("healthCheck should call /api/tags", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "qwen2.5-coder:7b" }] }),
    });
    const health = await provider.healthCheck();
    expect(health.status).toBe("ok");
  });

  it("healthCheck should return error when server is down", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const health = await provider.healthCheck();
    expect(health.status).toBe("error");
  });

  it("chat should call /api/generate and return ChatResponse", async () => {
    // First make provider available
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "qwen2.5-coder:7b" }] }),
    });
    await provider.initialize();

    // Then test chat
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: "hello world", model: "qwen2.5-coder:7b" }),
    });
    const res = await provider.chat({ prompt: "hi" });
    expect(res.text).toBe("hello world");
    expect(res.provider).toBe("ollama");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/provider-ollama && npx vitest run`
Expected: FAIL

**Step 3: Implement model-detector.ts**

Port VRAM detection + model capabilities from existing `routing.ts` and `profiler.ts`:

```typescript
export interface DetectedModel {
  name: string;
  size: number;
  strengths: string[];
}

export async function detectModels(host: string): Promise<DetectedModel[]> {
  const res = await fetch(`${host}/api/tags`);
  if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);
  const data = await res.json();
  return (data.models || []).map((m: any) => ({
    name: m.name,
    size: m.size || 0,
    strengths: inferStrengths(m.name),
  }));
}

function inferStrengths(modelName: string): string[] {
  const strengths: string[] = ["chat"];
  const lower = modelName.toLowerCase();
  if (lower.includes("coder") || lower.includes("code")) {
    strengths.push("code_review", "code_generation");
  }
  if (lower.includes("instruct")) {
    strengths.push("instruction_following");
  }
  if (lower.includes("embed")) {
    strengths.push("embedding");
  }
  return strengths;
}
```

**Step 4: Implement provider.ts**

Port from existing `helpers/ollama.ts` — `ollamaFetch`, `ollamaChat`, timeout handling, security prompts. Key changes:
- Implements `AIProvider` interface from `@agestra/core`
- No VRAM downgrade logic exposed externally (capsulated)
- No fallback to any other provider

```typescript
import type { AIProvider, ChatRequest, ChatResponse, HealthStatus, ProviderCapability } from "@agestra/core";
import { ProviderUnavailableError, ProviderTimeoutError, ProviderExecutionError } from "@agestra/core";
import { detectModels, type DetectedModel } from "./model-detector.js";

export interface OllamaProviderConfig {
  id: string;
  host: string;
  defaultModel?: string;
  timeouts?: {
    default?: number;
    generate?: number;
    chat?: number;
  };
}

export class OllamaProvider implements AIProvider {
  readonly id: string;
  readonly type = "ollama";
  private host: string;
  private defaultModel: string;
  private available = false;
  private models: DetectedModel[] = [];
  private timeouts: { default: number; generate: number; chat: number };

  constructor(config: OllamaProviderConfig) {
    this.id = config.id;
    this.host = config.host;
    this.defaultModel = config.defaultModel || "auto";
    this.timeouts = {
      default: config.timeouts?.default ?? 30_000,
      generate: config.timeouts?.generate ?? 300_000,
      chat: config.timeouts?.chat ?? 300_000,
    };
  }

  async initialize(): Promise<void> {
    try {
      this.models = await detectModels(this.host);
      this.available = this.models.length > 0;
    } catch {
      this.available = false;
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const res = await fetch(`${this.host}/api/tags`);
      if (!res.ok) return { status: "error", message: `HTTP ${res.status}` };
      const data = await res.json();
      const modelCount = data.models?.length ?? 0;
      return {
        status: modelCount > 0 ? "ok" : "degraded",
        message: `${modelCount} models available`,
        details: { models: data.models?.map((m: any) => m.name) },
      };
    } catch (err) {
      return { status: "error", message: (err as Error).message };
    }
  }

  getCapabilities(): ProviderCapability {
    return {
      maxContext: 32768,
      supportsSystemPrompt: true,
      supportsFiles: false,
      supportsStreaming: true,
      supportsJsonOutput: false,
      supportsToolUse: true,       // Ollama supports tool calling
      strengths: [...new Set(this.models.flatMap(m => m.strengths))],
      models: this.models.map(m => ({
        name: m.name,
        description: `Ollama model (${Math.round(m.size / 1e9)}GB)`,
        strengths: m.strengths,
      })),
    };
  }

  isAvailable(): boolean {
    return this.available;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.available) {
      throw new ProviderUnavailableError(this.id, "Ollama not running or no models installed");
    }

    const model = request.model || this.selectModel(request.prompt);
    const body = {
      model,
      prompt: request.prompt,
      system: request.system || "You are a helpful assistant.",
      stream: false,
      ...(request.extra || {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeouts.generate);

    try {
      const res = await fetch(`${this.host}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new ProviderExecutionError(this.id, `HTTP ${res.status}: ${res.statusText}`);
      }
      const data = await res.json();
      return {
        text: data.response,
        model: data.model || model,
        provider: this.id,
      };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new ProviderTimeoutError(this.id, this.timeouts.generate);
      }
      if (err instanceof ProviderExecutionError) throw err;
      throw new ProviderExecutionError(this.id, (err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  private selectModel(prompt: string): string {
    if (this.defaultModel !== "auto") return this.defaultModel;
    // Simple selection: pick first available model
    return this.models[0]?.name || "llama3";
  }

  getModels(): DetectedModel[] {
    return [...this.models];
  }
}
```

**Step 5: Run test to verify it passes**

Run: `cd packages/provider-ollama && npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/provider-ollama/
git commit -m "feat(provider-ollama): implement OllamaProvider with model detection"
```

---

### Task 3.2: Implement Gemini CLI Provider

**Files:**
- Create: `packages/provider-gemini/src/provider.ts`
- Create: `packages/provider-gemini/src/output-parser.ts`
- Test: `packages/provider-gemini/src/__tests__/provider.test.ts`
- Test: `packages/provider-gemini/src/__tests__/output-parser.test.ts`

**Step 1: Write the output-parser test**

```typescript
import { describe, it, expect } from "vitest";
import { filterGeminiOutput, parseGeminiJsonOutput } from "../output-parser.js";

describe("Gemini output parser", () => {
  it("should extract response from JSON output", () => {
    const output = 'Some log line\n{"response": "hello world"}';
    expect(parseGeminiJsonOutput(output)).toBe("hello world");
  });

  it("should filter noise from text output", () => {
    const output = "Loaded cached credentials\nActual response here\n[debug] info";
    expect(filterGeminiOutput(output)).toBe("Actual response here");
  });

  it("should prefer JSON over text filtering", () => {
    const output = 'noise\n{"response": "from json"}\nmore noise';
    expect(filterGeminiOutput(output)).toBe("from json");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/provider-gemini && npx vitest run`
Expected: FAIL

**Step 3: Implement output-parser.ts**

Port directly from existing `helpers/gemini.ts` — `parseGeminiJsonOutput` and `filterGeminiOutput` functions.

**Step 4: Implement provider.ts**

Port `runGeminiCLI`, `findGeminiCliPath`, `isGeminiCliAvailable` into a class implementing `AIProvider`. Use `runCli` from `@agestra/core` instead of raw `spawn`. **Remove `runGeminiWithFallback` entirely** — no fallback.

**Step 5: Run tests**

Run: `cd packages/provider-gemini && npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/provider-gemini/
git commit -m "feat(provider-gemini): implement GeminiProvider (no fallback)"
```

---

### Task 3.3: Implement Codex CLI Provider

**Files:**
- Create: `packages/provider-codex/src/provider.ts`
- Create: `packages/provider-codex/src/output-parser.ts`
- Test: `packages/provider-codex/src/__tests__/provider.test.ts`

**Step 1: Write the test**

Test structure similar to Gemini: mock `runCli`, verify `CodexProvider` implements `AIProvider`, test `isAvailable()`, `chat()`, `healthCheck()`.

**Step 2: Run test to verify it fails**

**Step 3: Implement provider.ts**

Based on `docs/design-codex-integration.md` — uses `codex` CLI with `--full-auto` flag, `--json` for JSONL output. Implements AIProvider. Uses `runCli` from core.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git add packages/provider-codex/
git commit -m "feat(provider-codex): implement CodexProvider"
```

---

### Task 3.4: Integration test — ProviderRegistry with real config

**Files:**
- Create: `packages/core/src/__tests__/integration.test.ts`

**Step 1: Write the integration test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { ProviderRegistry } from "../registry.js";
import { parseProviderConfig } from "../config-loader.js";
import type { AIProvider, HealthStatus, ProviderCapability, ChatRequest, ChatResponse } from "../types.js";

describe("Registry + Config integration", () => {
  it("should load config and register mock providers", () => {
    const raw = {
      defaultProvider: "ollama",
      providers: [
        { id: "ollama", type: "ollama", enabled: true, config: {} },
        { id: "gemini", type: "gemini-cli", enabled: true, config: {} },
        { id: "codex", type: "codex-cli", enabled: false, config: {} },
      ],
    };
    const config = parseProviderConfig(raw);
    const registry = new ProviderRegistry();

    // Simulate: only register enabled providers
    for (const pc of config.enabledProviders) {
      registry.register(createStubProvider(pc.id, pc.type));
    }

    expect(registry.getAll()).toHaveLength(2);
    expect(registry.has("codex")).toBe(false);
  });
});

function createStubProvider(id: string, type: string): AIProvider {
  return {
    id, type,
    initialize: async () => {},
    healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
    getCapabilities: (): ProviderCapability => ({
      maxContext: 4096, supportsSystemPrompt: true, supportsFiles: false,
      supportsStreaming: false, strengths: [], models: [],
    }),
    isAvailable: () => true,
    chat: async (req: ChatRequest): Promise<ChatResponse> => ({
      text: "stub", model: "stub", provider: id,
    }),
  };
}
```

**Step 2: Run test, verify pass**

**Step 3: Commit**

```bash
git add packages/core/src/__tests__/integration.test.ts
git commit -m "test(core): add registry + config integration test"
```

**Stability Gate 3:**
- PASS: 3개 provider 모두 계약 테스트 통과 (chat, healthCheck, initialize, isAvailable), 설치안됨/인증실패/타임아웃/실행오류 케이스 검증, 출력 파서 결정성 (동일 입력 동일 구조 출력) 검증
- FAIL: 에러 코드 불일치, 파서 비결정성, `ai_chat(provider="ollama/gemini/codex")` 중 하나라도 계약 불일치

---

## Phase 4: Workspace Package

### Task 4.1: Implement document manager

**Files:**
- Create: `packages/workspace/src/documents.ts`
- Test: `packages/workspace/src/__tests__/documents.test.ts`

**Step 1: Write the test**

Test creating a review document in a temp directory, adding comments from providers, reading the document.

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DocumentManager } from "../documents.js";

describe("DocumentManager", () => {
  let dir: string;
  let dm: DocumentManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ws-test-"));
    dm = new DocumentManager(dir);
  });

  afterEach(() => { rmSync(dir, { recursive: true }); });

  it("should create a review document", async () => {
    const doc = await dm.createReview({
      files: ["src/auth.ts"],
      rules: ["No hardcoding", "Error handling required"],
    });
    expect(doc.id).toBeTruthy();
    expect(doc.content).toContain("src/auth.ts");
  });

  it("should add a comment to a document", async () => {
    const doc = await dm.createReview({ files: ["a.ts"], rules: [] });
    await dm.addComment(doc.id, {
      author: "gemini",
      content: "Found issue on line 42",
    });
    const updated = await dm.read(doc.id);
    expect(updated.content).toContain("gemini");
    expect(updated.content).toContain("line 42");
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Implement documents.ts**

Manages `.ai_workspace/reviews/` — creates markdown files, appends sections for each provider's review, supports reading and listing.

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```bash
git add packages/workspace/
git commit -m "feat(workspace): implement document manager for reviews"
```

---

### Task 4.2: Implement task manager

**Files:**
- Create: `packages/workspace/src/tasks.ts`
- Test: `packages/workspace/src/__tests__/tasks.test.ts`

Manages `.ai_workspace/tasks/` — creates task files with provider assignments, status tracking (pending/in_progress/completed). Each task is a markdown file.

Follow same TDD pattern as Task 4.1.

**Commit:**
```bash
git add packages/workspace/
git commit -m "feat(workspace): implement task manager for provider assignments"
```

---

### Task 4.3: Implement durable message queue

> Gemini/Codex 리뷰 반영: 인메모리만으로는 서버 재시작 시 토론 상태 유실. append-only 로그로 내구성 확보. 인터페이스 기반으로 설계하여 추후 Redis 등으로 교체 가능.

**Files:**
- Create: `packages/workspace/src/message-queue.ts`
- Test: `packages/workspace/src/__tests__/message-queue.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DurableMessageQueue } from "../message-queue.js";

describe("DurableMessageQueue", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mq-test-")); });
  afterEach(() => { rmSync(dir, { recursive: true }); });

  it("should enqueue and dequeue messages", () => {
    const mq = new DurableMessageQueue(dir);
    mq.send("session1", { from: "gemini", content: "I think X" });
    mq.send("session1", { from: "codex", content: "I disagree" });
    const messages = mq.receive("session1");
    expect(messages).toHaveLength(2);
    expect(messages[0].from).toBe("gemini");
  });

  it("should persist messages to append-only log", () => {
    const mq = new DurableMessageQueue(dir);
    mq.send("s1", { from: "a", content: "msg" });
    // Verify log file exists
    const logPath = join(dir, "s1.jsonl");
    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent).toContain('"from":"a"');
  });

  it("should recover session after restart", () => {
    // Write messages
    const mq1 = new DurableMessageQueue(dir);
    mq1.send("s1", { from: "a", content: "first" });
    mq1.send("s1", { from: "b", content: "second" });

    // Simulate restart — new instance
    const mq2 = new DurableMessageQueue(dir);
    const recovered = mq2.recover("s1");
    expect(recovered).toHaveLength(2);
    expect(recovered[0].content).toBe("first");
  });
});
```

**Step 2-5: Standard TDD cycle**

구현: `MessageQueue` 인터페이스 + `DurableMessageQueue` (append-only JSONL 파일). 각 세션이 `.ai_workspace/queue/{sessionId}.jsonl` 파일을 가짐. `send()` 시 인메모리 + 파일 append. `recover()` 시 파일에서 재로드.

**Commit:**
```bash
git add packages/workspace/
git commit -m "feat(workspace): implement durable message queue with append-only log"
```

**Stability Gate 4:**
- PASS: 문서 CRUD 동작, 태스크 상태 추적, 메시지 큐 내구성 (재시작 후 복구) 검증
- FAIL: 파일 생성 실패, 세션 상태 유실, 큐 메시지 손실

---

## Phase 5: Agent Session System

### Task 5.1: Implement debate engine

**Files:**
- Create: `packages/agents/src/debate.ts`
- Test: `packages/agents/src/__tests__/debate.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { DebateEngine, type DebateConfig } from "../debate.js";
import type { AIProvider, ChatResponse, ProviderCapability, HealthStatus, ChatRequest } from "@agestra/core";

function mockProvider(id: string, responses: string[]): AIProvider {
  let callIndex = 0;
  return {
    id, type: "mock",
    initialize: async () => {},
    healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
    getCapabilities: (): ProviderCapability => ({
      maxContext: 4096, supportsSystemPrompt: true, supportsFiles: false,
      supportsStreaming: false, strengths: [], models: [],
    }),
    isAvailable: () => true,
    chat: async (req: ChatRequest): Promise<ChatResponse> => ({
      text: responses[callIndex++] || "no more responses",
      model: "mock", provider: id,
    }),
  };
}

describe("DebateEngine", () => {
  it("should run a debate with rounds", async () => {
    const gemini = mockProvider("gemini", [
      "I think we should use React",
      "After considering Codex's points, I still prefer React",
    ]);
    const codex = mockProvider("codex", [
      "Vue is better for this use case",
      "I see your point, let's compromise on React",
    ]);

    const engine = new DebateEngine();
    const result = await engine.run({
      topic: "Which framework for the frontend?",
      providers: [gemini, codex],
      maxRounds: 2,
    });

    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]).toHaveLength(2); // Each round has 2 responses
    expect(result.transcript).toContain("React");
    expect(result.transcript).toContain("Vue");
  });

  it("should generate a consensus document", async () => {
    const a = mockProvider("a", ["opinion A"]);
    const b = mockProvider("b", ["opinion B"]);

    const engine = new DebateEngine();
    const result = await engine.run({
      topic: "test topic",
      providers: [a, b],
      maxRounds: 1,
    });

    expect(result.consensusDocument).toContain("test topic");
    expect(result.consensusDocument).toContain("opinion A");
    expect(result.consensusDocument).toContain("opinion B");
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Implement debate.ts**

The debate engine:
1. Takes a topic and list of providers
2. For each round, sends the topic + previous responses to each provider
3. Collects responses
4. After all rounds, generates a transcript and consensus document
5. Saves to `.ai_workspace/debates/`

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```bash
git add packages/agents/
git commit -m "feat(agents): implement debate engine with consensus generation"
```

---

### Task 5.2: Implement review session

**Files:**
- Create: `packages/agents/src/review.ts`
- Test: `packages/agents/src/__tests__/review.test.ts`

Orchestrates file-based review flow:
1. `startReview(files, rules)` → creates review doc via workspace
2. `requestReview(docId, provider)` → sends file content to provider, writes result to doc
3. Supports multiple providers reviewing sequentially

Follow TDD pattern.

**Commit:**
```bash
git add packages/agents/
git commit -m "feat(agents): implement review session orchestrator"
```

---

### Task 5.3: Implement task delegation

**Files:**
- Create: `packages/agents/src/task-delegation.ts`
- Test: `packages/agents/src/__tests__/task-delegation.test.ts`

Assigns tasks to providers and tracks completion:
1. `assignTask(provider, description, files)` → creates task file via workspace
2. `executeTask(taskId)` → sends to assigned provider, writes result
3. `getTaskStatus(taskId)` → reads task file status

Follow TDD pattern.

**Commit:**
```bash
git add packages/agents/
git commit -m "feat(agents): implement task delegation system"
```

---

### Task 5.4: Implement session manager

**Files:**
- Create: `packages/agents/src/session-manager.ts`
- Test: `packages/agents/src/__tests__/session-manager.test.ts`

Unified entry point for debate, review, and task sessions:
- Session lifecycle (create, run, complete)
- Session listing and status
- Links to workspace for persistence

Follow TDD pattern.

**Commit:**
```bash
git add packages/agents/
git commit -m "feat(agents): implement session manager for agent lifecycle"
```

**Stability Gate 5:**
- PASS: mock provider 간 2라운드 토론 완료 + 합의 문서 생성, 태스크 할당→실행→완료 사이클 동작, 리뷰 세션 다중 provider 순차 실행 동작
- FAIL: 토론 중 에러 시 세션 상태 불일치, 합의 문서 미생성, 태스크 상태 불일치

---

## Phase 6: Memory System (Port from AI_Chat_Arena)

### Task 6.1: Port zero-dependency modules

**Files:**
- Create: `packages/memory/src/pipeline.ts` — from `AI_Chat_Arena/src/main/memory/pipeline.ts`
- Create: `packages/memory/src/scorer.ts` — from `AI_Chat_Arena/src/main/memory/scorer.ts`
- Create: `packages/memory/src/reranker.ts` — from `AI_Chat_Arena/src/main/memory/reranker.ts`
- Create: `packages/memory/src/token-counter.ts` — from `AI_Chat_Arena/src/main/memory/token-counter.ts`
- Create: `packages/memory/src/assembler.ts` — from `AI_Chat_Arena/src/main/memory/assembler.ts`
- Create: `packages/memory/src/event-bus.ts` — from `AI_Chat_Arena/src/main/memory/event-bus.ts`
- Port tests from `AI_Chat_Arena/src/main/memory/__tests__/`
- Create shared types: `packages/memory/src/types.ts` — from `AI_Chat_Arena/src/shared/memory-types.ts`

**Step 1: Copy files and update imports**

These modules have zero external dependencies — only internal type imports. Change:
- `../../shared/memory-types` → `./types.js`
- `participantId` → `providerId` (global rename for AI provider context)

**Step 2: Port corresponding tests from AI_Chat_Arena**

**Step 3: Run tests**

Run: `cd packages/memory && npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/memory/
git commit -m "feat(memory): port zero-dependency modules from AI_Chat_Arena"
```

---

### Task 6.2: Port embedding service (requires Ollama dependency)

**Files:**
- Create: `packages/memory/src/embedding-service.ts`
- Port test from AI_Chat_Arena

**Step 1: Port embedding-service.ts**

Replace Electron IPC calls with `AIProvider.chat()` or direct Ollama HTTP calls. The embedding service needs:
- `generateEmbedding(text: string): Promise<number[]>` — calls Ollama embedding endpoint
- `cosineSimilarity(a: number[], b: number[]): number` — pure math, no deps
- `serialize/deserialize` — pure functions

**Step 2: Create interface for embedding provider injection**

```typescript
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}
```

Inject via constructor instead of coupling to Ollama directly.

**Step 3: Port and run tests**

**Step 4: Commit**

```bash
git add packages/memory/
git commit -m "feat(memory): port embedding service with injectable provider"
```

---

### Task 6.3: Port hybrid search (requires SQLite)

**Files:**
- Create: `packages/memory/src/hybrid-search.ts`
- Create: `packages/memory/src/retrieval-gate.ts`

**Step 1: Add dependencies**

Add `better-sqlite3` and `sqlite-vec` to `packages/memory/package.json`.

**Step 2: Port hybrid-search.ts**

Replace Electron `ipcRenderer.invoke("db-query", ...)` calls with direct `better-sqlite3` calls. The module needs:
- FTS5 search (BM25 scoring)
- Vector search (sqlite-vec cosine)
- Graph BFS expansion
- Combined results via RRF

**Step 3: Port retrieval-gate.ts**

Decision logic for whether to search memory or skip.

**Step 4: Port and run tests**

**Step 5: Commit**

```bash
git add packages/memory/
git commit -m "feat(memory): port hybrid search with FTS5 + vector + graph"
```

---

### Task 6.4: Port retriever and storage pipeline

**Files:**
- Create: `packages/memory/src/retriever.ts`
- Create: `packages/memory/src/storage-stages.ts`
- Create: `packages/memory/src/extraction-strategy.ts`
- Create: `packages/memory/src/extractor.ts`

**Step 1: Port retriever.ts (692 lines)**

Orchestrates: RetrievalGate → HybridSearch → Reranker → ContextAssembler. Replace IPC with direct DB calls.

**Step 2: Port storage-stages.ts (342 lines)**

ParticipantTagger → ReMentionDetector → ConflictChecker → StorageStage. Change `participantId` → `providerId`.

**Step 3: Port extraction modules**

These extract entities and relations from text for the knowledge graph.

**Step 4: Port and run tests**

**Step 5: Commit**

```bash
git add packages/memory/
git commit -m "feat(memory): port retriever and storage pipeline"
```

---

### Task 6.5: Port evolver and reflector

**Files:**
- Create: `packages/memory/src/evolver.ts`
- Create: `packages/memory/src/reflector.ts`
- Create: `packages/memory/src/llm-strategy.ts`

**Step 1: Port evolver.ts (225 lines)**

Memory evolution: merge similar nodes (cosine > 0.85), prune stale low-importance nodes. Pure logic + DB queries.

**Step 2: Port reflector.ts (351 lines)**

LLM-powered insight extraction. Needs `AIProvider` injection for LLM calls (replace Electron IPC).

**Step 3: Port llm-strategy.ts**

LLM call strategies for extraction and reflection.

**Step 4: Port and run tests**

**Step 5: Commit**

```bash
git add packages/memory/
git commit -m "feat(memory): port memory evolution and LLM reflection"
```

---

### Task 6.6: Implement memory facade (replaces instance.ts)

**Files:**
- Create: `packages/memory/src/facade.ts` (NEW — replaces AI_Chat_Arena `instance.ts` + `facade.ts`)
- Test: `packages/memory/src/__tests__/facade.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemoryFacade } from "../facade.js";

describe("MemoryFacade", () => {
  let dir: string;
  let facade: MemoryFacade;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "memory-test-"));
    facade = new MemoryFacade({
      dbPath: join(dir, "knowledge.db"),
      embeddingProvider: {
        embed: async (text: string) => new Array(384).fill(0.1), // mock
      },
    });
    await facade.initialize();
  });

  afterEach(async () => {
    await facade.close();
    rmSync(dir, { recursive: true });
  });

  it("should store and retrieve a knowledge node", async () => {
    await facade.store({
      content: "Authentication uses JWT tokens",
      providerId: "gemini",
      type: "decision",
    });

    const results = await facade.search("JWT authentication");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("JWT");
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Implement facade.ts**

This is the only module that needs significant rewrite (was 285 lines of Electron-coupled code in AI_Chat_Arena `instance.ts`). New version:
- Creates SQLite database with `better-sqlite3`
- Initializes tables (FTS5, sqlite-vec)
- Wires together all pipeline stages
- Exposes `store()`, `search()`, `evolve()`, `reflect()` as top-level API
- No Electron dependencies

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```bash
git add packages/memory/
git commit -m "feat(memory): implement memory facade (Electron-free)"
```

---

### Task 6.7: Implement memory integrity check and index rebuild

> Codex 리뷰 반영: sqlite-vec + FTS5 + graph 결합 환경에서 인덱스 깨짐 시 검색 전체 사망. 무결성 점검 + 인덱스 재생성 절차 필수.

**Files:**
- Create: `packages/memory/src/maintenance.ts`
- Test: `packages/memory/src/__tests__/maintenance.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemoryFacade } from "../facade.js";
import { checkIntegrity, rebuildIndexes } from "../maintenance.js";

describe("Memory maintenance", () => {
  let dir: string;
  let facade: MemoryFacade;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "maint-test-"));
    facade = new MemoryFacade({
      dbPath: join(dir, "knowledge.db"),
      embeddingProvider: { embed: async () => new Array(384).fill(0.1) },
    });
    await facade.initialize();
  });

  afterEach(async () => {
    await facade.close();
    rmSync(dir, { recursive: true });
  });

  it("checkIntegrity should return ok for fresh db", async () => {
    const result = await checkIntegrity(join(dir, "knowledge.db"));
    expect(result.status).toBe("ok");
  });

  it("rebuildIndexes should recreate FTS5 and vector indexes", async () => {
    await facade.store({ content: "test data", providerId: "test", type: "fact" });
    const result = await rebuildIndexes(join(dir, "knowledge.db"));
    expect(result.rebuiltIndexes).toContain("fts5");
    expect(result.rebuiltIndexes).toContain("vector");
  });
});
```

**Step 2-5: Standard TDD cycle**

구현: `PRAGMA integrity_check`, FTS5 `rebuild` 명령, sqlite-vec 인덱스 재생성, 노드 카운트 검증.

**Commit:**
```bash
git add packages/memory/
git commit -m "feat(memory): implement integrity check and index rebuild"
```

**Stability Gate 6:**
- PASS: memory 패키지 독립 테스트 100% 통과, store→search 파이프라인 동작, 무결성 검증 통과, 인덱스 재생성 후 검색 결과 동일
- FAIL: DB 락/손상, FTS5 결과 누락, 벡터 검색 score 이상, 인덱스 재생성 실패

---

## Phase 7: MCP Server Package — Tool Definitions

### Task 7.1: Implement ai-chat tools (3 tools)

**Files:**
- Create: `packages/mcp-server/src/tools/ai-chat.ts`
- Test: `packages/mcp-server/src/__tests__/ai-chat.test.ts`

**Tools:**
1. `ai_chat` — Chat with a specific provider. Params: `provider`, `prompt`, `model?`, `system?`, `files?`
2. `ai_analyze_files` — Analyze files with a provider. Params: `provider`, `file_paths`, `question`, `save_to_file?`
3. `ai_compare` — Send same prompt to multiple providers, return comparison. Params: `providers[]`, `prompt`

**Step 1: Write the test (with mock registry)**

Test `ai_chat` dispatches to correct provider, `ai_compare` calls multiple providers in parallel, `ai_analyze_files` reads files and sends to provider.

**Step 2: Run test to verify it fails**

**Step 3: Implement ai-chat.ts**

Each tool:
1. Validates args with Zod
2. Looks up provider from registry
3. Calls `provider.chat()`
4. Formats response

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```bash
git add packages/mcp-server/
git commit -m "feat(mcp-server): implement ai_chat, ai_analyze_files, ai_compare tools"
```

---

### Task 7.2: Implement agent-session tools (4 tools)

**Files:**
- Create: `packages/mcp-server/src/tools/agent-session.ts`
- Test: `packages/mcp-server/src/__tests__/agent-session.test.ts`

**Tools:**
1. `agent_debate_start` — Start a debate. Params: `topic`, `providers[]`, `max_rounds?`
2. `agent_debate_status` — Check debate status / get result. Params: `session_id`
3. `agent_assign_task` — Assign task to provider. Params: `provider`, `task`, `files?`
4. `agent_task_status` — Check task status. Params: `task_id`

Follow TDD pattern.

**Commit:**
```bash
git add packages/mcp-server/
git commit -m "feat(mcp-server): implement agent session tools (debate, task)"
```

---

### Task 7.3: Implement workspace tools (4 tools)

**Files:**
- Create: `packages/mcp-server/src/tools/workspace.ts`
- Test: `packages/mcp-server/src/__tests__/workspace.test.ts`

**Tools:**
1. `workspace_create_review` — Create review document. Params: `files[]`, `rules[]`
2. `workspace_request_review` — Request AI review. Params: `doc_id`, `provider`
3. `workspace_add_comment` — Add comment. Params: `doc_id`, `author`, `content`
4. `workspace_read` — Read document. Params: `doc_id`

Follow TDD pattern.

**Commit:**
```bash
git add packages/mcp-server/
git commit -m "feat(mcp-server): implement workspace tools (review, comments)"
```

---

### Task 7.4: Implement provider management tools (2 tools)

**Files:**
- Create: `packages/mcp-server/src/tools/provider-manage.ts`
- Test: `packages/mcp-server/src/__tests__/provider-manage.test.ts`

**Tools:**
1. `provider_list` — List available providers + capabilities
2. `provider_health` — Run health checks on all or specific providers

Follow TDD pattern.

**Commit:**
```bash
git add packages/mcp-server/
git commit -m "feat(mcp-server): implement provider management tools"
```

---

### Task 7.5: Implement Ollama-specific tools (2 tools)

**Files:**
- Create: `packages/mcp-server/src/tools/ollama-manage.ts`
- Test: `packages/mcp-server/src/__tests__/ollama-manage.test.ts`

**Tools:**
1. `ollama_models` — List installed models + capabilities (combines old `ollama_list_models` + `ollama_show`)
2. `ollama_pull` — Download a model

Follow TDD pattern.

**Commit:**
```bash
git add packages/mcp-server/
git commit -m "feat(mcp-server): implement Ollama management tools"
```

---

### Task 7.6: Implement memory tools (2 tools)

**Files:**
- Create: `packages/mcp-server/src/tools/memory.ts`
- Test: `packages/mcp-server/src/__tests__/memory.test.ts`

**Tools:**
1. `memory_search` — Hybrid search (vector + BM25 + graph). Params: `query`, `top_k?`
2. `memory_index` — Index files/directories into memory. Params: `paths[]`

Follow TDD pattern.

**Commit:**
```bash
git add packages/mcp-server/
git commit -m "feat(mcp-server): implement memory tools (search, index)"
```

---

### Task 7.7: Implement health/setup tool (1 tool)

**Files:**
- Create: `packages/mcp-server/src/tools/health.ts`
- Test: `packages/mcp-server/src/__tests__/health.test.ts`

**Tools:**
1. `agestra_setup` — Provider detection, config generation, model installation assistance

Follow TDD pattern.

**Commit:**
```bash
git add packages/mcp-server/
git commit -m "feat(mcp-server): implement agestra_setup tool"
```

**Stability Gate 7:**
- PASS: 18개 도구 schema 정의 완료, 각 도구 단위 테스트 통과 (mock provider), 경로 안전 검증 통과, executionPolicy 강제 동작 확인
- FAIL: 도구 간 파라미터 의미 충돌, schema 불일치, executionPolicy 미적용

---

## Phase 8: MCP Server — Wiring & Entry Point

### Task 8.1: Implement server.ts with new dispatch

**Files:**
- Create: `packages/mcp-server/src/server.ts`
- Test: `packages/mcp-server/src/__tests__/server.test.ts`

**Step 1: Write the test**

Test that `ListToolsRequestSchema` returns exactly 18 tools, and `CallToolRequestSchema` dispatches to the correct handler.

**Step 2: Implement server.ts**

Similar structure to existing `src/server.ts` but:
- Uses the new tool modules from Phase 7
- Injects `ProviderRegistry` into all tool handlers
- Keeps response truncation safety net
- Keeps middleware (validateArgs, logToolCall)

**Step 3: Run test**

**Step 4: Commit**

```bash
git add packages/mcp-server/
git commit -m "feat(mcp-server): implement MCP server with 18-tool dispatch"
```

---

### Task 8.2: Implement index.ts entry point

**Files:**
- Create: `packages/mcp-server/src/index.ts`

**Step 1: Implement entry point**

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server } from "./server.js";
import { ProviderRegistry, parseProviderConfig } from "@agestra/core";
import { OllamaProvider } from "@agestra/provider-ollama";
import { GeminiProvider } from "@agestra/provider-gemini";
import { CodexProvider } from "@agestra/provider-codex";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

async function main() {
  // 1. Load config
  const configPath = resolve("providers.config.json");
  const raw = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf-8"))
    : { providers: [{ id: "ollama", type: "ollama", enabled: true, config: { host: "http://localhost:11434" } }] };

  const config = parseProviderConfig(raw);
  const registry = new ProviderRegistry();

  // 2. Register provider factories
  const factories: Record<string, (pc: any) => any> = {
    ollama: (pc) => new OllamaProvider({ id: pc.id, host: pc.config.host || "http://localhost:11434", defaultModel: pc.config.defaultModel }),
    "gemini-cli": (pc) => new GeminiProvider({ id: pc.id, timeout: pc.config.timeout }),
    "codex-cli": (pc) => new CodexProvider({ id: pc.id, timeout: pc.config.timeout }),
  };

  // 3. Initialize enabled providers
  for (const pc of config.enabledProviders) {
    const factory = factories[pc.type];
    if (!factory) {
      console.error(`Unknown provider type: ${pc.type}`);
      continue;
    }
    const provider = factory(pc);
    await provider.initialize();
    if (provider.isAvailable()) {
      registry.register(provider);
      console.error(`[OK] ${pc.id} (${pc.type}) — ${provider.getCapabilities().models.length} models`);
    } else {
      console.error(`[SKIP] ${pc.id} (${pc.type}) — not available`);
    }
  }

  // 4. Inject registry into server
  server.setRegistry(registry);

  // 5. Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`agestra v4.0 ready — ${registry.getAvailable().length} providers`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
```

**Step 2: Verify build**

Run: `npx turbo build`
Expected: All packages build successfully

**Step 3: Commit**

```bash
git add packages/mcp-server/
git commit -m "feat(mcp-server): implement entry point with provider initialization"
```

**Stability Gate 8:**
- PASS: 서버가 에러 없이 시작, `provider_list`가 사용 가능한 provider 목록 반환, `provider_health`가 상태 리포트, config 로드→provider init→registry→tool dispatch 전체 체인 동작
- FAIL: 서버 시작 실패, provider 초기화 에러, 도구 디스패치 미동작

---

## Phase 9: Cleanup — Remove Old Code

### Task 9.1: Remove old tool modules

**Files:**
- Delete: `src/tools/filesystem.ts` (Claude Code duplicate)
- Delete: `src/tools/web.ts` (Claude Code duplicate)
- Delete: `src/tools/database.ts` (Claude Code duplicate)
- Delete: `src/tools/shell.ts` (Claude Code duplicate)
- Delete: `src/tools/diff.ts` (Claude Code duplicate)
- Delete: `src/tools/process.ts` (Claude Code duplicate)
- Delete: `src/tools/github.ts` (Claude Code duplicate)
- Delete: `src/tools/thinking.ts` (Claude Code duplicate)
- Delete: `src/tools/utility.ts` (Claude Code duplicate)
- Delete: `src/tools/knowledge.ts` (moved to memory package)
- Delete: `src/tools/memory.ts` (moved to memory package)
- Delete: `src/tools/analysis.ts` (moved to agent tools)
- Delete: `src/tools/productivity.ts` (moved to agent tools)
- Delete: `src/tools/llm.ts` (moved to ai-chat tools)
- Delete: `src/tools/rag.ts` (moved to memory tools)
- Delete: `src/tools/setup.ts` (moved to health tools)
- Delete: `src/tools/health.ts` (moved to mcp-server)

**Step 1: Delete all old tool files**

Run: `rm src/tools/*.ts`

**Step 2: Delete old helpers that are now in packages**

- Delete: `src/helpers/gemini.ts` → now in `provider-gemini`
- Delete: `src/helpers/ollama.ts` → now in `provider-ollama`
- Delete: `src/helpers/routing.ts` → now in `provider-ollama`
- Delete: `src/helpers/vectorstore.ts` → now in `memory`

**Step 3: Delete old server.ts and middleware**

- Delete: `src/server.ts` → replaced by `packages/mcp-server/src/server.ts`
- Delete: `src/index.ts` → replaced by `packages/mcp-server/src/index.ts`
- Keep: `src/security.ts` → port relevant functions to core or keep as shared utility

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove legacy tool modules (68 → 18 tools)"
```

---

### Task 9.2: Update root package.json

**Files:**
- Modify: `package.json`

**Step 1: Update version, description, main, bin**

```json
{
  "name": "agestra",
  "version": "4.0.0",
  "description": "MCP server with pluggable AI providers, multi-agent orchestration, and GraphRAG memory",
  "main": "packages/mcp-server/dist/index.js",
  "bin": {
    "agestra": "packages/mcp-server/dist/index.js"
  }
}
```

**Step 2: Update scripts**

```json
{
  "scripts": {
    "build": "turbo build",
    "test": "turbo test",
    "dev": "turbo dev",
    "lint": "turbo lint",
    "clean": "turbo clean"
  }
}
```

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore: update root package.json for v4.0 monorepo"
```

---

### Task 9.3: Update .gitignore

**Files:**
- Modify: `.gitignore`

**Step 1: Add monorepo-specific ignores**

Add `packages/*/dist/`, `.turbo/`, `.ai_workspace/memory/`.

**Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: update .gitignore for monorepo structure"
```

**Stability Gate 9:**
- PASS: 레거시 코드 완전 삭제, `npx turbo build` green, `npx turbo test` green, 사용하지 않는 의존성 0
- FAIL: 빌드 실패, 테스트 실패, 레거시 import 잔존

---

## Phase 10: End-to-End Testing

### Task 10.1: Write integration test — full provider lifecycle

> Gemini 리뷰 반영: 단위 테스트만으로는 컴포넌트 간 상호작용 문제를 놓치기 쉬움. 사용자 시나리오 기반 통합 테스트 필수.

**Files:**
- Create: `packages/mcp-server/src/__tests__/e2e.test.ts`

Test the full flow: config load → provider init → registry → ai_chat tool call → response.
Use mock providers (don't require real Ollama/Gemini installed).

**시나리오 기반 테스트 항목:**
1. `ai_chat(provider="ollama")` → mock Ollama 응답 반환
2. `ai_chat()` (provider 미지정) → `selectionPolicy: "default-only"` → defaultProvider 사용
3. `ai_chat(provider="nonexistent")` → `ProviderNotFoundError` 반환
4. `ai_compare(providers=["ollama","gemini"])` → 병렬 호출, 비교 결과 반환
5. provider 초기화 실패 시 → `isAvailable()=false`, 서버는 정상 시작

**Commit:**
```bash
git add packages/mcp-server/src/__tests__/e2e.test.ts
git commit -m "test(mcp-server): add end-to-end integration test"
```

---

### Task 10.2: Write integration test — debate session

Test: agent_debate_start → debate runs → agent_debate_status → consensus document saved.

**시나리오 기반 테스트 항목:**
1. 2개 mock provider 토론 → 2라운드 → 합의 문서 `.ai_workspace/debates/` 에 생성 확인
2. 토론 중 provider 에러 → 세션 상태 `error`로 전환, 부분 결과 보존
3. `agent_assign_task` → `agent_task_status` → completed 확인
4. 서버 재시작 → 메시지 큐 복구 → 기존 세션 데이터 유지

**Commit:**
```bash
git add packages/mcp-server/src/__tests__/
git commit -m "test(mcp-server): add debate session integration test"
```

---

### Task 10.3: Write integration test — memory pipeline

**시나리오 기반 테스트 항목:**
1. `memory_index` → 파일 인덱싱 → `memory_search` → 관련 결과 반환
2. 동일 쿼리 FTS5 vs Vector vs Graph 각각의 기여도 확인
3. DB 손상 시나리오 → `checkIntegrity()` → `rebuildIndexes()` → 검색 정상화

**Commit:**
```bash
git add packages/mcp-server/src/__tests__/
git commit -m "test(mcp-server): add memory pipeline integration test"
```

---

### Task 10.4: Smoke test with real Ollama (manual)

**Step 1: Build**

Run: `npx turbo build`

**Step 2: Start server manually**

Run: `node packages/mcp-server/dist/index.js`
Expected: Provider initialization messages, server ready

**Step 3: Test with Claude Code**

Add to `.claude/settings.json`:
```json
{
  "mcpServers": {
    "agestra": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"]
    }
  }
}
```

Verify: `provider_list` returns available providers.

**Step 4: Commit**

```bash
git commit --allow-empty -m "chore: verified smoke test with real Ollama"
```

---

## Phase 11: Documentation

### Task 11.1: Update README.md

**Files:**
- Modify: `README.md`

Update to reflect v4.0: new tool list (~18), monorepo structure, provider config, agent session examples, memory system description.

**Commit:**
```bash
git add README.md
git commit -m "docs: update README for v4.0 monorepo architecture"
```

---

## Summary

| Phase | Tasks | Description | Stability Gate |
|-------|-------|-------------|----------------|
| 0 | 0.1–0.2 | Scope freeze & contract definition | Gate 0: 범위 동결 확인 |
| 1 | 1.1–1.3 | Monorepo scaffolding | Gate 1: 빌드/린트/순환의존 |
| 2 | 2.1–2.6 | Core package (interfaces, errors, CLI runner, registry, config, logging) | Gate 2: 단위 테스트 100% |
| 3 | 3.1–3.4 | Provider implementations (Ollama, Gemini, Codex) | Gate 3: 계약 테스트 통과 |
| 4 | 4.1–4.3 | Workspace (documents, tasks, durable message queue) | Gate 4: 큐 내구성 검증 |
| 5 | 5.1–5.4 | Agent sessions (debate, review, task delegation, session manager) | Gate 5: 멀티라운드 검증 |
| 6 | 6.1–6.7 | Memory system (AI_Chat_Arena port + integrity check) | Gate 6: 메모리 무결성 |
| 7 | 7.1–7.7 | MCP tool definitions (18 tools) | Gate 7: 스키마+보안 검증 |
| 8 | 8.1–8.2 | Server wiring & entry point | Gate 8: stdio 통신 검증 |
| 9 | 9.1–9.3 | Cleanup old code | Gate 9: 빌드+기존 참조 0 |
| 10 | 10.1–10.4 | End-to-end testing (lifecycle, debate, memory, smoke) | — |
| 11 | 11.1 | Documentation | — |

**Total: 40 tasks, 12 phases (Phase 0–11), 10 Stability Gates (Gate 0–9)**

**Estimated complexity**: High — full monorepo migration with memory system port and stability-gated release process.

**Dependencies**: Tasks within each phase are largely sequential, but phases can overlap:
- Phase 0 must complete before any implementation starts
- Phases 3, 4, 5, 6 can run in parallel after Phase 2 completes
- Phase 7 depends on Phases 3–6
- Phase 8 depends on Phase 7
- Phase 9 depends on Phase 8
- Phases 10–11 depend on Phase 9
- Each phase's Stability Gate must PASS before proceeding to the next phase
