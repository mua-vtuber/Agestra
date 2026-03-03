# Agestra MCP Server v4.0 - 전면 개편 설계문서

**버전:** 1.1
**날짜:** 2026-03-02
**상태:** Approved — Interfaces FROZEN

---

## 1. 개요

### 1.1 현재 상태 (v3.2.0)

- 68개 도구, 17개 모듈
- Gemini CLI, Ollama가 하드코딩된 프로바이더
- Gemini → Ollama 폴백 로직
- Codex CLI 통합 설계만 존재 (미구현)
- Claude Code와 중복되는 도구 다수 (파일시스템, 셸, diff, GitHub 등)

### 1.2 목표

1. **폴백 로직 완전 제거** — 명시적 프로바이더 선택, 실패 시 즉시 에러
2. **플러거블 프로바이더 시스템** — 어떤 CLI AI든 설정 한 줄로 추가
3. **멀티 에이전트 오케스트레이션** — AI 에이전트 간 자율 토론, 파일 기반 비동기 리뷰, 작업 분배
4. **중복 도구 제거** — 68개 → ~18개로 축소
5. **GraphRAG 기반 메모리** — AI_Chat_Arena의 하이브리드 검색 시스템 포팅
6. **모노레포 구조** — 패키지 분리로 확장성 확보

### 1.3 외부 의견 수렴

Gemini CLI와 Codex CLI에 아키텍처 의견을 직접 질의함. 양측 모두 동일한 방향을 제안:
- Provider 추상화 + Registry 패턴
- Config-driven 프로바이더 등록
- 통합 도구 인터페이스 (프로바이더별 도구 대신 `ai_chat(provider=...)`)
- 폴백 제거, 명시적 프로바이더 선택
- 공통 CLI 실행기 분리
- 표준화된 에러 모델

---

## 2. 아키텍처

### 2.1 모노레포 패키지 구조

```
agestra/
├── packages/
│   ├── core/                          # @agestra/core
│   │   ├── src/
│   │   │   ├── provider.ts            # AIProvider 인터페이스
│   │   │   ├── registry.ts            # ProviderRegistry
│   │   │   ├── cli-runner.ts          # 공통 CLI 프로세스 실행기
│   │   │   ├── errors.ts             # 표준 에러 타입
│   │   │   └── types.ts              # 공유 타입
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── provider-ollama/               # @agestra/provider-ollama
│   │   ├── src/
│   │   │   ├── index.ts              # OllamaProvider (HTTP API)
│   │   │   ├── model-detector.ts     # 설치된 모델 감지 + VRAM 계산
│   │   │   └── capabilities.ts       # 모델별 능력 보고
│   │   └── package.json
│   │
│   ├── provider-gemini/               # @agestra/provider-gemini
│   │   ├── src/
│   │   │   ├── index.ts              # GeminiProvider (CLI spawn)
│   │   │   └── output-parser.ts      # JSON/text 출력 파싱
│   │   └── package.json
│   │
│   ├── provider-codex/                # @agestra/provider-codex
│   │   ├── src/
│   │   │   ├── index.ts              # CodexProvider (CLI spawn)
│   │   │   └── output-parser.ts      # JSONL 파싱
│   │   └── package.json
│   │
│   ├── agents/                        # @agestra/agents
│   │   ├── src/
│   │   │   ├── session-manager.ts    # 세션 생명주기 관리
│   │   │   ├── debate.ts            # 자율 토론 엔진
│   │   │   ├── review.ts            # 리뷰 세션
│   │   │   └── task-delegation.ts   # 작업 분배
│   │   └── package.json
│   │
│   ├── workspace/                     # @agestra/workspace
│   │   ├── src/
│   │   │   ├── documents.ts          # 리뷰 문서/코멘트 관리
│   │   │   ├── tasks.ts             # 태스크 파일 관리
│   │   │   └── message-queue.ts     # 인메모리 메시지 큐
│   │   └── package.json
│   │
│   ├── memory/                        # @agestra/memory
│   │   ├── src/                      # AI_Chat_Arena에서 포팅
│   │   │   ├── facade.ts            # 최상위 코디네이터
│   │   │   ├── pipeline.ts          # 범용 파이프라인 엔진
│   │   │   ├── hybrid-search.ts     # FTS5 + Vector + Graph 검색
│   │   │   ├── retriever.ts         # 하이브리드 리트리버
│   │   │   ├── storage-stages.ts    # 저장 파이프라인
│   │   │   ├── reranker.ts          # RRF 리랭킹
│   │   │   ├── embedding-service.ts # 벡터 연산
│   │   │   ├── scorer.ts            # Stanford 3-factor 스코어링
│   │   │   ├── evolver.ts           # 메모리 진화 (병합/정리)
│   │   │   └── reflector.ts         # LLM 리플렉션
│   │   └── package.json
│   │
│   ├── mcp-server/                    # @agestra/mcp-server (진입점)
│   │   ├── src/
│   │   │   ├── index.ts              # 서버 시작, 프로바이더 로드
│   │   │   ├── server.ts             # MCP 서버 + 디스패치
│   │   │   └── tools/               # MCP 도구 정의 (~18개)
│   │   │       ├── ai-chat.ts
│   │   │       ├── agent-session.ts
│   │   │       ├── workspace.ts
│   │   │       ├── ollama-manage.ts
│   │   │       ├── memory.ts
│   │   │       └── health.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── web-dashboard/                 # @agestra/web-dashboard (2차)
│       └── (예약됨 - 2차 개편에서 구현)
│
├── providers.config.json              # 프로바이더 설정
├── turbo.json                         # Turborepo 설정
├── package.json                       # 루트 (workspaces)
└── tsconfig.base.json                 # 공유 TS 설정
```

