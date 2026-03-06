# Agestra

[![npm version](https://img.shields.io/npm/v/agestra.svg)](https://www.npmjs.com/package/agestra)
[![license](https://img.shields.io/npm/l/agestra.svg)](LICENSE)

**Agent + Orchestra** — 여러 AI 공급자를 Claude Code에서 오케스트레이션하는 플러그인.

[English](README.md) | [한국어](README.ko.md)

Agestra는 Ollama(로컬), Gemini CLI, Codex CLI를 Claude Code에 플러그형으로 연결합니다. 멀티에이전트 토론, 병렬 작업 분배, 교차 검증, 지속적 GraphRAG 메모리 시스템을 39개 MCP 도구로 제공합니다.

## 빠른 시작

Claude Code에서 실행:

```
/plugin marketplace add mua-vtuber/Agestra
/plugin install agestra@agestra
```

끝. Agestra가 첫 사용 시 사용 가능한 공급자(Ollama, Gemini CLI, Codex CLI)를 자동 감지합니다.

### 사전 요구사항

최소 하나의 AI 공급자가 설치되어야 합니다:

| 공급자 | 설치 | 유형 |
|--------|------|------|
| [Ollama](https://ollama.com/) | `curl -fsSL https://ollama.com/install.sh \| sh` | 로컬 LLM |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | 클라우드 |
| [Codex CLI](https://github.com/openai/codex) | `npm install -g @openai/codex` | 클라우드 |

---

## 철학

**멀티 AI는 검증을 위한 것이지, 토큰 절약을 위한 것이 아닙니다.** 리뷰, 설계 탐색, 아이디어 발굴 워크플로우는 검증 프로세스로 설계되었습니다 — 속도를 위한 병렬화가 아니라, 사각지대를 잡기 위해 여러 AI 공급자로부터 독립적인 의견을 얻는 것입니다.

## 커맨드

| 커맨드 | 설명 |
|--------|------|
| `/agestra review [대상]` | 코드 품질, 보안, 통합 완성도 검증 |
| `/agestra idea [주제]` | 유사 프로젝트 비교를 통한 개선점 발굴 |
| `/agestra design [주제]` | 구현 전 아키텍처 및 설계 트레이드오프 탐색 |

각 커맨드는 선택지를 제시합니다: **Claude만**, **비교** (여러 AI 나란히), **토론** (구조화된 멀티AI 논의), **기타** (사용자 지정).

## 에이전트

| 에이전트 | 모델 | 역할 |
|----------|------|------|
| `reviewer` | Opus | 엄격한 품질 검증 — 보안, 고아 시스템, 스펙 이탈, 테스트 공백 |
| `designer` | Opus | 아키텍처 탐색 — 소크라테스식 질문, 트레이드오프 분석 |
| `ideator` | Sonnet | 개선점 발굴 — 웹 리서치, 경쟁 분석 |
| `moderator` | Sonnet | 토론 진행 — 중립, 턴 관리, 합의 판정 |

---

## 아키텍처

Turborepo 모노레포, 8개 패키지:

| 패키지 | 설명 |
|--------|------|
| `@agestra/core` | `AIProvider` 인터페이스, 레지스트리, 설정 로더, CLI 러너, 원자적 쓰기, 작업 큐 |
| `@agestra/provider-ollama` | Ollama HTTP 어댑터 (모델 자동 감지) |
| `@agestra/provider-gemini` | Google Gemini CLI 어댑터 |
| `@agestra/provider-codex` | OpenAI Codex CLI 어댑터 |
| `@agestra/agents` | 토론 엔진, 작업 분배기, 교차 검증기, 작업 체인, 자동 QA, 파일 변경 추적기, 세션 관리자 |
| `@agestra/workspace` | 코드 리뷰 워크플로우용 문서 관리자 |
| `@agestra/memory` | GraphRAG — FTS5 + 벡터 + 지식 그래프 하이브리드 검색, 실패 추적 |
| `@agestra/mcp-server` | MCP 프로토콜 레이어, 39개 도구, 디스패치 |

### 설계 원칙

- **공급자 추상화** — 모든 백엔드가 `AIProvider`(`chat`, `healthCheck`, `getCapabilities`)를 구현. 기존 코드 수정 없이 새 공급자 추가 가능.
- **제로 설정** — 시작 시 공급자를 자동 감지. 수동 설정 불필요.
- **플러그인 네이티브** — Claude Code 플러그인으로 설치. Skills, hooks, MCP 서버가 함께 번들.
- **모듈형 디스패치** — 각 도구 카테고리가 `getTools()` + `handleTool()`을 내보내는 독립 모듈. 서버가 동적으로 수집·디스패치.
- **원자적 쓰기** — 모든 파일 연산이 임시 파일 → rename 방식. 크래시 시 손상 방지.
- **실패 추적** — 실패한 접근법이 GraphRAG에 자동 기록, 이후 프롬프트에 주입.

---

## 도구 (39개)

### AI 채팅 (3개)

| 도구 | 설명 |
|------|------|
| `ai_chat` | 특정 공급자와 채팅 (품질 기반 자동 라우팅: `"auto"`) |
| `ai_analyze_files` | 파일을 디스크에서 읽어 공급자에게 질문과 함께 전송 |
| `ai_compare` | 같은 프롬프트를 여러 공급자에 보내 응답 비교 |

### 에이전트 오케스트레이션 (16개)

| 도구 | 설명 |
|------|------|
| `agent_debate_start` | 다중 공급자 토론 시작 (논블로킹, 품질 루프 + 검증자 옵션) |
| `agent_debate_status` | 토론 상태 및 트랜스크립트 확인 |
| `agent_debate_create` | 턴 기반 토론 세션 생성 (토론 ID 반환) |
| `agent_debate_turn` | 공급자 1턴 실행; `provider: "claude"`로 Claude 독립 참여 지원 |
| `agent_debate_conclude` | 토론 종료 및 최종 트랜스크립트 생성 |
| `agent_debate_review` | 문서를 여러 공급자에게 독립적으로 리뷰 요청 |
| `agent_assign_task` | 특정 공급자에게 작업 위임 |
| `agent_task_status` | 작업 완료 상태 및 결과 확인 |
| `agent_dispatch` | 공급자 간 병렬 작업 분배 (의존성 순서 지원) |
| `agent_cross_validate` | 출력 교차 검증 (에이전트 등급 검증자만 가능) |
| `agent_task_chain_create` | 의존성과 체크포인트가 있는 다단계 작업 체인 생성 |
| `agent_task_chain_step` | 체인의 다음 (또는 지정) 단계 실행 |
| `agent_task_chain_status` | 체인 진행 상태 및 단계 결과 확인 |
| `agent_changes_review` | 격리된 작업의 파일 변경 리뷰 |
| `agent_changes_accept` | 격리된 작업의 변경 수락 및 병합 |
| `agent_changes_reject` | 변경 거부 및 격리 워크트리 정리 |

### 워크스페이스 (5개)

| 도구 | 설명 |
|------|------|
| `workspace_create_review` | 파일과 규칙이 포함된 코드 리뷰 문서 생성 |
| `workspace_request_review` | 공급자에게 문서 리뷰 요청 |
| `workspace_review_status` | 리뷰 완료 상태 확인 |
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

### 추적 / 관측성 (3개)

| 도구 | 설명 |
|------|------|
| `trace_query` | 조건별 추적 레코드 조회 (공급자, 작업, 기간) |
| `trace_summary` | 공급자별·작업별 품질 및 성능 통계 |
| `trace_visualize` | 추적된 작업 흐름의 Mermaid 다이어그램 생성 |

---

## 설정

### providers.config.json (선택)

Agestra는 시작 시 공급자를 자동 감지합니다. 수동 제어가 필요하면 프로젝트 루트에 `providers.config.json`을 생성하세요:

| 필드 | 설명 |
|------|------|
| `defaultProvider` | 미지정 시 사용할 공급자 ID |
| `providers[].id` | 고유 식별자 |
| `providers[].type` | `ollama`, `gemini-cli`, `codex-cli` |
| `providers[].enabled` | 시작 시 로드 여부 |
| `providers[].config` | 타입별 설정 (host, timeout 등) |

### 런타임 데이터

`.agestra/` 아래 저장 (gitignore 대상):

| 경로 | 용도 |
|------|------|
| `.agestra/sessions/` | 토론 및 작업 세션 상태 |
| `.agestra/workspace/` | 코드 리뷰 문서 |
| `.agestra/memory.db` | GraphRAG SQLite 데이터베이스 |
| `.agestra/.jobs/` | 백그라운드 작업 큐 |
| `.agestra/traces/` | 공급자 추적 JSONL (30일 후 자동 정리) |

---

## 개발

```bash
npm install        # 의존성 설치
npm run build      # 전체 빌드 (Turborepo)
npm test           # 전체 테스트 (Vitest)
npm run bundle     # 단일 파일 플러그인 번들 (esbuild)
npm run dev        # 워치 모드
npm run lint       # 린트 (ESLint)
npm run clean      # dist/ 삭제
```

### 프로젝트 구조

```
agestra/
├── .claude-plugin/
│   ├── plugin.json          # Claude Code 플러그인 매니페스트
│   └── marketplace.json     # 플러그인 마켓플레이스 메타데이터
├── commands/
│   ├── review.md            # /agestra review — 품질 검증
│   ├── idea.md              # /agestra idea — 개선점 발굴
│   └── design.md            # /agestra design — 아키텍처 탐색
├── agents/
│   ├── reviewer.md          # 엄격한 품질 검증자 (Opus)
│   ├── designer.md          # 아키텍처 탐색자 (Opus)
│   ├── ideator.md           # 개선점 발굴자 (Sonnet)
│   ├── moderator.md         # 토론 진행자 (Sonnet)
│   ├── qa.md                # QA 검증자 (프로젝트 내부)
│   └── team-lead.md         # 작업 오케스트레이터 (프로젝트 내부)
├── skills/
│   └── provider-guide.md    # 공급자 사용 가이드라인 (skill)
├── hooks/
│   └── user-prompt-submit.md  # 도구 추천 hook
├── dist/
│   └── bundle.js            # 단일 파일 MCP 서버 번들
├── scripts/
│   └── bundle.mjs           # esbuild 번들 스크립트
├── packages/
│   ├── core/                # AIProvider 인터페이스, 레지스트리
│   ├── provider-ollama/     # Ollama HTTP 어댑터
│   ├── provider-gemini/     # Gemini CLI 어댑터
│   ├── provider-codex/      # Codex CLI 어댑터
│   ├── agents/              # 토론 엔진, 분배기, 교차 검증기
│   ├── workspace/           # 코드 리뷰 문서 관리자
│   ├── memory/              # GraphRAG: 하이브리드 검색, 실패 추적
│   └── mcp-server/          # MCP 서버, 39개 도구, 디스패치
├── package.json             # 워크스페이스 루트
└── turbo.json               # Turborepo 파이프라인
```

### 새 공급자 추가

1. `packages/provider-<이름>/`에 `AIProvider` 구현.
2. `packages/mcp-server/src/index.ts`에 팩토리 추가.
3. `npm run build && npm test`

---

## 제거

Claude Code에서:

```
/plugin uninstall agestra@agestra
```

프로젝트에 잔여 파일 없음. 깔끔한 제거.

---

## 라이선스

[GPL-3.0](LICENSE)
