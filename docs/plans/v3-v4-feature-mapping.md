# v3 → v4 기능 매핑표

**작성일:** 2026-03-02
**목적:** v3.2.0의 모든 도구(69개)를 열거하고, v4.0에서의 처리 방식을 결정
**참조:** `docs/plans/2026-03-02-mcp-overhaul-design.md`

> **참고:** 설계문서에서는 68개로 기술되어 있으나, 소스 코드에는 `generate_commit_message`가 별도 도구로 추가되어 실제로는 69개입니다.

---

## 처리 방식 범례

| 기호 | 의미 | 설명 |
|------|------|------|
| **삭제** | Claude Code 중복 | Claude Code 자체 기능(Read, Write, Bash, Grep, Glob 등)으로 대체 |
| **통합** | v4 도구로 통합 | 기존 기능이 v4의 통합 도구에 흡수 |
| **포팅** | 패키지 내부로 | MCP 도구가 아닌 패키지 내부 API로 전환 |
| **유지** | 그대로 유지 | v4에서도 독립 MCP 도구로 존재 |

---

## 1. 파일 시스템 도구 (filesystem.ts) — 4개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 1 | `fs_write_file` | 파일 생성/덮어쓰기 | **삭제** | Claude Code `Write` 도구 | 완전 중복 |
| 2 | `fs_read_file` | 파일 읽기 (offset/limit 지원) | **삭제** | Claude Code `Read` 도구 | 완전 중복 |
| 3 | `fs_list_directory` | 디렉토리 목록 | **삭제** | Claude Code `Glob` / `Bash(ls)` | 완전 중복 |
| 4 | `fs_search_files` | 파일 내 패턴 검색 | **삭제** | Claude Code `Grep` 도구 | 완전 중복 |

---

## 2. 웹 도구 (web.ts) — 1개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 5 | `fetch_url` | URL 페치 + HTML 텍스트 추출 | **삭제** | Claude Code `WebFetch` 도구 | 완전 중복 |

---

## 3. 메모리 도구 (memory.ts) — 2개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 6 | `manage_memory` | .ai_context.md에 팩트 추가 | **삭제** | Claude Code 자체 memory + v4 `memory_index` | 단순 파일 append, CLAUDE.md로 대체 가능 |
| 7 | `read_memory` | .ai_context.md 읽기 | **삭제** | Claude Code `Read` + v4 `memory_search` | 파일 읽기에 불과 |

---

## 4. 데이터베이스 도구 (database.ts) — 1개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 8 | `sqlite_query` | SQLite SELECT 쿼리 실행 | **삭제** | Claude Code `Bash(sqlite3)` | 완전 중복 |

---

## 5. 생산성 도구 (productivity.ts) — 10개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 9 | `todo_manager` | TODO.md 관리 (list/add/complete) | **삭제** | Claude Code `TaskCreate`/`TaskUpdate` | 완전 중복 |
| 10 | `code_review` | Gemini와 코드 리뷰 세션 시작 | **통합** | `workspace_create_review` + `workspace_request_review` | 세션 기반 → 파일 기반 비동기 리뷰로 전환 |
| 11 | `code_review_discuss` | 리뷰 세션 계속 진행 | **통합** | `agent_debate_start` + `agent_debate_status` | 자율 토론 엔진으로 통합 |
| 12 | `code_discussion` | Gemini와 솔루션 토론 시작 | **통합** | `agent_debate_start` | topic 기반 토론 → 자율 토론으로 일반화 |
| 13 | `code_discussion_continue` | 토론 세션 계속 진행 | **통합** | `agent_debate_status` | 상태 확인 + 자동 진행 |
| 14 | `cross_review` | Gemini 병렬 독립 리뷰 | **통합** | `workspace_create_review` + `workspace_request_review` | 여러 프로바이더에게 독립 리뷰 요청 |
| 15 | `validate_changes` | 변경 사항 규칙 검증 | **통합** | `workspace_request_review` | 규칙 기반 검증 = 리뷰의 특수 케이스 |
| 16 | `git_commit_helper` | git diff → 커밋 메시지 생성 | **통합** | `ai_chat(prompt=diff)` | 전용 도구 불필요, ai_chat으로 가능 |
| 17 | `generate_unit_test` | 파일 → 유닛 테스트 생성 | **통합** | `agent_assign_task` | 프로바이더에게 작업 위임 |
| 18 | `add_docstrings` | 파일에 독스트링 추가 | **통합** | `agent_assign_task` | 프로바이더에게 작업 위임 |