### 2.2 패키지 의존성 그래프

```
mcp-server
  ├── core
  ├── agents ── core, workspace
  ├── workspace
  ├── memory ── core
  ├── provider-ollama ── core
  ├── provider-gemini ── core
  └── provider-codex ── core
```

### 2.3 빌드 도구

- **Turborepo**: 모노레포 빌드 오케스트레이션
- **TypeScript Project References**: 패키지 간 타입 안전 보장
- **Vitest**: 테스트 (패키지별 독립 실행 가능)

---

## 3. 핵심 인터페이스 — @agestra/core

> **🔒 FROZEN (2026-03-02)** — 아래 인터페이스는 v4.0 릴리스까지 변경 불가. 변경 시 별도 승인 필요.
> Gemini/Codex 리뷰 반영: `supportsJsonOutput`, `supportsToolUse`, `retryable` 추가.

### 3.1 AIProvider

```typescript
export interface ChatRequest {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  files?: FileReference[];
  extra?: Record<string, unknown>;
}

export interface FileReference {
  path: string;
  content?: string;
}

export interface ChatResponse {
  text: string;
  model: string;
  provider: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  metadata?: Record<string, unknown>;
}

export interface ProviderCapability {
  maxContext: number;
  supportsSystemPrompt: boolean;
  supportsFiles: boolean;
  supportsStreaming: boolean;
  supportsJsonOutput: boolean;   // ADDED: Gemini -o json, Codex --json
  supportsToolUse: boolean;      // ADDED: Ollama tool calling
  strengths: string[];
  models: ModelInfo[];
}

export interface ModelInfo {
  name: string;
  description: string;
  strengths: string[];
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

export interface HealthStatus {
  status: "ok" | "degraded" | "error";
  message?: string;
  details?: Record<string, unknown>;
}
```

### 3.2 ProviderRegistry

```typescript
export interface ProviderConfig {
  id: string;
  type: string;       // "ollama", "gemini-cli", "codex-cli"
  enabled: boolean;
  config: Record<string, unknown>;
}

export class ProviderRegistry {
  registerFactory(type: string, factory: ProviderFactory): void;
  async loadFromConfig(configPath: string): Promise<void>;
  get(id: string): AIProvider;
  getAll(): AIProvider[];
  getAvailable(): AIProvider[];
  getByCapability(strength: string): AIProvider[];
}

export interface ProviderFactory {
  create(config: ProviderConfig): AIProvider;
}
```

