# Agestra

**Agent + Orchestra** — 여러 AI 공급자를 Claude Code에서 오케스트레이션하는 MCP 서버.

[English](README.md) | [한국어](README.ko.md)

Agestra는 Ollama(로컬), Gemini CLI, Codex CLI를 Claude Code에 플러그형으로 연결합니다. 멀티에이전트 토론, 병렬 작업 분배, 교차 검증, 지속적 GraphRAG 메모리 시스템을 31개 MCP 도구로 제공합니다.

## 빠른 시작

```bash
git clone https://github.com/mua-vtuber/agestra.git
cd agestra
npm install
npm run build
```

Claude Code에 등록:

```bash
claude mcp add agestra node $(pwd)/packages/mcp-server/dist/index.js
```

이후 Claude에게 `agestra_setup` 실행을 요청하세요. 공급자 자동 감지, 설정 생성, `CLAUDE.md` + 훅 설정까지 한 번에 완료합니다.

---

## 아키텍처

Turborepo 모노레포, 8개 패키지:

| 패키지 | 설명 |
|--------|------|
| `@agestra/core` | `AIProvider` 인터페이스, 레지스트리, 설정 로더, CLI 러너, 원자적 쓰기, 작업 큐 |
| `@agestra/provider-ollama` | Ollama HTTP 어댑터 (모델 자동 감지) |
| `@agestra/provider-gemini` | Google Gemini CLI 어댑터 |
| `@agestra/provider-codex` | OpenAI Codex CLI 어댑터 |
| `@agestra/agents` | 토론 엔진, 작업 분배기, 교차 검증기, 세션 관리자 |
| `@agestra/workspace` | 코드 리뷰 워크플로우용 문서 관리자 |
| `@agestra/memory` | GraphRAG — FTS5 + 벡터 + 지식 그래프 하이브리드 검색, 실패 추적 |
| `@agestra/mcp-server` | MCP 프로토콜 레이어, 31개 도구, 디스패치, 설정 생성 |

### 설계 원칙

- **공급자 추상화** — 모든 백엔드가 `AIProvider`(`chat`, `healthCheck`, `getCapabilities`)를 구현. 기존 코드 수정 없이 새 공급자 추가 가능.
- **설정 기반** — `providers.config.json`에 활성 공급자 선언. 레지스트리가 런타임에 로드·노출.
- **모듈형 디스패치** — 각 도구 카테고리가 `getTools()` + `handleTool()`을 내보내는 독립 모듈. 서버가 동적으로 수집·디스패치.
- **원자적 쓰기** — 모든 파일 연산이 임시 파일 → rename 방식. 크래시 시 손상 방지.
- **실패 추적** — 실패한 접근법이 GraphRAG에 자동 기록, 이후 프롬프트에 주입.
- **동적 능력 판단** — Ollama 모델은 파라미터 수(파일 크기 기반 추정)로 평가. 클라우드 공급자는 항상 에이전트 등급.

---

## 도구 (31개)

### AI 채팅 (3개)

| 도구 | 설명 |
|------|------|
| `ai_chat` | 특정 공급자와 채팅 |
| `ai_analyze_files` | 파일을 디스크에서 읽어 공급자에게 질문과 함께 전송 |
| `ai_compare` | 같은 프롬프트를 여러 공급자에 보내 응답 비교 |

### 에이전트 오케스트레이션 (9개)

| 도구 | 설명 |
|------|------|
| `agent_debate_start` | 다중 공급자 토론 시작 (논블로킹, 품질 루프 + 검증자 옵션) |
| `agent_debate_status` | 토론 상태 및 트랜스크립트 확인 |
| `agent_debate_create` | 턴 기반 토론 세션 생성 (토론 ID 반환) |
| `agent_debate_turn` | 공급자 1턴 실행; Claude 코멘트 주입 가능 |
| `agent_debate_conclude` | 토론 종료 및 최종 트랜스크립트 생성 |
| `agent_assign_task` | 특정 공급자에게 작업 위임 |
| `agent_task_status` | 작업 완료 상태 및 결과 확인 |
| `agent_dispatch` | 공급자 간 병렬 작업 분배 (의존성 순서 지원) |
| `agent_cross_validate` | 출력 교차 검증 (에이전트 등급 검증자만 가능) |

### 워크스페이스 (4개)

| 도구 | 설명 |
|------|------|
| `workspace_create_review` | 파일과 규칙이 포함된 코드 리뷰 문서 생성 |
| `workspace_request_review` | 공급자에게 문서 리뷰 요청 |
| `workspace_add_comment` | 리뷰에 코멘트 추가 |
| `workspace_read` | 리뷰 내용 읽기 |

### 공급자 관리 (2개)

| 도구 | 설명 |
|------|------|
| `provider_list` | 공급자 목록 (상태, 능력 포함) |
| `provider_health` | 공급자 상태 체크 |

### Ollama (2개)

| 도구 | 설명 |
|------|------|
| `ollama_models` | 설치된 모델 및 크기 목록 |
| `ollama_pull` | 모델 다운로드 |

### 메모리 (6개)

