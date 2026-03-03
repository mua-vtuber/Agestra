# Plugin Conversion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Agestra를 Claude Code 플러그인으로 전환하여 `claude plugin add agestra`로 zero-install 가능하게 만든다.

**Architecture:** 기존 모노레포 위에 plugin.json + esbuild 번들 레이어 추가. better-sqlite3를 sql.js(WASM)로 교체하여 네이티브 의존성 제거. CLAUDE.md/hooks 자동생성 코드를 제거하고 플러그인 skills/hooks로 대체.

**Tech Stack:** esbuild (번들링), sql.js (WASM SQLite), Claude Code Plugin System

---

## Phase 1: sql.js DB 어댑터

better-sqlite3와 동일한 API를 제공하는 sql.js 래퍼. memory 패키지의 모든 파일이 이 래퍼를 통해 DB에 접근.

### Task 1: sql.js 의존성 추가

**Files:**
- Modify: `packages/memory/package.json`
- Modify: `package.json` (root)

**Step 1: 의존성 교체**

`packages/memory/package.json`에서 `better-sqlite3` 제거, `sql.js` 추가:

```json
{
  "dependencies": {
    "sql.js": "^1.11.0"
  }
}
```

devDependencies의 `@types/better-sqlite3`도 제거.

**Step 2: 설치**

Run: `npm install`
Expected: sql.js 설치 성공, lockfile 업데이트

**Step 3: Commit**

```bash
git add packages/memory/package.json package.json package-lock.json
git commit -m "chore(memory): replace better-sqlite3 with sql.js"
```

---

### Task 2: DB 어댑터 테스트 작성

**Files:**
- Create: `packages/memory/src/__tests__/db-adapter.test.ts`

**Step 1: 테스트 파일 작성**

better-sqlite3 호환 API를 테스트:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { SqliteDatabase } from "../db-adapter.js";