---

## 6. GitHub/Git 도구 (github.ts) — 4개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 19 | `gh_create_pr` | Pull Request 생성 | **삭제** | Claude Code `Bash(gh pr create)` | 완전 중복 |
| 20 | `gh_list_issues` | 이슈 목록 조회 | **삭제** | Claude Code `Bash(gh issue list)` | 완전 중복 |
| 21 | `gh_get_issue` | 이슈 상세 보기 | **삭제** | Claude Code `Bash(gh issue view)` | 완전 중복 |
| 22 | `generate_commit_message` | LLM 기반 커밋 메시지 생성 (다국어/스타일) | **통합** | `ai_chat` | 프롬프트로 처리 가능 |

---

## 7. LLM 도구 (llm.ts) — 12개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 23 | `ollama_chat` | Ollama와 대화 | **통합** | `ai_chat(provider="ollama")` | 프로바이더 추상화 |
| 24 | `ollama_analyze_file` | 단일 파일 분석 (서버 사이드 읽기) | **통합** | `ai_analyze_files(provider="ollama")` | 토큰 절감 기능 보존 |
| 25 | `ollama_analyze_files` | 다중 파일 분석 | **통합** | `ai_analyze_files(provider="ollama")` | 동일 |
| 26 | `ollama_list_models` | 설치된 모델 목록 | **유지** | `ollama_models` | 이름만 변경 |
| 27 | `ollama_agent` | Ollama 에이전트 (도구 호출) | **통합** | `agent_assign_task(provider="ollama")` | 에이전트 세션으로 통합 |
| 28 | `gemini_ask` | Gemini CLI에 질문 | **통합** | `ai_chat(provider="gemini")` | 프로바이더 추상화 |
| 29 | `gemini_analyze_codebase` | Gemini로 코드베이스 분석 | **통합** | `ai_analyze_files(provider="gemini")` | 프로바이더 추상화 |
| 30 | `smart_ask` | 자동 라우팅 (Ollama/Gemini) | **통합** | `ai_chat` | provider 미지정 시 자동 선택 또는 명시 |
| 31 | `ollama_embeddings` | 텍스트 임베딩 생성 | **포팅** | `@agestra/memory` 내부 API | MCP 도구가 아닌 패키지 내부로 |
| 32 | `ollama_pull` | 모델 다운로드 | **유지** | `ollama_pull` | 그대로 유지 |
| 33 | `ollama_show` | 모델 상세 정보 | **통합** | `ollama_models` | 모델 목록 + 상세를 하나로 |
| 34 | `compare_models` | Ollama/Gemini 응답 비교 | **통합** | `ai_compare` | N개 프로바이더 비교로 일반화 |

---

## 8. 셸/환경 도구 (shell.ts) — 4개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 35 | `shell_execute` | 셸 명령어 실행 | **삭제** | Claude Code `Bash` 도구 | 완전 중복 |
| 36 | `env_get` | 환경변수 조회 | **삭제** | Claude Code `Bash(echo $VAR)` | 완전 중복 |
| 37 | `env_set` | 환경변수 설정 (세션) | **삭제** | Claude Code `Bash(export)` | 완전 중복 |
| 38 | `dotenv_parse` | .env 파일 파싱 | **삭제** | Claude Code `Read` + `Bash` | 완전 중복 |

---

## 9. 사고 도구 (thinking.ts) — 1개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 39 | `think_step` | 순차적 사고 기록 | **삭제** | Claude 자체 reasoning (extended thinking) | 완전 중복 |

---

## 10. 지식 그래프 도구 (knowledge.ts) — 5개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 40 | `memory_add_node` | 지식 그래프에 노드 추가 | **포팅** | `@agestra/memory` 내부 API | 자동화된 엔티티 추출로 대체 |
| 41 | `memory_add_relation` | 노드 간 관계 추가 | **포팅** | `@agestra/memory` 내부 API | 자동화된 관계 추출로 대체 |
| 42 | `memory_query_graph` | 지식 그래프 쿼리 | **통합** | `memory_search` | 하이브리드 검색(FTS5+Vector+Graph)으로 통합 |
| 43 | `memory_save_graph` | 그래프를 JSON 파일로 저장 | **포팅** | `@agestra/memory` 자동 관리 | SQLite 기반으로 전환, 수동 저장 불필요 |
| 44 | `memory_load_graph` | JSON에서 그래프 로드 | **포팅** | `@agestra/memory` 자동 관리 | SQLite 기반으로 전환, 수동 로드 불필요 |