### 3.3 CliRunner (공통 CLI 실행기)

```typescript
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

export async function runCli(options: CliRunOptions): Promise<CliRunResult>;
```

### 3.4 표준 에러 타입

```typescript
export class ProviderNotFoundError extends Error {}
export class ProviderUnavailableError extends Error {}
export class ProviderAuthError extends Error {}
export class ProviderTimeoutError extends Error {}
export class ProviderExecutionError extends Error {}
export class UnsupportedCapabilityError extends Error {}
```

---

## 4. 프로바이더 어댑터

### 4.1 Ollama Provider

- **연결 방식**: HTTP API (localhost:11434)
- **초기화**: Ollama 서버 연결 확인 → 설치된 모델 목록 조회 → VRAM 감지 → 모델별 능력 계산
- **능력 보고**: 설치된 모델 목록 + 각 모델의 strengths
- **파일 처리**: 프롬프트에 내용 직접 삽입 (encapsulateFileContent)
- **VRAM 로직**: provider 내부에 캡슐화. 외부에서는 getCapabilities()로 결과만 확인
- **없으면**: isAvailable() = false, 해당 provider 비활성화

### 4.2 Gemini CLI Provider

- **연결 방식**: CLI spawn (`gemini`)
- **초기화**: CLI 설치 확인 (which/where)
- **능력 보고**: 1M 토큰 컨텍스트, 파일 직접 참조(@path), 코드 리뷰에 강함
- **파일 처리**: `@filepath` 네이티브 지원
- **출력 파싱**: `-o json` → JSON 파싱 + text 필터링

### 4.3 Codex CLI Provider

- **연결 방식**: CLI spawn (`codex`)
- **초기화**: CLI 설치 확인, API 키 확인
- **능력 보고**: 에이전트 모드 지원, 코드 수정 가능
- **파일 처리**: `--cd` + 프롬프트에 경로 지시
- **출력 파싱**: 기본 stdout / `--json` JSONL 모드

### 4.4 설정 파일 (providers.config.json)

```json
{
  "defaultProvider": "ollama",
  "providers": [
    {
      "id": "ollama",
      "type": "ollama",
      "enabled": true,
      "config": {
        "host": "http://localhost:11434",
        "defaultModel": "auto"
      }
    },
    {
      "id": "gemini",
      "type": "gemini-cli",
      "enabled": true,
      "config": {
        "timeout": 120000
      }
    },
    {
      "id": "codex",
      "type": "codex-cli",
      "enabled": true,
      "config": {
        "timeout": 120000,
        "model": ""
      }
    }
  ]
}
```

---

## 5. 에이전트 세션 시스템 — @agestra/agents

### 5.1 자율 토론 (Debate)

```
사용자: "이 코드에 대해 Gemini와 Codex가 토론해줘"
  ↓
Claude → MCP: agent_debate_start(topic, providers, max_rounds)
  ↓
┌─────────────────────────────────────────────────┐
│  [Round 1] Gemini → 초기 의견                    │
│  [Round 1] Codex  → 반론/동의 (Gemini 의견 참조) │
│  [Round 2] Gemini → 재반론 (Codex 의견 참조)     │
│  [Round 2] Codex  → 수정된 입장                  │
│  ...                                             │
│  [Final]   합의점 문서 자동 생성                  │
└─────────────────────────────────────────────────┘
  ↓
.ai_workspace/debates/2026-03-02-code-review.md
```

**통신**: 인메모리 메시지 큐로 라운드별 응답 전달
**출력**: 전체 대화 로그 + 합의점 요약 문서

### 5.2 파일 기반 비동기 리뷰

```
1. workspace_create_review(files, rules) → 리뷰 문서 생성
2. workspace_request_review(doc, provider="gemini") → Gemini 코멘트 추가
3. workspace_request_review(doc, provider="codex") → Codex 코멘트 추가
4. 사용자도 직접 .md 파일에 코멘트 추가 가능
```

