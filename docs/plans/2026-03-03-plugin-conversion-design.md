# Agestra Plugin Conversion Design

**Status:** Approved
**Date:** 2026-03-03

## Goal

Agestra를 Claude Code 플러그인으로 전환하여 `claude plugin add agestra` 한 줄로 설치 가능하게 만든다. 사용자가 git clone, npm install, build, 수동 설정 없이 바로 사용할 수 있어야 한다.

## Decision Summary

| 항목 | 결정 |
|------|------|
| 배포 대상 | 공개 배포 (npm registry) |
| Config 전환 | 플러그인으로 완전 대체 (CLAUDE.md → skill, hooks → plugin hooks) |
| 패키징 | esbuild 단일 번들 + 외부 deps 포함 |
| Native 의존성 | better-sqlite3 → sql.js(WASM) 교체 |
| Hooks | UserPromptSubmit(도구 추천) + Stop(완료 검증) 2개 |
| 플러그인 이름 | agestra |

---

## 1. 파일 구조

```
agestra/
├── plugin.json                     # 플러그인 매니페스트
├── skills/
│   └── provider-guide.md           # CLAUDE.md 내용 → skill
├── hooks/
│   ├── user-prompt-submit.md       # 도구 추천 (prompt-based)
│   └── stop.md                     # 완료 검증 (prompt-based)
├── scripts/
│   └── bundle.mjs                  # esbuild 번들 스크립트
├── dist/
│   └── bundle.js                   # 번들된 MCP 서버 (git에 포함)
├── packages/                       # 기존 모노레포 패키지 (8개)
│   ├── core/
│   ├── provider-ollama/
│   ├── provider-gemini/
│   ├── provider-codex/
│   ├── agents/
│   ├── workspace/
│   ├── memory/                     # better-sqlite3 → sql.js
│   └── mcp-server/
└── ... (기존 파일 유지)
```

## 2. plugin.json

```json
{
  "name": "agestra",
  "version": "4.0.0",
  "description": "Multi-AI provider integration — Ollama, Gemini, Codex와 Claude를 연결하는 멀티 AI 토론·분석·검증 도구",
  "mcpServers": {
    "agestra": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/bundle.js"]
    }
  }
}
```

MCP 서버가 plugin.json의 `mcpServers`로 선언되므로 `.mcp.json` 별도 파일 불필요.
`${CLAUDE_PLUGIN_ROOT}`는 플러그인 설치 경로로 자동 치환.

## 3. Skills

### skills/provider-guide.md

현재 CLAUDE.md 의 전체 내용을 skill로 이관:
- Available Providers (동적 생성 불가 → 초기값 제공, 실제 감지는 런타임)
- Provider Capability Guidelines (Ollama 모델 크기별 분류)
- Auto-Routing Guidelines
- agestra 도구 추천 트리거 테이블
- Error Handling (429 rate limit)
- Memory System 가이드
- Completion Verification 체크리스트

skill의 `description` 필드에 트리거 조건을 명시하여 Claude가 agestra 도구 사용 시 자동 참조.

## 4. Hooks

### hooks/user-prompt-submit.md

**이벤트:** UserPromptSubmit
**역할:** 사용자 메시지 의도 분석 → agestra 도구 추천 주입

현재 `.claude/settings.local.json`의 UserPromptSubmit hook을 prompt-based hook으로 전환:
- 코드 리뷰 → agent_debate_start / workspace_create_review
- 세컨드 오피니언 → ai_compare / agent_debate_start
- 검증 → agent_cross_validate
- 병렬화 → agent_dispatch
- 프로바이더 직접 언급 → ai_chat

사용자에게 선택지를 제시: (1) Claude Code 단독 처리, (2) 멀티AI 분석.

### hooks/stop.md

**이벤트:** Stop
**역할:** 작업 완료 전 검증 체크리스트

1. Spec compliance
2. System integration
3. Accessibility
4. Tests pass with evidence

### 격리

플러그인 hooks는 사용자 hooks와 완전 격리. 같은 이벤트에 둘 다 존재하면 둘 다 실행됨. 충돌 없음.

## 5. 번들링

### esbuild 설정

```javascript
// scripts/bundle.mjs
import { build } from "esbuild";

await build({
  entryPoints: ["packages/mcp-server/src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  outfile: "dist/bundle.js",
  format: "esm",
  sourcemap: true,
  // sql.js WASM 파일은 별도 복사 필요
});
```