describe("SqliteDatabase (sql.js adapter)", () => {
  let db: SqliteDatabase;

  afterEach(() => { db?.close(); });

  it("should create in-memory database", async () => {
    db = await SqliteDatabase.create(":memory:");
    expect(db).toBeDefined();
  });

  it("should exec DDL statements", async () => {
    db = await SqliteDatabase.create(":memory:");
    db.exec("CREATE TABLE test (id TEXT, val INTEGER)");
    // No error = success
  });

  it("should prepare and run INSERT", async () => {
    db = await SqliteDatabase.create(":memory:");
    db.exec("CREATE TABLE test (id TEXT, val INTEGER)");
    const result = db.prepare("INSERT INTO test VALUES (?, ?)").run("a", 1);
    expect(result.changes).toBe(1);
  });

  it("should prepare and get single row", async () => {
    db = await SqliteDatabase.create(":memory:");
    db.exec("CREATE TABLE test (id TEXT, val INTEGER)");
    db.prepare("INSERT INTO test VALUES (?, ?)").run("a", 1);
    const row = db.prepare("SELECT * FROM test WHERE id = ?").get("a");
    expect(row).toEqual({ id: "a", val: 1 });
  });

  it("should return undefined for missing row", async () => {
    db = await SqliteDatabase.create(":memory:");
    db.exec("CREATE TABLE test (id TEXT)");
    const row = db.prepare("SELECT * FROM test WHERE id = ?").get("missing");
    expect(row).toBeUndefined();
  });

  it("should prepare and get all rows", async () => {
    db = await SqliteDatabase.create(":memory:");
    db.exec("CREATE TABLE test (id TEXT, val INTEGER)");
    db.prepare("INSERT INTO test VALUES (?, ?)").run("a", 1);
    db.prepare("INSERT INTO test VALUES (?, ?)").run("b", 2);
    const rows = db.prepare("SELECT * FROM test ORDER BY id").all();
    expect(rows).toEqual([{ id: "a", val: 1 }, { id: "b", val: 2 }]);
  });

  it("should support all() with parameters", async () => {
    db = await SqliteDatabase.create(":memory:");
    db.exec("CREATE TABLE test (id TEXT, val INTEGER)");
    db.prepare("INSERT INTO test VALUES (?, ?)").run("a", 1);
    db.prepare("INSERT INTO test VALUES (?, ?)").run("b", 2);
    const rows = db.prepare("SELECT * FROM test WHERE val > ?").all(0);
    expect(rows.length).toBe(2);
  });

  it("should support pragma", async () => {
    db = await SqliteDatabase.create(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    // No error = success (WAL may not persist in memory mode)
  });

  it("should support transactions", async () => {
    db = await SqliteDatabase.create(":memory:");
    db.exec("CREATE TABLE test (id TEXT, val INTEGER)");

    const fn = db.transaction(() => {
      db.prepare("INSERT INTO test VALUES (?, ?)").run("a", 1);
      db.prepare("INSERT INTO test VALUES (?, ?)").run("b", 2);
    });
    fn();

    const rows = db.prepare("SELECT * FROM test").all();
    expect(rows.length).toBe(2);
  });

  it("should rollback transaction on error", async () => {
    db = await SqliteDatabase.create(":memory:");
    db.exec("CREATE TABLE test (id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO test VALUES (?)").run("a");

    const fn = db.transaction(() => {
      db.prepare("INSERT INTO test VALUES (?)").run("b");
      throw new Error("rollback");
    });

    expect(() => fn()).toThrow("rollback");
    const rows = db.prepare("SELECT * FROM test").all();
    expect(rows.length).toBe(1); // Only "a", "b" was rolled back
  });

  it("should support FTS5", async () => {
    db = await SqliteDatabase.create(":memory:");
    db.exec("CREATE TABLE docs (id INTEGER PRIMARY KEY, content TEXT)");
    db.exec("CREATE VIRTUAL TABLE docs_fts USING fts5(content, content=docs, content_rowid=id)");
    db.prepare("INSERT INTO docs VALUES (1, 'hello world test')").run();
    db.exec("INSERT INTO docs_fts(rowid, content) VALUES (1, 'hello world test')");
    const rows = db.prepare("SELECT rowid, rank FROM docs_fts WHERE docs_fts MATCH ?").all("hello");
    expect(rows.length).toBe(1);
  });

  it("should support file-based database", async () => {
    const path = "/tmp/test-sqljs-" + Date.now() + ".db";
    db = await SqliteDatabase.create(path);
    db.exec("CREATE TABLE test (id TEXT)");
    db.prepare("INSERT INTO test VALUES (?)").run("persisted");
    db.close();

    // Reopen and verify
    db = await SqliteDatabase.create(path);
    const row = db.prepare("SELECT * FROM test").get();
    expect(row).toEqual({ id: "persisted" });

    // Cleanup
    const { unlinkSync } = await import("fs");
    try { unlinkSync(path); } catch {}
  });
});
```

**Step 2: 테스트 실패 확인**

Run: `npx vitest run packages/memory/src/__tests__/db-adapter.test.ts`
Expected: FAIL — `SqliteDatabase` 모듈 없음

**Step 3: Commit**

```bash
git add packages/memory/src/__tests__/db-adapter.test.ts
git commit -m "test(memory): add db-adapter tests for sql.js wrapper"
```

---

### Task 3: DB 어댑터 구현

**Files:**
- Create: `packages/memory/src/db-adapter.ts`

**Step 1: 어댑터 구현**

better-sqlite3 호환 API를 sql.js 위에 구현:

```typescript
/**
 * SqliteDatabase: better-sqlite3 호환 래퍼 for sql.js (WASM).
 *
 * better-sqlite3의 동기 API(.prepare/.exec/.pragma/.transaction)를
 * sql.js 위에 구현. 파일 기반 DB는 수동 fs read/write로 처리.
 */
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

let sqlJsPromise: Promise<Awaited<ReturnType<typeof initSqlJs>>> | null = null;

function getSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs();
  }
  return sqlJsPromise;
}

/** Prepared statement wrapper matching better-sqlite3 API. */
export class PreparedStatement {
  constructor(private db: SqlJsDatabase, private sql: string) {}

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    this.db.run(this.sql, params.flat() as any[]);
    const changes = this.db.getRowsModified();
    const [lastIdRow] = this.db.exec("SELECT last_insert_rowid()");
    const lastInsertRowid = lastIdRow?.values?.[0]?.[0] as number ?? 0;
    return { changes, lastInsertRowid };
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    const stmt = this.db.prepare(this.sql);
    try {
      stmt.bind(params.flat() as any[]);
      if (stmt.step()) {
        return stmt.getAsObject() as Record<string, unknown>;
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    const stmt = this.db.prepare(this.sql);
    const results: Record<string, unknown>[] = [];
    try {
      stmt.bind(params.flat() as any[]);
      while (stmt.step()) {
        results.push(stmt.getAsObject() as Record<string, unknown>);
      }
      return results;
    } finally {
      stmt.free();
    }
  }
}

/** better-sqlite3 호환 Database 래퍼. */
export class SqliteDatabase {
  private db: SqlJsDatabase;
  private filePath: string | null;

  private constructor(db: SqlJsDatabase, filePath: string | null) {
    this.db = db;
    this.filePath = filePath;
  }