파일 구조:
```markdown
# Code Review: src/auth.ts

## 리뷰 규칙
1. 하드코딩 금지
2. 에러 핸들링 필수

## Gemini 리뷰 (2026-03-02 14:30)
- [FAIL] Rule 1: line 42에 하드코딩된 URL 발견
- [PASS] Rule 2: try/catch 적절히 사용

## Codex 리뷰 (2026-03-02 14:35)
- Gemini 의견에 동의. 추가로 line 78의 타입 안전성 문제 발견

## 사용자 코멘트 (2026-03-02 15:00)
- line 42는 환경변수로 옮길 것. 나머지 반영 부탁.
```

### 5.3 작업 분배

```
agent_assign_task(provider="ollama", task="번역", files=[...])
agent_assign_task(provider="gemini", task="아키텍처 리뷰", files=[...])
```

태스크 파일:
```
.ai_workspace/tasks/
├── task-001-translate.md    (assigned: ollama, status: completed)
└── task-002-arch-review.md  (assigned: gemini, status: in_progress)
```

### 5.4 Claude의 역할

| 상황 | Claude 역할 |
|------|------------|
| 리뷰/토론 | 대등한 피어 — 다른 AI 의견을 받고 자기 의견도 제시 |
| 작업 분배 | 리더 — 어떤 AI에게 뭘 시킬지 결정 |
| 리뷰 요청 시 | 옵션 제시 — "Gemini에게 리뷰 시킬까요? Codex도?" 같은 선택지 |

---

## 6. 워크스페이스 시스템 — @agestra/workspace

### 6.1 디렉토리 구조

```
.ai_workspace/
├── debates/           # 자율 토론 기록
├── reviews/           # 코드 리뷰 기록
├── tasks/             # 작업 할당/상태
├── memory/            # 메모리 DB (SQLite)
│   ├── knowledge.db   # 지식 노드 + FTS5 + sqlite-vec
│   └── embeddings/    # 벡터 인덱스 캐시
└── config.json        # 워크스페이스 설정
```

### 6.2 하이브리드 통신

- **파일 기반**: 태스크 할당/상태, 리뷰 문서, 토론 기록 → 사용자가 직접 확인 가능
- **메시지 큐**: 라운드별 에이전트 응답 전달 → 실시간 토론에 사용

---

## 7. 메모리 시스템 — @agestra/memory

### 7.1 AI_Chat_Arena에서 포팅

AI_Chat_Arena의 메모리 시스템을 Electron 의존성 제거 후 독립 Node.js 모듈로 추출.

**포팅 대상:**
- `pipeline.ts` — 범용 파이프라인 엔진
- `hybrid-search.ts` — FTS5 + Vector + Graph 하이브리드 검색
- `retriever.ts` — 하이브리드 리트리버
- `storage-stages.ts` — ParticipantTagger, ReMentionDetector, ConflictChecker, StorageStage
- `reranker.ts` — RRF 리랭킹 + mention/confidence 부스트
- `embedding-service.ts` — 벡터 연산 (cosine similarity, serialization)
- `scorer.ts` — Stanford 3-factor 스코어링 (recency × relevance × importance)
- `evolver.ts` — 메모리 진화 (유사 노드 병합, 오래된 노드 정리)
- `reflector.ts` — LLM 기반 인사이트 추출

**수정 사항:**
- Electron IPC 레이어 제거
- `participantId` → `providerId`로 매핑 (어떤 AI가 생성한 정보인지)
- 임베딩 프로바이더를 AIProvider 인터페이스로 연결 (Ollama embeddings)

### 7.2 핵심 아키텍처