| 도구 | 설명 |
|------|------|
| `memory_search` | 하이브리드 검색 (FTS5 + 벡터 + 그래프) |
| `memory_index` | 파일/디렉토리를 메모리에 인덱싱 |
| `memory_store` | 지식 노드 저장 (fact, decision, dead_end, finding) |
| `memory_dead_ends` | 이전 실패 접근법 검색 (반복 방지) |
| `memory_context` | 토큰 예산 내 관련 컨텍스트 조립 |
| `memory_add_edge` | 지식 노드 간 관계 엣지 생성 |

### 작업 (2개)

| 도구 | 설명 |
|------|------|
| `cli_job_submit` | 장시간 CLI 작업을 백그라운드에 제출 |
| `cli_job_status` | 작업 상태 확인 및 출력 조회 |

### 설정 (3개)

| 도구 | 설명 |
|------|------|
| `agestra_setup` | 원스톱: 공급자 감지, 상태 체크, CLAUDE.md + 훅 생성 |
| `agestra_generate_config` | CLAUDE.md 섹션과 훅 재생성 (dry_run으로 미리보기) |
| `agestra_remove` | agestra 생성 설정 전체 제거 (CLAUDE.md 섹션, 훅, providers.config.json) |

---

## 설정

### MCP 서버 등록

**터미널에서** (Claude Code 밖):

```bash
claude mcp add agestra node $(pwd)/packages/mcp-server/dist/index.js
```

또는 `~/.claude/settings.json` 직접 편집:

```json
{
  "mcpServers": {
    "agestra": {
      "command": "node",
      "args": ["<PROJECT_ROOT>/packages/mcp-server/dist/index.js"]
    }
  }
}
```

### providers.config.json

`agestra_setup`이 자동 생성. 수동 편집도 가능.

| 필드 | 설명 |
|------|------|
| `defaultProvider` | 미지정 시 사용할 공급자 ID |
| `providers[].id` | 고유 식별자 |
| `providers[].type` | `ollama`, `gemini-cli`, `codex-cli` |
| `providers[].enabled` | 시작 시 로드 여부 |
| `providers[].executionPolicy` | `read-only`, `workspace-write`, `full-auto` |
| `providers[].config` | 타입별 설정 (host, timeout 등) |

`agestra_setup` 재실행 시 결과를 병합: `enabled` 갱신, 사용자 설정(host, timeout 등)은 보존.

### 생성되는 파일

| 파일 | 용도 |
|------|------|
| `providers.config.json` | 공급자 선언 (자동 감지) |
| `CLAUDE.md` | 사용 가이드라인, 능력 티어, 워크플로우, 완료 체크리스트 |
| `.claude/settings.local.json` | 훅 — 세션 시작, 커밋 리뷰, 위임 제안, 완료 검증 |

섹션은 버전 마커(`<!-- [agestra:v4.0.0] BEGIN/END -->`)로 감싸 안전하게 업데이트합니다.

### 런타임 데이터

`.agestra/` 아래 저장 (gitignore 대상):

| 경로 | 용도 |
|------|------|
| `.agestra/sessions/` | 토론 및 작업 세션 상태 |
| `.agestra/workspace/` | 코드 리뷰 문서 |
| `.agestra/memory.db` | GraphRAG SQLite 데이터베이스 |
| `.agestra/.jobs/` | 백그라운드 작업 큐 |

---

## 개발

```bash
npm run build      # 전체 빌드 (Turborepo)
npm test           # 전체 테스트 (Vitest)
npm run dev        # 워치 모드
npm run lint       # 린트 (ESLint)
npm run clean      # dist/ 삭제
```

### 프로젝트 구조

```
agestra/
├── packages/
│   ├── core/               # AIProvider 인터페이스, 레지스트리, 원자적 쓰기, 작업 큐
│   ├── provider-ollama/    # Ollama HTTP 어댑터
│   ├── provider-gemini/    # Gemini CLI 어댑터
│   ├── provider-codex/     # Codex CLI 어댑터
│   ├── agents/             # 토론 엔진, 분배기, 교차 검증기, 세션
│   ├── workspace/          # 코드 리뷰 문서 관리자
│   ├── memory/             # GraphRAG: 하이브리드 검색, 실패 추적, 컨텍스트 조립
│   └── mcp-server/         # MCP 서버, 31개 도구, 디스패치, 설정 생성
├── providers.config.json   # 공급자 설정
├── package.json            # 워크스페이스 루트
└── turbo.json              # Turborepo 파이프라인
```

### 새 공급자 추가

1. `packages/provider-<이름>/`에 `AIProvider` 구현.
2. `packages/mcp-server/src/index.ts`에 팩토리 추가.
3. `providers.config.json`에 공급자 블록 추가.
4. `npm run build && npm test`

---

## 요구사항

| 의존성 | 필수 | 비고 |
|--------|------|------|
| Node.js 18+ | 예 | 런타임 |
| npm | 예 | 워크스페이스 |
| [Ollama](https://ollama.com/) | 아니오 | 로컬 LLM 공급자용 |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | 아니오 | Gemini 공급자용 |
| [Codex CLI](https://github.com/openai/codex) | 아니오 | Codex 공급자용 |

최소 하나의 공급자가 설치되어야 서버가 유용합니다.

---

## 라이선스

MIT