  static async create(pathOrMemory: string): Promise<SqliteDatabase> {
    const SQL = await getSqlJs();
    let db: SqlJsDatabase;
    let filePath: string | null = null;

    if (pathOrMemory === ":memory:") {
      db = new SQL.Database();
    } else {
      filePath = pathOrMemory;
      if (existsSync(pathOrMemory)) {
        const buffer = readFileSync(pathOrMemory);
        db = new SQL.Database(buffer);
      } else {
        mkdirSync(dirname(pathOrMemory), { recursive: true });
        db = new SQL.Database();
      }
    }

    return new SqliteDatabase(db, filePath);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this.db, sql);
  }

  pragma(pragma: string): void {
    this.db.run(`PRAGMA ${pragma}`);
  }

  transaction<T>(fn: () => T): () => T {
    return () => {
      this.db.run("BEGIN");
      try {
        const result = fn();
        this.db.run("COMMIT");
        return result;
      } catch (err) {
        this.db.run("ROLLBACK");
        throw err;
      }
    };
  }

  close(): void {
    if (this.filePath) {
      const data = this.db.export();
      writeFileSync(this.filePath, Buffer.from(data));
    }
    this.db.close();
  }

  /** Save current state to file (for periodic persistence). */
  flush(): void {
    if (this.filePath) {
      const data = this.db.export();
      writeFileSync(this.filePath, Buffer.from(data));
    }
  }
}
```

**Step 2: 테스트 통과 확인**

Run: `npx vitest run packages/memory/src/__tests__/db-adapter.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add packages/memory/src/db-adapter.ts
git commit -m "feat(memory): add sql.js database adapter with better-sqlite3 compatible API"
```

---

### Task 4: facade.ts 마이그레이션

**Files:**
- Modify: `packages/memory/src/facade.ts`

**Step 1: import 교체 및 initialize() 비동기화**

변경 사항:
1. `import Database from 'better-sqlite3'` → `import { SqliteDatabase } from './db-adapter.js'`
2. `Database.Database` 타입 → `SqliteDatabase`
3. `initialize()` → `async initialize()` (SqliteDatabase.create가 async)
4. `new Database(this.dbPath)` → `await SqliteDatabase.create(this.dbPath)`
5. `this.db.pragma(...)` → 그대로 (어댑터가 호환)
6. `getDatabase()` 리턴 타입을 `SqliteDatabase | null`로 변경

**주의:** `initialize()`가 async로 바뀌므로 호출부(`index.ts` 등)도 수정 필요.

**Step 2: 기존 테스트 통과 확인**

Run: `npx vitest run packages/memory/`
Expected: ALL PASS (API 호환이면 테스트 변경 불필요)

**Step 3: Commit**

```bash
git add packages/memory/src/facade.ts
git commit -m "refactor(memory): migrate facade.ts from better-sqlite3 to sql.js adapter"
```

---

### Task 5: 나머지 memory 파일 마이그레이션

**Files:**
- Modify: `packages/memory/src/hybrid-search.ts`
- Modify: `packages/memory/src/retriever.ts`
- Modify: `packages/memory/src/storage-stages.ts`
- Modify: `packages/memory/src/evolver.ts`
- Modify: `packages/memory/src/reflector.ts`
- Modify: `packages/memory/src/maintenance.ts`

**Step 1: 각 파일에서 import 교체**

모든 파일에서:
```typescript
// Before
import type Database from 'better-sqlite3';
// 또는
import Database from 'better-sqlite3';

// After
import type { SqliteDatabase } from './db-adapter.js';
// 또는
import { SqliteDatabase } from './db-adapter.js';
```

타입 참조 `Database.Database` → `SqliteDatabase`로 변경.

`maintenance.ts`는 `new Database(dbPath)` 직접 호출이 있으므로 `await SqliteDatabase.create(dbPath)`로 변경. 해당 함수들(`checkIntegrity`, `rebuildIndexes`)을 async로 변경.

**Step 2: 전체 memory 테스트 통과 확인**

Run: `npx vitest run packages/memory/`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add packages/memory/src/
git commit -m "refactor(memory): complete sql.js migration for all memory modules"
```

---

### Task 6: index.ts의 initialize() 호출부 수정

**Files:**
- Modify: `packages/mcp-server/src/index.ts`

**Step 1: memoryFacade.initialize() → await**

```typescript
// Before
memoryFacade.initialize();

// After
await memoryFacade.initialize();
```

**Step 2: 빌드 확인**

Run: `npx turbo build`
Expected: ALL SUCCESS

**Step 3: 전체 테스트**