```
[새 정보 입력 (토론/리뷰/결정)]
    │
    ▼
[추출 파이프라인]
    │  ExtractionStage (Regex + LLM)
    ▼
[저장 파이프라인]
    │  ParticipantTagger → ReMentionDetector → ConflictChecker → StorageStage
    ▼
[SQLite: knowledge_nodes + FTS5 + knowledge_vec]
    │
    ▼ (검색 시)
[검색 파이프라인]
    │  RetrievalGate → HybridSearch(FTS5 + Vector + Graph BFS) → Reranker(RRF) → ContextAssembler
    ▼
[결과 반환]
```

### 7.3 자동 인덱싱

토론/리뷰 세션이 끝나면 자동으로:
1. 결과 문서를 메모리에 저장
2. 엔티티/관계 추출 → 지식 그래프에 추가
3. 벡터 임베딩 생성 → 검색 인덱스에 추가

나중에 "이전에 인증 관련 결정이 뭐였지?" → 하이브리드 검색으로 관련 토론/리뷰 발견.

### 7.4 설계 원칙 (리서치 기반)

1. **요약하지 않고 원본 보존** — 요약이 에이전트 성능을 저하시킬 수 있음 (JetBrains Research 2025)
2. **그래프 인덱싱** — 연관된 항목을 이어서 순위를 올림 (GraphRAG)
3. **RRF 퓨전** — 벡터 + BM25 + 그래프 근접도를 결합하여 랭킹
4. **전략적 컨텍스트 배치** — 중요 정보를 시작/끝에, lost-in-the-middle 완화
5. **모델별 적응형 전달** — 프로바이더 컨텍스트 윈도우에 맞게 결과 크기 조절

---

## 8. MCP 도구 목록 (~18개)

### 8.1 AI 대화 (3개)

| 도구 | 설명 |
|------|------|
| `ai_chat` | 특정 provider에게 질문. `provider`, `model`, `prompt`, `system`, `files` 파라미터 |
| `ai_analyze_files` | 파일 분석 요청. provider 선택 가능. 결과를 .ai_workspace/에 저장 |
| `ai_compare` | 여러 provider에게 동일 질문, 응답 비교 |

### 8.2 에이전트 세션 (4개)

| 도구 | 설명 |
|------|------|
| `agent_debate_start` | 자율 토론 시작. topic, providers[], max_rounds |
| `agent_debate_status` | 진행 중인 토론 상태 확인 / 결과 조회 |
| `agent_assign_task` | 특정 AI에게 작업 할당 |
| `agent_task_status` | 할당된 작업 상태 확인 |

### 8.3 워크스페이스 (4개)

| 도구 | 설명 |
|------|------|
| `workspace_create_review` | 리뷰 문서 생성 (파일 목록, 규칙) |
| `workspace_request_review` | 특정 AI에게 리뷰 요청 |
| `workspace_add_comment` | 문서에 코멘트 추가 |
| `workspace_read` | 워크스페이스 문서 읽기 |

### 8.4 프로바이더 관리 (2개)

| 도구 | 설명 |
|------|------|
| `provider_list` | 사용 가능한 프로바이더 + 능력 목록 |
| `provider_health` | 프로바이더 상태 확인 |

### 8.5 Ollama 전용 (2개)

| 도구 | 설명 |
|------|------|
| `ollama_models` | 설치된 모델 목록 + 능력 |
| `ollama_pull` | 모델 다운로드 |

### 8.6 메모리 (2개)

| 도구 | 설명 |
|------|------|
| `memory_search` | 하이브리드 검색 (벡터 + BM25 + 그래프) |
| `memory_index` | 파일/디렉토리를 메모리에 인덱싱 |

### 8.7 시스템 (1개)

| 도구 | 설명 |
|------|------|
| `agestra_setup` | 초기 설정 (프로바이더 감지, 설정 생성, 모델 설치) |

---

## 9. 삭제 대상 도구 (50개)

### Claude Code 중복 (23개)