- 8개 내부 패키지 + 외부 deps(zod, @modelcontextprotocol/sdk, sql.js) 모두 번들에 포함
- sql.js WASM 바이너리는 dist/ 에 함께 복사
- `dist/bundle.js`는 git에 포함 (배포용)
- 예상 번들 크기: ~2-3MB (WASM 포함)

### 빌드 파이프라인

```
npm run build         → turborepo (개발용, tsc)
npm run bundle        → esbuild (배포용, 단일 JS)
```

개발 시에는 기존 turborepo 워크플로우 유지. 배포 전에만 bundle 실행.

## 6. better-sqlite3 → sql.js 교체

### 변경 대상

`packages/memory/src/` 내 6개 파일:
- facade.ts (DB 생성, 초기화)
- hybrid-search.ts (FTS5 검색)
- retriever.ts (쿼리 실행)
- storage-stages.ts (데이터 저장)
- evolver.ts (스키마 마이그레이션)
- maintenance.ts (DB 유지보수)

### 교체 전략

1. **DB 어댑터 레이어** 추가: `packages/memory/src/db-adapter.ts`
   - `better-sqlite3`와 `sql.js` 공통 인터페이스 정의
   - 현재는 sql.js 구현만 제공
   - 비동기 초기화 (`initSqlJs()`) 처리

2. **API 차이 처리:**
   - `better-sqlite3`: 동기 API, `new Database(path)`
   - `sql.js`: 비동기 초기화, `initSqlJs()` → `new SQL.Database(buffer)`
   - 파일 I/O: sql.js는 자체 파일 I/O 없음 → `fs.readFileSync`/`writeFileSync`로 수동 관리

3. **FTS5 지원:** sql.js 번들에 FTS5 확장 포함 확인 필요

### 테스트

기존 memory 패키지 테스트(46개)가 모두 통과해야 함. API 어댑터가 투명하게 작동하면 테스트 변경 최소화.

## 7. 제거할 코드

| 파일/기능 | 이유 | 조치 |
|---|---|---|
| config-generator.ts — CLAUDE.md 생성/제거 함수 | skill로 대체 | 제거 |
| config-generator.ts — hooks 생성/제거 함수 | plugin.json hooks로 대체 | 제거 |
| health.ts — agestra_setup 핸들러 | plugin install로 대체 | 제거 |
| health.ts — agestra_remove 핸들러 | plugin remove로 대체 | 제거 |
| config-generator.ts — agestra_generate_config 도구 | 위와 동일 | 제거 |
| index.ts — autoDetectIfNeeded의 config 파일 생성 부분 | 불필요 | 간소화 (감지+등록만 유지) |

**MCP 도구 변화:** 31개 → 28개 (setup, remove, generate_config 제거)

## 8. 프로바이더 자동감지 간소화

`autoDetectIfNeeded()`에서:
- ✅ 유지: `detectProviders()` → `registerDetectedProviders()` (런타임 레지스트리 등록)
- ❌ 제거: `updateProvidersConfig()`, `updateClaudeMd()`, `updateHooks()` (파일 생성)

서버 시작 시 프로바이더를 감지해서 메모리에 등록만. 파일 생성은 하지 않음.

## 9. 설치 흐름 (최종)

```
사용자: claude plugin add agestra

Claude Code 내부:
  1. GitHub/npm에서 플러그인 다운로드
  2. plugin.json 파싱
  3. MCP 서버 등록 (dist/bundle.js)
  4. Skills 등록 (provider-guide.md)
  5. Hooks 등록 (user-prompt-submit.md, stop.md)

첫 번째 agestra 도구 사용 시:
  1. MCP 서버 프로세스 시작 (node dist/bundle.js)
  2. autoDetectIfNeeded() → Ollama/Gemini/Codex 감지
  3. 31개 MCP 도구 사용 가능
```

사용자 조작: **0단계.**

## 10. 제거 흐름

```
사용자: claude plugin remove agestra

Claude Code 내부:
  1. MCP 서버 프로세스 종료
  2. 플러그인 디렉토리 삭제
  3. Skills/Hooks 자동 해제
```

사용자 프로젝트에 잔여물 없음. CLAUDE.md 오염 없음.