Run: `npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add packages/mcp-server/src/index.ts
git commit -m "refactor: await async memoryFacade.initialize()"
```

---

## Phase 2: 플러그인 인프라

### Task 7: plugin.json 생성

**Files:**
- Create: `plugin.json`

**Step 1: 매니페스트 작성**

```json
{
  "name": "agestra",
  "version": "4.0.0",
  "description": "Multi-AI provider integration — connect Ollama, Gemini, and Codex with Claude for debates, analysis, and cross-validation",
  "mcpServers": {
    "agestra": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/bundle.js"]
    }
  }
}
```

**Step 2: Commit**

```bash
git add plugin.json
git commit -m "feat: add Claude Code plugin manifest"
```

---

### Task 8: skill 생성 — provider-guide.md

**Files:**
- Create: `skills/provider-guide.md`

**Step 1: CLAUDE.md 내용을 skill로 전환**

현재 CLAUDE.md의 `[agestra:v4.0.0] BEGIN`~`END` 구간 전체를 skill description 기반으로 재작성.
frontmatter의 `description`에 트리거 조건 명시.

내용:
- Available Providers 가이드
- Ollama 모델 크기별 분류
- Auto-Routing Guidelines
- agestra 도구 추천 트리거 테이블 (code review, second opinion, validation 등)
- Error Handling (429 rate limit)
- Memory System 가이드
- Completion Verification 체크리스트

**Step 2: Commit**

```bash
git add skills/provider-guide.md
git commit -m "feat: add provider-guide skill (replaces CLAUDE.md section)"
```

---

### Task 9: hooks 생성

**Files:**
- Create: `hooks/user-prompt-submit.md`
- Create: `hooks/stop.md`

**Step 1: UserPromptSubmit hook**

현재 `.claude/settings.local.json`의 UserPromptSubmit 로직을 prompt-based hook으로 전환.
핵심: 사용자 메시지 의도 분석 → AGESTRA_SUGGESTION 마커 반환.

**Step 2: Stop hook**

완료 검증 체크리스트를 prompt-based hook으로.

**Step 3: Commit**

```bash
git add hooks/
git commit -m "feat: add plugin hooks (user-prompt-submit, stop)"
```

---

## Phase 3: 번들링

### Task 10: esbuild 번들 스크립트

**Files:**
- Create: `scripts/bundle.mjs`
- Modify: `package.json` (root — bundle 스크립트 추가)

**Step 1: esbuild 의존성 추가**

```bash
npm install --save-dev esbuild
```

**Step 2: 번들 스크립트 작성**

```javascript
// scripts/bundle.mjs
import { build } from "esbuild";
import { cpSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

await build({
  entryPoints: [join(root, "packages/mcp-server/src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  outfile: join(root, "dist/bundle.js"),
  format: "esm",
  sourcemap: true,
  // sql.js WASM은 런타임에 로드하므로 외부로
  external: [],
  loader: { ".wasm": "file" },
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

// Copy sql.js WASM file to dist/
const wasmSource = join(root, "node_modules/sql.js/dist/sql-wasm.wasm");
if (existsSync(wasmSource)) {
  cpSync(wasmSource, join(root, "dist/sql-wasm.wasm"));
}

console.log("Bundle created: dist/bundle.js");
```

**Step 3: package.json에 스크립트 추가**

```json
{
  "scripts": {
    "bundle": "node scripts/bundle.mjs"
  }
}
```

**Step 4: 번들 빌드 테스트**

Run: `npm run build && npm run bundle`
Expected: `dist/bundle.js` 생성

**Step 5: Commit**

```bash
git add scripts/bundle.mjs package.json dist/bundle.js dist/sql-wasm.wasm
git commit -m "feat: add esbuild bundle script for plugin distribution"
```

---

## Phase 4: 코드 정리

### Task 11: config-generator.ts에서 불필요한 코드 제거

**Files:**
- Modify: `packages/mcp-server/src/tools/config-generator.ts`

**Step 1: 제거할 함수들**

- `generateClaudeMdSection()` — skill로 대체
- `updateClaudeMd()` — 불필요
- `removeClaudeMdSection()` — 불필요
- `generateHooksConfig()` — plugin.json hooks로 대체
- `updateHooks()` — 불필요
- `removeHooks()` — 불필요
- `agestra_generate_config` 도구 정의 — 불필요

유지: `updateProvidersConfig()` (프로바이더 감지 결과 저장 — 아직 유용할 수 있음)

**Step 2: 빌드 확인**

Run: `npx turbo build`
Expected: 컴파일 에러가 나면 import 참조 수정