| 도구 | 대체 수단 |
|------|----------|
| `fs_write_file` | Claude Code Write 도구 |
| `fs_read_file` | Claude Code Read 도구 |
| `fs_list_directory` | Claude Code Glob 도구 |
| `fs_search_files` | Claude Code Grep 도구 |
| `shell_execute` | Claude Code Bash 도구 |
| `diff_files` | Claude Code Bash (diff) |
| `diff_strings` | Claude Code Bash (diff) |
| `process_list` | Claude Code Bash (ps) |
| `process_kill` | Claude Code Bash (kill) |
| `background_run` | Claude Code Bash (background) |
| `background_status` | Claude Code Bash |
| `env_get` | Claude Code Bash (echo $VAR) |
| `env_set` | Claude Code Bash (export) |
| `dotenv_parse` | Claude Code Read + Bash |
| `fetch_url` | Claude Code WebFetch 도구 |
| `sqlite_query` | Claude Code Bash (sqlite3) |
| `think_step` | Claude 자체 reasoning |
| `gh_create_pr` | Claude Code Bash (gh pr create) |
| `gh_list_issues` | Claude Code Bash (gh issue list) |
| `gh_get_issue` | Claude Code Bash (gh issue view) |
| `manage_memory` | Claude Code 자체 memory / 새 memory 패키지 |
| `read_memory` | Claude Code 자체 memory / 새 memory 패키지 |
| `todo_manager` | Claude Code TaskCreate/TaskUpdate |

### 통합/리팩토링 (27개)

| 기존 도구 | 새 도구로 통합 |
|----------|--------------|
| `ollama_chat` | → `ai_chat(provider="ollama")` |
| `ollama_analyze_file` | → `ai_analyze_files(provider="ollama")` |
| `ollama_analyze_files` | → `ai_analyze_files(provider="ollama")` |
| `ollama_agent` | → `agent_assign_task(provider="ollama")` |
| `ollama_list_models` | → `ollama_models` |
| `ollama_embeddings` | → memory 패키지 내부 사용 |
| `ollama_pull` | → `ollama_pull` (유지) |
| `ollama_show` | → `ollama_models` (통합) |
| `gemini_ask` | → `ai_chat(provider="gemini")` |
| `gemini_analyze_codebase` | → `ai_analyze_files(provider="gemini")` |
| `smart_ask` | → `ai_chat` (provider 자동 선택 또는 명시) |
| `compare_models` | → `ai_compare` |
| `code_review` | → `agent_debate_start` or `workspace_create_review` |
| `code_review_discuss` | → `agent_debate_status` |
| `code_discussion` | → `agent_debate_start` |
| `code_discussion_continue` | → `agent_debate_status` |
| `cross_review` | → `workspace_create_review` + `workspace_request_review` |
| `validate_changes` | → `workspace_request_review` |
| `git_commit_helper` | → `ai_chat`로 대체 가능 |
| `generate_unit_test` | → `agent_assign_task` |
| `add_docstrings` | → `agent_assign_task` |
| `check_types` | Claude Code Bash (tsc/mypy) |
| `run_linter` | Claude Code Bash (eslint/ruff) |
| `analyze_dependencies` | Claude Code Bash (npm audit) |
| `find_unused_exports` | Claude Code Bash/Grep |
| `rag_index` | → `memory_index` |
| `rag_search` / `rag_ask` | → `memory_search` |

### 지식 그래프 (5개) → memory 패키지 내부로

| 기존 도구 | 처리 |
|----------|------|
| `memory_add_node` | → memory 패키지 내부 API |
| `memory_add_relation` | → memory 패키지 내부 API |
| `memory_query_graph` | → `memory_search` |
| `memory_save_graph` | → memory 패키지 자동 관리 |
| `memory_load_graph` | → memory 패키지 자동 관리 |

---

## 10. 설정 기반 프로바이더 등록

### 10.1 프로바이더 추가 절차

새 CLI AI를 추가하려면:

1. `packages/provider-new-ai/` 패키지 생성
2. `AIProvider` 인터페이스 구현
3. `providers.config.json`에 항목 추가

**코어 코드 수정 불필요.**

### 10.2 런타임 흐름