---

## 11. 코드 분석 도구 (analysis.ts) — 4개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 45 | `analyze_dependencies` | 의존성 분석 (package.json/requirements.txt) | **삭제** | Claude Code `Bash(npm audit)` / `Read` | CLI 래핑에 불과 |
| 46 | `find_unused_exports` | 미사용 export 탐지 | **삭제** | Claude Code `Bash` + `Grep` | 정적 분석, Claude가 직접 가능 |
| 47 | `check_types` | 타입 체크 (tsc/mypy/pyright) | **삭제** | Claude Code `Bash(npx tsc --noEmit)` | CLI 래핑에 불과 |
| 48 | `run_linter` | 린터 실행 (eslint/ruff/pylint) | **삭제** | Claude Code `Bash(npx eslint .)` | CLI 래핑에 불과 |

---

## 12. Diff 도구 (diff.ts) — 2개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 49 | `diff_files` | 두 파일 비교 (unified diff) | **삭제** | Claude Code `Bash(diff)` | 완전 중복 |
| 50 | `diff_strings` | 두 문자열 비교 | **삭제** | Claude Code `Bash(diff)` | 완전 중복 |

---

## 13. 프로세스 관리 도구 (process.ts) — 4개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 51 | `process_list` | 프로세스 목록 (ps/tasklist) | **삭제** | Claude Code `Bash(ps aux)` | 완전 중복 |
| 52 | `process_kill` | 프로세스 종료 | **삭제** | Claude Code `Bash(kill)` | v3에서 자체 프로세스만 kill 허용하는 보안이 있었으나, Claude Code Bash로 대체 |
| 53 | `background_run` | 백그라운드 명령 실행 | **삭제** | Claude Code `Bash` (run_in_background) | 완전 중복 |
| 54 | `background_status` | 백그라운드 프로세스 상태 | **삭제** | Claude Code `Bash` | 완전 중복 |

---

## 14. LLM 유틸리티 도구 (utility.ts) — 9개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 55 | `prompt_template` | 프롬프트 템플릿 관리 (CRUD + apply) | **삭제** | Claude Code 자체 프롬프트 관리 | 인메모리 상태, 실용성 낮음 |
| 56 | `response_cache` | LLM 응답 캐시 | **삭제** | 불필요 | 인메모리 캐시, 세션 간 유지 안됨 |
| 57 | `token_count` | 토큰 수 추정 | **삭제** | Claude Code 자체 판단 | 근사치일 뿐, Claude가 자체 관리 |
| 58 | `translate_text` | 텍스트 번역 (Ollama/Gemini) | **통합** | `ai_chat` | 번역 = 프롬프트 태스크 |
| 59 | `translate_file` | 파일 번역 (서버 사이드 읽기) | **통합** | `ai_analyze_files` | 서버 사이드 파일 읽기 + LLM 처리 |
| 60 | `summarize_text` | 텍스트 요약 | **통합** | `ai_chat` | 요약 = 프롬프트 태스크 |
| 61 | `extract_keywords` | 키워드 추출 | **통합** | `ai_chat` | 키워드 추출 = 프롬프트 태스크 |
| 62 | `explain_code` | 코드 설명 | **통합** | `ai_chat` | 설명 = 프롬프트 태스크 |
| 63 | `improve_text` | 텍스트 개선 | **통합** | `ai_chat` | 개선 = 프롬프트 태스크 |

---

## 15. 헬스 체크 도구 (health.ts) — 1개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 64 | `health_check` | Ollama/Gemini 상태 확인 | **통합** | `provider_health` | 모든 프로바이더 헬스 체크로 일반화 |

---

## 16. 시스템 설정 도구 (setup.ts) — 2개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 65 | `agestra_system_profile` | GPU/VRAM 감지 + 모델 설정 계산 | **통합** | `agestra_setup` | setup 도구로 흡수 |
| 66 | `agestra_setup` | 자동 설정 (하드웨어 감지, 모델 설치, 설정 파일 생성) | **유지** | `agestra_setup` | 프로바이더 감지/설정으로 확장 |

---

## 17. RAG 도구 (rag.ts) — 3개