**Step 3: Commit**

```bash
git add packages/mcp-server/src/tools/config-generator.ts
git commit -m "refactor: remove CLAUDE.md/hooks generation code (replaced by plugin system)"
```

---

### Task 12: health.ts에서 setup/remove 도구 제거

**Files:**
- Modify: `packages/mcp-server/src/tools/health.ts`
- Modify: `packages/mcp-server/src/server.ts` (dispatch에서 제거)

**Step 1: agestra_setup, agestra_remove 핸들러와 도구 정의 제거**

health.ts는 `provider_health` 도구만 유지하거나, 파일 자체가 setup/remove 전용이면 삭제.

**Step 2: server.ts 디스패치에서 제거된 도구 참조 정리**

**Step 3: 빌드+테스트 확인**

Run: `npx turbo build && npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add packages/mcp-server/src/tools/health.ts packages/mcp-server/src/server.ts
git commit -m "refactor: remove agestra_setup/remove tools (replaced by plugin install/remove)"
```

---

### Task 13: autoDetectIfNeeded 간소화

**Files:**
- Modify: `packages/mcp-server/src/index.ts`

**Step 1: config 파일 생성 코드 제거**

```typescript
// Before (current)
updateProvidersConfig(baseDir, results, false);
registerDetectedProviders(providers, registry);
const section = generateClaudeMdSection(registry);
updateClaudeMd(baseDir, section, false);
const hooks = generateHooksConfig();
updateHooks(baseDir, hooks, false);

// After (simplified)
registerDetectedProviders(providers, registry);
```

파일 생성 없이 메모리 레지스트리 등록만. import 정리.

**Step 2: 빌드+테스트**

Run: `npx turbo build && npx vitest run`
Expected: ALL PASS (autodetect 테스트 수정 필요할 수 있음)

**Step 3: Commit**

```bash
git add packages/mcp-server/src/index.ts
git commit -m "refactor: simplify autoDetectIfNeeded (registry-only, no file generation)"
```

---

## Phase 5: 테스트 업데이트 & 통합 검증

### Task 14: startup-autodetect 테스트 수정

**Files:**
- Modify: `packages/mcp-server/src/__tests__/startup-autodetect.test.ts`

**Step 1: config 파일 생성 관련 assertion 제거**

autoDetectIfNeeded가 더 이상 updateProvidersConfig, updateClaudeMd, updateHooks를 호출하지 않으므로 해당 mock assertion 제거.

**Step 2: 테스트 통과 확인**

Run: `npx vitest run packages/mcp-server/src/__tests__/startup-autodetect.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add packages/mcp-server/src/__tests__/startup-autodetect.test.ts
git commit -m "test: update autodetect tests for simplified flow"
```

---

### Task 15: 전체 빌드 + 테스트 + 번들 검증

**Files:** None (검증만)

**Step 1: 전체 빌드**

Run: `npx turbo build`
Expected: ALL SUCCESS

**Step 2: 전체 테스트**

Run: `npx vitest run`
Expected: ALL PASS

**Step 3: 번들 생성**

Run: `npm run bundle`
Expected: `dist/bundle.js` 생성

**Step 4: 번들 실행 테스트**

Run: `node dist/bundle.js --help 2>&1 || true`
Expected: MCP 서버가 stdio 대기 상태로 시작 (에러 없이)

**Step 5: 플러그인 파일 존재 확인**

- `plugin.json` 존재
- `skills/provider-guide.md` 존재
- `hooks/user-prompt-submit.md` 존재
- `hooks/stop.md` 존재
- `dist/bundle.js` 존재

**Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete Claude Code plugin conversion

- plugin.json manifest with MCP server declaration
- skills/provider-guide.md (replaces CLAUDE.md section)
- hooks for UserPromptSubmit and Stop events
- esbuild single bundle (no native dependencies)
- better-sqlite3 → sql.js migration
- Removed: agestra_setup, agestra_remove, generate_config tools"
```

---

## 변경 요약

| Phase | 파일 수 | 설명 |
|-------|---------|------|
| 1. sql.js 어댑터 | ~9 | DB 어댑터 + memory 6개 파일 마이그레이션 |
| 2. 플러그인 인프라 | 4 | plugin.json, skill, 2 hooks |
| 3. 번들링 | 2 | esbuild 스크립트 + bundle.js |
| 4. 코드 정리 | ~4 | 불필요 코드 제거 |
| 5. 테스트/검증 | ~2 | 테스트 수정 + 통합 검증 |

**MCP 도구 변화:** 31개 → 28개 (agestra_setup, agestra_remove, agestra_generate_config 제거)