```
서버 시작
  ↓
providers.config.json 로드
  ↓
각 provider의 initialize() 호출
  - Ollama: HTTP 연결 테스트 + 모델 감지
  - Gemini: CLI 설치 확인
  - Codex: CLI 설치 확인 + API 키 확인
  ↓
isAvailable() == false인 provider → 비활성화 (에러 아님)
  ↓
MCP 도구 등록 (사용 가능한 provider 목록 기반)
  ↓
서버 준비 완료
```

---

## 11. 에러 처리 전략

### 11.1 폴백 없음

```
ai_chat(provider="gemini", prompt="...")
  ↓
Gemini 실패
  ↓
ProviderExecutionError 반환 (다른 provider로 자동 재시도 금지)
  ↓
Claude가 판단: 다른 provider에게 재시도하거나, 사용자에게 알림
```

### 11.2 표준 에러 코드

> **🔒 FROZEN (2026-03-02)** — 에러 코드 5종 확정. 각 에러는 `retryable: boolean` 필드 포함.

모든 에러는 `ProviderError` 계층으로 통일:
- `ProviderNotFoundError`: 등록되지 않은 provider ID (`retryable: false`)
- `ProviderUnavailableError`: 설치 안 됨 / 서버 다운 (`retryable: false`)
- `ProviderAuthError`: 인증 실패 (`retryable: false`)
- `ProviderTimeoutError`: 타임아웃 (`retryable: true` — 1회 재시도, 지수 백오프)
- `ProviderExecutionError`: CLI 실행 오류 (`retryable: true` — 1회 재시도)

---

## 12. 보안 고려사항

1. **API 키 노출 방지**: provider config에서 API 키를 환경변수로만 참조
2. **프롬프트 인젝션 방어**: 파일 내용을 encapsulate하여 방어 프롬프트와 함께 전달
3. **경로 검증**: 기존 assertPathSafe() 유지
4. **CLI 실행 샌드박싱**: Codex는 `--full-auto --ephemeral`, Gemini는 `-o json`

---

## 13. 2차 개편 예정 사항

1. **웹 대시보드** (`packages/web-dashboard/`)
   - 에이전트 세션 모니터링
   - 워크스페이스 문서 시각화
   - 프로바이더 상태 대시보드

2. **메모리 고도화**
   - CRAG 스타일 검색 품질 필터링
   - 전략적 컨텍스트 배치 (lost-in-middle 완화)
   - 에이전트별 ACL (사적/공유 메모리)

3. **추가 프로바이더**
   - `provider-llama-cpp`: llama.cpp 직접 실행
   - `provider-aider`: Aider CLI 통합
   - 커뮤니티 프로바이더 npm 배포

---

## 14. 마이그레이션 전략

기존 v3.2.0에서 v4.0으로의 전환:

1. 모노레포 초기 세팅 (turbo, workspaces, tsconfig)
2. core 패키지부터 구현 (인터페이스, 레지스트리, CLI 러너)
3. 기존 helpers/ollama.ts → provider-ollama 패키지로 이전
4. 기존 helpers/gemini.ts → provider-gemini 패키지로 이전
5. Codex provider 신규 구현
6. 에이전트 세션 시스템 구현
7. 워크스페이스 시스템 구현
8. AI_Chat_Arena 메모리 시스템 포팅
9. MCP 도구 재정의 (18개)
10. 기존 도구 삭제
11. 테스트 작성
12. README 업데이트

---

## 부록 A: Gemini/Codex 의견 원문 요약

### Gemini 제안
- `CliAiProvider` 인터페이스 + `ProviderRegistry` + `providers.config.json`
- `cli_ai_invoke` 단일 도구
- Stateless provider, 세션은 파라미터로 전달
- 동적 enum으로 사용 가능한 provider 목록 노출

### Codex 제안
- `AIProvider` 인터페이스 + `ProviderFactory` + `ProviderRegistry`
- `ai.chat` 단일 도구
- `CliProcessRunner` 공통 유틸
- 표준 에러 모델 (5가지 에러 타입)
- `src/core/` + `src/providers/` 디렉토리 구조
- 마이그레이션: 기존 도구 → 새 도구 위임 → deprecated → 삭제