| # | v3 도구명 | 설명 | 처리 | v4 대응 | 비고 |
|---|----------|------|------|---------|------|
| 67 | `rag_index` | 파일/디렉토리 벡터 인덱싱 | **통합** | `memory_index` | GraphRAG 기반 인덱싱으로 업그레이드 |
| 68 | `rag_search` | 벡터 검색 (top-K) | **통합** | `memory_search` | 하이브리드 검색(FTS5+Vector+Graph)으로 업그레이드 |
| 69 | `rag_ask` | RAG 기반 QA (검색 → LLM 응답) | **통합** | `memory_search` + `ai_chat` | 검색과 대화를 분리하여 조합 |

---

## 종합 통계

| 처리 방식 | 도구 수 | 비율 |
|----------|---------|------|
| **삭제** (Claude Code 중복) | 30 | 43.5% |
| **통합** (v4 도구로 통합) | 28 | 40.6% |
| **포팅** (패키지 내부 API) | 5 | 7.2% |
| **유지** (v4에서도 독립 도구) | 6 | 8.7% |
| **합계** | **69** | 100% |

---

## v4 도구 역매핑 (18개 → v3 출처)

각 v4 도구가 흡수하는 v3 도구를 역방향으로 정리합니다.

| v4 도구 | 흡수하는 v3 도구 | 카테고리 |
|---------|-----------------|---------|
| `ai_chat` | `ollama_chat`, `gemini_ask`, `smart_ask`, `translate_text`, `summarize_text`, `extract_keywords`, `explain_code`, `improve_text`, `git_commit_helper`, `generate_commit_message` | AI 대화 |
| `ai_analyze_files` | `ollama_analyze_file`, `ollama_analyze_files`, `gemini_analyze_codebase`, `translate_file` | AI 분석 |
| `ai_compare` | `compare_models` | AI 비교 |
| `agent_debate_start` | `code_review`, `code_discussion` | 에이전트 토론 |
| `agent_debate_status` | `code_review_discuss`, `code_discussion_continue` | 에이전트 토론 |
| `agent_assign_task` | `ollama_agent`, `generate_unit_test`, `add_docstrings` | 에이전트 작업 |
| `agent_task_status` | *(신규 — v3에 대응 없음)* | 에이전트 작업 |
| `workspace_create_review` | `code_review` (일부), `cross_review` (일부) | 워크스페이스 |
| `workspace_request_review` | `cross_review` (일부), `validate_changes` | 워크스페이스 |
| `workspace_add_comment` | *(신규 — v3에 대응 없음)* | 워크스페이스 |
| `workspace_read` | *(신규 — v3에 대응 없음)* | 워크스페이스 |
| `provider_list` | *(신규 — v3에 대응 없음)* | 프로바이더 |
| `provider_health` | `health_check` | 프로바이더 |
| `ollama_models` | `ollama_list_models`, `ollama_show` | Ollama |
| `ollama_pull` | `ollama_pull` | Ollama |
| `memory_search` | `memory_query_graph`, `rag_search`, `rag_ask` | 메모리 |
| `memory_index` | `rag_index` | 메모리 |
| `agestra_setup` | `agestra_setup`, `agestra_system_profile` | 시스템 |

---

## 누락 기능 확인 (Gap Analysis)

v3에서 제공하던 기능 중 v4에서 의도치 않게 빠진 것이 없는지 확인합니다.

### 보존되는 핵심 기능

| 기능 | v3 구현 | v4 보존 방법 |
|------|---------|-------------|
| 서버 사이드 파일 읽기 (토큰 절감) | `ollama_analyze_file`, `translate_file` | `ai_analyze_files`에서 `files` 파라미터로 서버 사이드 읽기 유지 |
| 다중 프로바이더 비교 | `compare_models` (Ollama vs Gemini) | `ai_compare` — N개 프로바이더로 확장 |
| 자율 토론 (멀티 라운드) | `code_review`/`code_discussion` (Gemini only) | `agent_debate_start` — 임의 프로바이더 조합 |
| 규칙 기반 코드 검증 | `cross_review`, `validate_changes` | `workspace_create_review` + `workspace_request_review` |
| 벡터 검색 | `rag_search`, `rag_ask` | `memory_search` — 하이브리드 검색으로 업그레이드 |
| 파일 인덱싱 | `rag_index` | `memory_index` |
| 모델 관리 | `ollama_pull`, `ollama_list_models`, `ollama_show` | `ollama_pull`, `ollama_models` |
| 하드웨어 감지 + 자동 설정 | `agestra_setup`, `agestra_system_profile` | `agestra_setup` |
| 프로바이더 헬스 체크 | `health_check` | `provider_health` |
| LLM 기반 텍스트 처리 | `translate_text`, `summarize_text`, `explain_code` 등 | `ai_chat` (프롬프트로 처리) |
| 에이전트 작업 위임 | `ollama_agent` | `agent_assign_task` + `agent_task_status` |
| 지식 그래프 | `memory_add_node/relation`, `memory_query_graph` | `@agestra/memory` 내부 (자동 엔티티/관계 추출) |
| 임베딩 생성 | `ollama_embeddings` | `@agestra/memory` 내부 (자동 임베딩) |

### Claude Code가 대체하는 기능

| 기능 | v3 구현 | Claude Code 대체 |
|------|---------|-----------------|
| 파일 CRUD | `fs_*` 4개 | Read, Write, Glob, Grep |
| 셸 실행 | `shell_execute` | Bash |
| 환경변수 | `env_get/set`, `dotenv_parse` | Bash |
| Git/GitHub | `gh_*` 3개 | Bash(gh) |
| 프로세스 관리 | `process_*`, `background_*` | Bash |
| Diff | `diff_files/strings` | Bash(diff) |
| SQLite | `sqlite_query` | Bash(sqlite3) |
| 코드 분석 CLI | `check_types`, `run_linter`, `analyze_dependencies`, `find_unused_exports` | Bash(tsc, eslint, npm, grep) |
| TODO 관리 | `todo_manager` | TaskCreate/TaskUpdate |
| 순차 사고 | `think_step` | Claude 자체 extended thinking |
| URL 페치 | `fetch_url` | WebFetch |

### 완전히 삭제되는 기능 (대체 불필요)

| 기능 | v3 구현 | 삭제 사유 |
|------|---------|----------|
| 프롬프트 템플릿 | `prompt_template` | 인메모리 상태, 세션 간 유지 불가, 실용성 낮음 |
| 응답 캐시 | `response_cache` | 인메모리, 세션 간 유지 불가 |
| 토큰 카운트 | `token_count` | 근사치일 뿐, Claude가 자체적으로 토큰 관리 |

### 잠재적 위험 사항

| 위험 | 설명 | 완화 방안 |
|------|------|----------|
| `translate_file` 토큰 절감 | v3에서 서버 사이드 파일 읽기로 99.5% 토큰 절감. v4 `ai_analyze_files`에서 동일 기능을 반드시 유지해야 함 | `ai_analyze_files`의 `files` 파라미터에서 서버 사이드 파일 읽기를 구현 |
| `ollama_agent` 도구 호출 | v3에서 Ollama 도구 호출(ReAct) 기능 제공. v4 `agent_assign_task`에서 동등한 자율 실행 지원 필요 | agents 패키지의 task-delegation에서 도구 호출 루프 구현 |
| `process_kill` 보안 | v3에서 자체 스폰한 프로세스만 kill 허용. Claude Code Bash로 전환 시 제한 없음 | Claude Code 자체 보안 정책에 의존 (수용 가능) |
| v3 `.ai_reviews/` 출력 경로 | v3에서 분석 결과를 `.ai_reviews/`에 저장. v4에서 `.ai_workspace/reviews/`로 변경 | 마이그레이션 가이드에 명시 |
| v3 `.ai_context.md` 메모리 | v3에서 단순 파일 기반 메모리. v4에서 SQLite 기반으로 전환 | 기존 `.ai_context.md` 내용을 `memory_index`로 마이그레이션하는 도구/가이드 제공 |

---

## 결론

- **69개 v3 도구 → 18개 v4 도구**: 75% 감소
- **누락 기능 없음**: 모든 v3 기능이 삭제(Claude Code 대체), 통합(v4 도구), 또는 포팅(패키지 내부)으로 처리됨
- **3개 기능 의도적 삭제**: `prompt_template`, `response_cache`, `token_count` — 실용성 낮아 대체 불필요
- **핵심 가치 보존**: 서버 사이드 파일 읽기(토큰 절감), 멀티 프로바이더 비교, 자율 토론, RAG 검색 등 agestra의 핵심 차별점이 모두 v4에서 유지 또는 강화됨
