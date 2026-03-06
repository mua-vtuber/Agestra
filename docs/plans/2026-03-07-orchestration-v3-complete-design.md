# Orchestration v3 — Complete Multi-AI Orchestration Design

> v2(autopilot pipeline)를 포함하며, 외부 AI 자율 작업, 모드 선택 시스템, tmux CLI 워커를 추가한 완결적 설계.

## Problem

v2에서 해결하지 못한 핵심 갭:

1. **외부 AI가 텍스트 응답만 함** — Codex/Gemini가 "컨설턴트"(질문→답변)로만 동작. 파일을 자율적으로 수정하지 못함
2. **"각자 독립→취합" 모드 없음** — Compare(텍스트 비교)와 Debate(턴 토론)만 존재. "각 AI가 독립 작업 후 진행자가 취합"하는 모드가 없음
3. **실작업 시 사용자 선택 미제공** — "Claude만" vs "다른 AI도 함께" 선택지가 없음
4. **CLI 설치 여부 미체크** — codex/gemini CLI가 있는지, tmux가 있는지 시작 시 확인 안 함
5. **Ollama의 자동 라우팅이 말뿐** — provider-guide에 규칙은 있으나 실제 자동 분배 미구현

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      User Request                           │
├─────────────────────────────────────────────────────────────┤
│  [Hook: UserPromptSubmit] — intent detection                │
├────────────────┬────────────────────────────────────────────┤
│   리뷰/설계/탐색  │              실제 구현 작업                  │
│   (텍스트 작업)   │           (코드 작성 작업)                   │
├────────────────┼────────────────────────────────────────────┤
│                │                                            │
│  ┌───────────┐ │  ┌──────────────────────────────────────┐  │
│  │ Mode      │ │  │ Mode Selection                       │  │
│  │ Selection │ │  │                                      │  │
│  │           │ │  │  1. Claude만으로                       │  │
│  │ 1. Claude │ │  │  2. 다른 AI도 함께 (Team Mode)         │  │
│  │ 2. 각자   │ │  │                                      │  │
│  │ 3. 끝장   │ │  │                                      │  │
│  └───────────┘ │  └──────────────────────────────────────┘  │
│       │        │              │                              │
│       v        │              v                              │
│  ┌──────────┐  │  ┌────────────────────────────────────┐    │
│  │ 기존 MCP  │  │  │ CLI Worker (MCP 서버 확장)          │    │
│  │ tools     │  │  │ + 기존 MCP tools                    │    │
│  │           │  │  │ + Job Manager 확장                   │    │
│  │ ai_compare│  │  │                                    │    │
│  │ debate_*  │  │  │ codex full-auto / gemini full-auto │    │
│  │ ai_chat   │  │  │ ollama agent-loop                  │    │
│  └──────────┘  │  └────────────────────────────────────┘    │
│                │                                            │
├────────────────┴────────────────────────────────────────────┤
│              Agent/Skill Layer (마크다운)                     │
│  team-lead, designer, qa, reviewer, moderator, ideator      │
│  + 새 스킬: worker-manage, environment-check                │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 1: Environment Check (공통 인프라)

### 1.1 MCP 서버 도구 추가: `environment_check`

시작 시 또는 요청 시 실행 가능한 환경 점검 도구.

**반환 스키마:**
```json
{
  "providers": {
    "ollama": {
      "available": true,
      "models": [
        {"name": "llama3.2:3b", "size_gb": 2.0, "tier": "simple"},
        {"name": "qwen2.5-coder:14b", "size_gb": 9.2, "tier": "complex"}
      ]
    },
    "gemini": {
      "available": true,
      "cli_path": "/usr/local/bin/gemini",
      "autonomous_capable": true
    },
    "codex": {
      "available": true,
      "cli_path": "/usr/local/bin/codex",
      "autonomous_capable": true
    }
  },
  "infrastructure": {
    "tmux": {
      "available": true,
      "path": "/usr/bin/tmux"
    },
    "git": {
      "available": true,
      "worktree_support": true
    }
  },
  "capabilities": {
    "can_autonomous_work": true,
    "can_tmux_visible": true,
    "can_parallel_workers": true,
    "max_parallel_workers": 3,
    "available_modes": ["claude_only", "independent", "debate", "team"]
  }
}
```

**구현 위치:** `packages/mcp-server/src/tools/environment.ts`

**동작:**
1. `which codex`, `which gemini`, `which tmux` 실행
2. `ollama_models` 내부 호출
3. 기존 `provider_list` 결과와 합산
4. CLI가 autonomous mode를 지원하는지 버전 체크
5. 결과를 캐시 (세션당 1회, 수동 재체크 가능)

### 1.2 Ollama 모델 티어 자동 분류

기존 `ollama_models`의 size 정보를 활용하여 자동 분류:

```
< 3 GB  → tier: "simple"   — 포맷팅, 패턴 치환, 단순 변환
3-8 GB  → tier: "moderate"  — 코드 리뷰, 요약, 단순 분석
8-20 GB → tier: "complex"   — 코드 생성, 상세 분석
> 20 GB → tier: "advanced"  — 아키텍처, 복잡 리팩토링
```

team-lead가 태스크 라우팅 시 이 tier를 참조.

---

## Part 2: 리뷰/설계/아이디어 — 3가지 모드 (에이전트/스킬 레이어)

### 2.1 모드 정의

기존 3가지 → 새 3가지:

| 기존 | 새 이름 | 동작 변경 |
|------|---------|----------|
| Claude only | **Claude only** | 변경 없음. 플러그인 전문 에이전트 사용 |
| Compare | **각자 독립** | 텍스트 비교가 아닌 독립 작업 후 진행자 취합 |
| Debate | **끝장토론** | 각자 독립 + 문서 라운드 리뷰 반복 |

### 2.2 Mode: Claude Only

```
User → /agestra review [target]
         │
         v
     [agestra-reviewer 스폰]
         │
         v
     결과 보고
```

변경 없음. 기존 그대로.

### 2.3 Mode: 각자 독립 (Independent → Aggregate)

```
User → /agestra review [target]  → "각자 독립" 선택
         │
         v
     [Phase 1: 독립 작업]
     ┌─────────────────────────────────────────────┐
     │  Claude: agestra-reviewer 스폰 → 분석 결과    │
     │  Gemini: ai_chat(provider: gemini) → 분석 결과 │  ← 병렬 실행
     │  Codex:  ai_chat(provider: codex) → 분석 결과  │
     │  Ollama: ai_chat(provider: ollama) → 분석 결과 │
     └─────────────────────────────────────────────┘
         │
         v
     [Phase 2: 진행자 취합]
     agestra-moderator 스폰:
       - 모든 분석 결과를 입력으로 받음
       - 합의점, 차이점, 고유 발견 분류
       - 통합 문서 생성
         │
         v
     사용자에게 통합 문서 보고
```

**핵심 차이 (기존 Compare와):**
- 기존 Compare: `ai_compare` 한 번 호출 → 서버가 응답 합쳐서 돌려줌
- 새 각자 독립: Claude의 전문 에이전트가 실제 작업 + 외부 AI들도 독립 작업 + moderator가 취합

**구현:**
- 커맨드에서 Claude 전문 에이전트와 외부 AI `ai_chat` 호출을 **병렬 Agent 호출**로 실행
- 모든 결과를 모아서 moderator에게 전달
- moderator가 통합 문서 생성

### 2.4 Mode: 끝장토론 (Debate Until Consensus)

```
User → /agestra review [target]  → "끝장토론" 선택
         │
         v
     [Phase 1: 독립 작업] (각자 독립과 동일)
         │
         v
     [Phase 2: 진행자 취합 → 초안 문서 생성]
         │
         v
     [Phase 3: 문서 라운드 리뷰]
     ┌──────────────────────────────────────────────────────┐
     │  Round N:                                            │
     │                                                      │
     │  1. 진행자(moderator)가 현재 문서를 각 AI에게 전달     │
     │                                                      │
     │  2. 각 AI가 문서를 분석하고 피드백 작성:               │
     │     - Claude: 전문 에이전트 스폰 → 분석 + 피드백       │
     │     - Gemini: agent_debate_turn(gemini) → 피드백      │
     │     - Codex: agent_debate_turn(codex) → 피드백        │
     │     - Ollama: agent_debate_turn(ollama) → 피드백      │
     │                                                      │
     │  3. 진행자가 피드백 수집:                              │
     │     - 동의/반대 분류                                   │
     │     - 반대 의견을 문서에 반영하여 수정                   │
     │                                                      │
     │  4. 합의 판정:                                        │
     │     - 모든 AI가 동의 → Phase 4로                      │
     │     - 반대 있음 → 수정된 문서로 다음 라운드             │
     │     - 5라운드 후에도 합의 안 됨 → 분열 의견 정리 후 종료 │
     └──────────────────────────────────────────────────────┘
         │
         v
     [Phase 4: 최종 문서]
     진행자가 최종 합의 문서를 사용자에게 보고.
     합의 안 된 항목이 있으면 분열 의견도 함께 표시.
```

**기존 Debate와의 차이:**
- 기존: `agent_debate_turn`으로 턴 토론. 텍스트 주고받기
- 새: **문서 중심**. 문서가 생성되고, 각 AI가 문서를 분석/피드백, 문서가 수정되며 수렴
- 기존: Claude 턴에서 specialist perspective를 참조만 함
- 새: Claude 턴에서 **전문 에이전트를 실제 스폰**하여 분석 (v2 moderator fix 적용)

### 2.5 커맨드 수정 (review, design, idea 공통)

3개 커맨드의 Step 3 선택지 변경:

```markdown
## Step 3: Present choices

Use AskUserQuestion to present these options (in the user's language):

| Option | Description |
|--------|-------------|
| **Claude only** | 플러그인 전문 에이전트가 단독 작업 |
| **각자 독립** | 각 AI가 독립 작업 후 진행자가 취합하여 문서 작성 |
| **끝장토론** | 각자 독립 + 문서를 돌아가며 분석/피드백, 모두 동의할 때까지 |
```

---

## Part 3: 실제 구현 작업 — 2가지 모드

### 3.1 작업 시작 전 선택

team-lead가 Phase 2 (Task Design) 진입 시, 사용 가능한 외부 AI가 있으면 선택지를 제공:

```markdown
### Work Mode Selection

After environment_check, if external providers are available:

Use AskUserQuestion:

| Option | Description |
|--------|-------------|
| **Claude만으로** | Claude가 직접 작업. 프로젝트/전역 에이전트 활용 |
| **다른 AI도 함께** | CLI AI는 자율 작업, Ollama는 단순 작업, Claude가 팀장으로 감독 |

If no external providers available: skip selection, proceed with Claude only.
In autonomous mode: auto-select based on task complexity.
  - 단순 (1-2 파일, 명확한 변경) → Claude만
  - 복잡 (3+ 파일, 다중 컴포넌트) → 다른 AI도 함께 (외부 가능 시)
```

### 3.2 Mode: Claude만으로

기존 team-lead Phase 3 (Parallel Execution) 그대로. Claude가 직접 코드 작성. 적절한 프로젝트/전역 에이전트 사용.

### 3.3 Mode: 다른 AI도 함께 (Team Mode)

```
team-lead: Phase 2 (Task Design)
    │
    ├─ 태스크 분해
    ├─ 각 태스크에 AI 할당:
    │   ┌──────────────────────────────────────────────────┐
    │   │  태스크 복잡도/성격에 따라 분배:                    │
    │   │                                                  │
    │   │  복잡한 구현, 다단계 추론 → Codex/Gemini CLI 워커  │
    │   │  단순 변환, 포맷팅, 패턴 적용 → Ollama             │
    │   │  설계 판단 필요한 핵심 작업 → Claude 직접           │
    │   │  테스트 작성, 리뷰 → Claude 에이전트               │
    │   └──────────────────────────────────────────────────┘
    │
    v
team-lead: Phase 3 (Parallel Execution)
    │
    ├─ [Claude 작업] — 직접 코드 작성 또는 에이전트 스폰
    │
    ├─ [CLI Worker: Codex] ─────────────────────────────┐
    │   cli_worker_spawn(provider: codex,                │
    │     task: "auth 모듈 리팩토링",                     │
    │     working_dir: "/project",                       │
    │     worktree: "worker-codex-auth",                 │
    │     prompt_file: ".agestra/.workers/codex-1.md")   │
    │                                                    │
    │   Codex CLI가 프로젝트에서 자율 작업:                │
    │   - 파일 읽기/수정                                  │
    │   - 빌드/테스트 실행                                │
    │   - 완료 시 결과를 output 파일에 기록                │
    │                                                    │
    ├─ [CLI Worker: Gemini] ────────────────────────────┐│
    │   (동일 패턴, 다른 태스크)                          ││
    │                                                    ││
    ├─ [Ollama] ────────────────────────────────────────┐││
    │   ai_chat(provider: ollama, prompt: "단순 작업")   │││
    │   텍스트 응답만 → Claude가 적용                     │││
    │                                                    │││
    └────────────────────────────────────────────────────┘││
         │                                                ││
         v                                                ││
team-lead: 주기적 상태 체크 ←─────────────────────────────┘│
    │   cli_worker_status(worker_id) → 진행 상태            │
    │   완료 감지 시 cli_worker_collect(worker_id) → 결과    │
    │                                                       │
    v                                                       │
team-lead: Phase 4 (Result Inspection) ←────────────────────┘
    │   각 워커의 git diff 검토
    │   Claude 작업 결과와 통합
    │   충돌 해결
    v
Phase 5-7 (QA Cycle → Quality Gate → Report)  [v2 그대로]
```

### 3.4 CLI Worker 격리: Git Worktree

각 CLI 워커는 **별도 git worktree**에서 작업하여 파일 충돌 방지:

```
main branch (Claude 작업)
  ├─ worktree: .agestra/.worktrees/worker-codex-auth/   (branch: agestra-worker/codex-auth)
  ├─ worktree: .agestra/.worktrees/worker-gemini-api/   (branch: agestra-worker/gemini-api)
  └─ worktree: .agestra/.worktrees/worker-codex-test/   (branch: agestra-worker/codex-test)
```

**라이프사이클:**
1. 스폰 전: `git worktree add .agestra/.worktrees/{name} -b agestra-worker/{name}`
2. CLI 워커가 worktree 디렉토리에서 실행
3. 완료 후: `git diff agestra-worker/{name}...main`으로 변경 검토
4. Merge Strategy 적용 (아래 참조)
5. 정리: `git worktree remove .agestra/.worktrees/{name}` + branch 삭제

**Merge Strategy (3-Way Merge):**

> 토론 합의: "Claude가 해결" 단독 전략 폐기. 자동+수동 하이브리드.

```
1. Detection — 충돌 가능성 사전 탐지
   - 모든 active worker의 files_changed를 수집
   - 파일 겹침(overlap) 감지: 2+ worker가 같은 파일을 수정했는가?
   - 겹침 없음 → 순차 merge (안전)

2. Native 3-Way Merge — 겹침 있을 때
   git merge-file로 3-way merge 시도

3. 자동해결 허용 규칙 (safe auto-resolution):
   - 비중첩 hunk (다른 라인 영역 수정)
   - 기계적 포맷 차이 (줄바꿈, 공백, trailing comma)
   - import 추가 (중복 없는 경우)
   - 이외: 자동해결 금지

4. 수동 해결 — 자동해결 불가 시
   - moderator 태스크로 승격
   - moderator가 충돌 diff + 양쪽 task-manifest를 입력받아 해결안 제시
   - supervised 모드: 사용자에게 해결안 확인 요청
   - autonomous 모드: moderator 해결안 자동 적용 (단, 10줄 이상 충돌은 사용자 확인)
```

**Recovery (Crash/Timeout 복구):**

> 토론 합의: 오케스트레이터 재시작 시 상태 재구성 절차 명문화.

```
오케스트레이터(MCP 서버) 재시작 시:
1. .agestra/.workers/ 디렉토리 스캔
2. 각 worker의 status.json 읽기
3. 상태 재구성:
   - PID 생존 확인 (kill -0 pid)
   - tmux 세션 확인 (tmux has-session)
   - worktree 존재 확인 (git worktree list)
   - heartbeat 파일 타임스탬프 확인
4. 판정:
   - PID 생존 + heartbeat 정상 → RUNNING 복원
   - PID 사망 + exit code 있음 → COLLECTING 전이
   - PID 사망 + exit code 없음 → FAILED (crash)
   - worktree 손상 → FAILED + cleanup
5. FAILED worker에 대해: transient 판정 + retry_count 확인 → 재시도 또는 최종 FAILED

Worktree 정리 실패 처리:
- git worktree remove 실패 시: git worktree remove --force
- force도 실패 시: 수동 정리 경고 + 경로 기록
- 다음 environment_check 시 orphan worktree 탐지 및 정리 제안
```

**Responsibility Separation:**

> 토론 합의: team-lead와 cli-worker-manager의 책임 경계 명확화.

| 책임 | team-lead (에이전트) | cli-worker-manager (TypeScript) |
|------|---------------------|-------------------------------|
| 태스크 분해 | O | - |
| AI 할당 결정 | O | - |
| 병합 정책 결정 | O | - |
| 프로세스 스폰/중단 | - | O |
| 상태 추적/heartbeat | - | O |
| worktree 생성/정리 | - | O |
| diff 수집 | - | O |
| 충돌 감지 | - | O |
| 충돌 해결 판단 | O (moderator 위임) | - |
| QA 라우팅 | O | - |

---

## Part 4: MCP 서버 확장 (실제 코드 변경)

### 4.1 새 모듈: `cli-worker.ts`

**도구 4개 추가:**

| 도구 | 설명 |
|------|------|
| `cli_worker_spawn` | CLI AI를 autonomous 모드로 스폰. worktree 생성 + preflight 보안 검증 포함 |
| `cli_worker_status` | 워커 진행 상태 (FSM 기반, heartbeat 포함) |
| `cli_worker_collect` | 완료된 워커의 결과 수집 (git diff, output, exit code) |
| `cli_worker_stop` | 워커 강제 중단 (SIGTERM → SIGKILL) + worktree 정리 |

#### 4.1.1 Worker Finite State Machine (FSM)

> 토론 합의: Codex 전이 규칙 방식 채택 (독립 RECOVERING 상태 X)

```
SPAWNING ──→ RUNNING ──→ COLLECTING ──→ COMPLETED
    │            │              │
    │            ├──→ CANCELLING ──→ CANCELLED
    │            │
    │            ├──→ TIMEOUT ──→ FAILED
    │            │
    │            └──→ FAILED
    │                    │
    │                    └──→ SPAWNING  (if transient && retry_count < 1)
    │
    └──→ FAILED  (spawn failure)
```

**상태 정의:**

| 상태 | 진입 조건 | 탈출 조건 |
|------|----------|----------|
| `SPAWNING` | cli_worker_spawn 호출 또는 transient 재시도 | 프로세스 시작 확인 → RUNNING / 실패 → FAILED |
| `RUNNING` | 프로세스 PID 확인 | 프로세스 종료 → COLLECTING / heartbeat 누락 → TIMEOUT / 사용자 중단 → CANCELLING |
| `COLLECTING` | 프로세스 정상 종료 (exit 0) | diff 수집 완료 → COMPLETED / 수집 실패 → FAILED |
| `COMPLETED` | diff + output 수집 완료 | 종료 상태 |
| `FAILED` | 비정상 종료, 스폰 실패, 수집 실패 | transient + retry < 1 → SPAWNING / 종료 상태 |
| `CANCELLING` | cli_worker_stop 호출 | SIGTERM 전송 → 5초 대기 → SIGKILL → CANCELLED |
| `CANCELLED` | 강제 중단 완료 | 종료 상태 (worktree 정리) |
| `TIMEOUT` | heartbeat_interval × 3 동안 heartbeat 없음 또는 lease 만료 | → FAILED (정리 후) |

**Heartbeat & Lease:**
- Worker가 `.agestra/.workers/{id}/heartbeat` 파일에 주기적 타임스탬프 기록
- `heartbeat_interval`: 기본 10초 (Open Question #4)
- `lease_timeout`: 기본 `timeout_minutes` 값 사용
- 오케스트레이터가 30초마다 체크: heartbeat 누락 시 TIMEOUT 전이

#### 4.1.2 Security (블로킹 요구사항)

> 토론 합의: CRITICAL 2건 + HIGH 1건 해결. 모두 블로킹.

**Command Injection 방지:**
```typescript
// 금지: string interpolation
// tmux split-window -h "cd ${dir} && codex exec ..."

// 필수: 배열 기반 인자 전달
const tmuxArgs = ['split-window', '-h', '-c', worktreeDir];
const cliArgs = [providerBin, 'exec', '--full-auto', '-f', manifestPath];
execFileSync('tmux', [...tmuxArgs, cliArgs.join(' ')]);
// 또는 tmux send-keys 방식으로 분리 실행
```

**Secret Masking (Preflight Gate):**
```
cli_worker_spawn 호출 시:
1. task-manifest.json 생성
2. SecretScanner.scan(manifest) — 내장 스캐너
   - 패턴: API key, token, password, credential, private key
   - 환경변수 참조 ($ENV_VAR) → 허용
   - 리터럴 시크릿 발견 → spawn 차단 + 경고 반환
3. 통과 시에만 프로세스 스폰
```

**Path Isolation (Sandbox):**
- Worker는 자신의 worktree 디렉토리 외부 접근 금지
- 기존 `path-guard.ts`의 `isPathAllowed()` 재사용
- CLI 스폰 시 환경변수로 제한: `AGESTRA_SANDBOX_ROOT={worktree_path}`
- Sandbox 위반 감지 시: 해당 worker만 중단 (Open Question #5)

**`cli_worker_spawn` 파라미터:**
```typescript
interface CliWorkerSpawnArgs {
  provider: "codex" | "gemini";       // 어떤 CLI
  task_description: string;            // 무엇을 할 것인가
  working_dir: string;                 // 프로젝트 루트
  files_to_read?: string[];            // 참고할 파일 목록 (readonly)
  files_to_modify?: string[];          // 수정할 파일 범위 (readwrite)
  constraints?: string;                // 하지 말아야 할 것
  success_criteria?: string[];         // 성공 검증 명령 (예: "npm test -- src/auth")
  use_worktree?: boolean;              // git worktree 격리 (기본: true)
  use_tmux?: boolean;                  // tmux pane 사용 (기본: auto-detect)
  timeout_minutes?: number;            // 타임아웃 (기본: 10)
}
```

#### 4.1.3 Task Manifest

> 토론 합의: prompt.md → task-manifest.json 전환

**`cli_worker_spawn` 내부 동작:**

```
1. Preflight Security Gate
   - SecretScanner.scan(task_description, constraints)
   - 실패 시 즉시 반환: { error: "secret_detected", details: [...] }

2. worktree 생성 (use_worktree=true 시)
   git worktree add .agestra/.worktrees/{name} -b agestra-worker/{name}

3. Task Manifest 작성: .agestra/.workers/{worker_id}/task-manifest.json
   {
     "task": task_description,
     "files": {
       "readonly": files_to_read,
       "readwrite": files_to_modify
     },
     "constraints": constraints,
     "success_criteria": success_criteria,
     "permissions": {
       "sandbox_root": worktree_path,
       "allowed_commands": ["npm", "node", "git", "tsc"]
     },
     "timeout_minutes": timeout_minutes
   }

4. CLI 스폰 (배열 기반, injection-safe):
   tmux 있고 use_tmux=true:
     execFile('tmux', ['split-window', '-h', '-c', worktreeDir,
       providerBin, 'exec', '--full-auto', '-f', 'task-manifest.json'])
   tmux 없음:
     spawn(providerBin, ["exec", "--full-auto", "-f", "task-manifest.json"], {
       cwd: worktree_dir,
       detached: true,
       stdio: ["ignore", output_fd, error_fd]
     })

5. worker 상태 파일 생성: .agestra/.workers/{worker_id}/status.json
   { id, provider, state: "SPAWNING", pid, worktree_path, started_at,
     retry_count: 0, heartbeat_interval: 10 }

6. PID 확인 후 state → "RUNNING"

7. 반환: { worker_id, pid, worktree_path, state: "RUNNING" }
```

**`cli_worker_status` 반환:**
```json
{
  "worker_id": "codex-auth-abc123",
  "state": "RUNNING",
  "provider": "codex",
  "elapsed_seconds": 45,
  "last_heartbeat": "2026-03-07T12:00:45Z",
  "output_tail": "... last 20 lines of stdout ...",
  "files_changed": ["src/auth/login.ts", "src/auth/session.ts"],
  "worktree_branch": "agestra-worker/codex-auth",
  "retry_count": 0
}
```

**`cli_worker_collect` 반환:**
```json
{
  "worker_id": "codex-auth-abc123",
  "state": "COMPLETED",
  "exit_code": 0,
  "output_full": "... complete stdout ...",
  "git_diff": "... full diff against main ...",
  "files_changed": ["src/auth/login.ts", "src/auth/session.ts"],
  "files_created": [],
  "files_deleted": [],
  "worktree_branch": "agestra-worker/codex-auth",
  "success_criteria_results": [
    { "command": "npm test -- src/auth", "exit_code": 0, "passed": true }
  ]
}
```

### 4.2 기존 모듈 확장: `environment.ts`

`provider-manage.ts`에 `environment_check` 도구 추가 (또는 별도 모듈).
Part 1.1의 스키마 그대로 구현.

### 4.3 기존 Job Manager와의 관계

새 CLI Worker는 Job Manager를 **확장하지 않고 별도로** 구현:

| 항목 | Job Manager | CLI Worker |
|------|------------|------------|
| 목적 | 비동기 MCP 작업 실행 | CLI AI의 자율 코딩 |
| 프로세스 | 짧은 작업 (API 호출 등) | 장시간 자율 작업 (분 단위) |
| 파일 접근 | 없음 (텍스트 I/O만) | worktree에서 자율적 파일 수정 |
| 결과 | 텍스트 output | git diff + 파일 변경 목록 |
| 상태 추적 | `.agestra/.jobs/` | `.agestra/.workers/` |

이유: Job Manager는 "작업 제출 → 결과 수집"의 단순 패턴. CLI Worker는 git worktree 관리, 파일 변경 추적, tmux 통합, FSM 상태 관리, heartbeat/lease, 보안 sandbox 등 훨씬 복잡한 라이프사이클을 가짐.

**구현 모듈:** `packages/core/src/cli-worker-manager.ts`
- CliWorkerManager 클래스: 워커 생성/추적/정리의 단일 책임
- team-lead 에이전트는 CliWorkerManager에 "무엇을"만 지시, "어떻게"는 manager가 결정

---

## Part 5: 에이전트/스킬 변경 상세

### 5.1 team-lead 변경

Phase 0 (Clarity Gate)과 Phase 5-7 (QA Cycle, Quality Gate, Report)는 v2 그대로 유지.

**Phase 1 (Situation Assessment) 확장:**
```markdown
### Phase 1: Situation Assessment

1. Call `environment_check` to get full capability map.
2. Call `provider_list` for provider availability.
3. Read existing design documents in `docs/plans/`.
4. Store environment capabilities for later mode selection:
   - can_autonomous_work: CLI workers available?
   - available_providers: which are online?
   - ollama_tiers: model size classifications
```

**Phase 2 (Task Design) 확장:**
```markdown
### Phase 2: Task Design

1. If external providers available, present work mode selection:
   - "Claude만으로" / "다른 AI도 함께"
   - In autonomous mode: auto-select based on complexity

2. Decompose tasks (existing logic).

3. If "다른 AI도 함께" selected, route each task:

   | Task Characteristics | Route To |
   |---------------------|----------|
   | 복잡 구현, 다단계 | Codex/Gemini CLI worker (cli_worker_spawn) |
   | 단순 변환, 포맷팅 | Ollama (ai_chat, tier-matched model) |
   | 핵심 설계 판단 | Claude 직접 |
   | 테스트 작성 | Claude 에이전트 (tester) |
   | 코드 리뷰 | Claude 에이전트 (reviewer) |

4. Present distribution plan to user (supervised) or proceed (autonomous).
```

**Phase 3 (Parallel Execution) 확장:**
```markdown
### Phase 3: Parallel Execution

Execute in parallel:
- Claude tasks: direct implementation or agent spawn
- CLI Worker tasks: cli_worker_spawn for each
- Ollama tasks: ai_chat calls, Claude applies results

Monitor loop:
- Every 30 seconds: cli_worker_status for each active worker
- On worker completion: cli_worker_collect, review diff
- On worker failure: log error, re-route to different provider or Claude

Worker result integration:
- Review git diff from each worktree
- Check for conflicts between workers
- If clean: git merge --no-ff each worker branch
- If conflict: resolve manually or re-assign
```

### 5.2 커맨드 수정 (review.md, design.md, idea.md)

3개 커맨드 모두 동일한 패턴으로 수정:

```markdown
## Step 3: Present choices

Call `environment_check` to determine available modes.

Use AskUserQuestion to present these options (in the user's language):

| Option | Condition | Description |
|--------|-----------|-------------|
| **Claude only** | Always | 플러그인 전문 에이전트가 단독 작업 |
| **각자 독립** | 1+ provider available | 각 AI가 독립 작업 → 진행자가 취합하여 문서 작성 |
| **끝장토론** | 1+ provider available | 각자 독립 + 문서를 돌아가며 분석/피드백, 모두 동의까지 |

If no providers available, skip and run Claude only.

## Step 4: Execute based on selection

### If "Claude only":
(기존과 동일 — 전문 에이전트 스폰)

### If "각자 독립":
1. Spawn specialist agent (agestra-reviewer/designer/ideator) for Claude's work.
2. In parallel, call `ai_chat` for each available provider with the same task prompt.
3. Collect all results.
4. Spawn `agestra-moderator` with ALL results as input:
   - Moderator classifies: agreements, disagreements, unique findings
   - Moderator generates integrated document
5. Present integrated document to user.

### If "끝장토론":
1. Execute "각자 독립" Phase 1-2 (independent work + initial aggregation).
2. Document review rounds (max 5):
   a. Moderator sends current document to each AI:
      - Claude: spawn specialist agent → analyze document → write feedback
      - Others: agent_debate_turn(provider, claude_comment: null) with document as prompt
   b. Moderator collects all feedback.
   c. Classify: agree/disagree per section.
   d. Revise document incorporating disagreement feedback.
   e. If all agree on all sections → consensus reached.
   f. If not → next round with revised document.
3. Present final document:
   - Consensus sections: marked as agreed
   - Disputed sections: show split positions
```

### 5.3 moderator 변경

v2에서 specialist agent spawn을 추가했으나, 새 모드들을 지원하도록 추가 확장:

```markdown
### Mode: Independent Aggregation

When invoked for "각자 독립" mode:

Input: array of results from all AIs (including Claude's specialist agent output)

Process:
1. Read all results
2. Identify common findings (mentioned by 2+ AIs)
3. Identify unique findings (mentioned by 1 AI only)
4. Identify contradictions (AIs disagree)
5. Generate integrated document:

   ## Integrated Analysis

   ### Consensus Findings (agreed by all/most)
   - [finding] — agreed by: Claude, Gemini, Codex

   ### Notable Findings (unique perspectives)
   - [finding] — source: Gemini (unique insight)

   ### Disputed Points
   - [topic]: Claude says X, Codex says Y

   ### Summary
   [unified recommendation considering all perspectives]

### Mode: Document Review Round

When invoked for "끝장토론" document review:

Input: current document + feedback from all AIs

Process:
1. For each section of the document:
   - Count agree/disagree from each AI
   - If disagreement: extract the specific objection and proposed revision
2. Revise disputed sections incorporating feedback
3. Track consensus status per section:
   { "section": "Security", "status": "agreed", "round": 3 }
4. Return: revised document + consensus map
```

### 5.4 새 스킬: `worker-manage.md`

```markdown
---
name: worker-manage
description: >
  Use when managing CLI worker processes — checking status, collecting results,
  stopping workers, or viewing active workers. Triggers on: "worker status",
  "check workers", "stop worker", "worker results".
---

Wraps cli_worker_spawn, cli_worker_status, cli_worker_collect, cli_worker_stop
into user-friendly operations.

## Operations

### List Active Workers
Call cli_worker_status for all workers in .agestra/.workers/.
Present: worker_id, provider, elapsed time, files changed, status.

### Collect Results
Call cli_worker_collect for a completed worker.
Show git diff summary, files changed, output.
Ask: merge to main? review first? reject?

### Stop Worker
Call cli_worker_stop for a specific worker or all.
Clean up worktree.
```

---

## Part 6: 전체 흐름 — 예상 동작 매핑

사용자가 정의한 예상 동작과 설계의 매핑:

### 예상 1: 실행시 설치된 CLI와 Ollama 체크

```
Session start → environment_check 자동 호출
  → codex CLI: found at /usr/local/bin/codex
  → gemini CLI: found at /usr/local/bin/gemini
  → tmux: found at /usr/bin/tmux
  → ollama: 2 models (llama3.2:3b [simple], qwen2.5-coder:14b [complex])
  → capabilities: { can_autonomous_work: true, available_modes: all 4 }
```

### 예상 2: 설치된 AI에 맞춰 도구 활성화

```
environment_check 결과에 따라:
  - codex 있음 → cli_worker_spawn(codex) 사용 가능
  - gemini 있음 → cli_worker_spawn(gemini) 사용 가능
  - ollama 있음 → ai_chat(ollama) + tier-based routing
  - tmux 있음 → CLI workers를 tmux pane에서 실행 (가시성)
  - 아무것도 없음 → Claude only 모드만 제공
```

### 예상 3: 리뷰/설계/아이디어 시 질문

```
User: "/agestra review src/auth/"
  → environment_check: codex + gemini + ollama available
  → AskUserQuestion:
    1. Claude only — agestra-reviewer가 단독 리뷰
    2. 각자 독립 — 각 AI가 독립 리뷰 후 moderator가 취합
    3. 끝장토론 — 각자 독립 + 문서 라운드 리뷰, 모두 동의까지
```

### 예상 3-1a: Claude only

```
  → agestra-reviewer 스폰
  → 7점 체크리스트 + TRUST 5 검증
  → 결과 보고
```

### 예상 3-1b: 각자 독립

```
  → [병렬] Claude: agestra-reviewer 스폰
           Gemini: ai_chat("src/auth/ 리뷰해줘")
           Codex: ai_chat("src/auth/ 리뷰해줘")
           Ollama: ai_chat("src/auth/ 리뷰해줘")
  → 4개 결과 수집
  → agestra-moderator 스폰: 취합 → 통합 문서 생성
  → 사용자에게 보고
```

### 예상 3-1c: 끝장토론

```
  → [Phase 1] 각자 독립과 동일 (독립 작업 + 초안 문서)
  → [Phase 2] Round 1:
       moderator가 문서를 각 AI에게 전달
       Claude: agestra-reviewer 스폰 → 문서 분석 → 피드백
       Gemini: agent_debate_turn → 피드백
       Codex: agent_debate_turn → 피드백
       Ollama: agent_debate_turn → 피드백
       moderator: 피드백 수집 → 문서 수정
       합의 체크: Gemini 반대 (보안 항목에 추가 의견)
  → [Phase 2] Round 2:
       수정된 문서로 재검토
       모든 AI 동의
  → 최종 문서 사용자에게 보고
```

### 예상 4: 실작업 시 질문

```
User: "auth 모듈 리팩토링해줘"
  → team-lead 스폰
  → Phase 0: Clarity Gate (designer 모호성 채점)
  → Phase 1: environment_check → providers available
  → Phase 2: AskUserQuestion:
    1. Claude만으로 — Claude가 직접 리팩토링
    2. 다른 AI도 함께 — CLI AI가 자율 작업, Claude가 감독
```

### 예상 4-1a: Claude만으로

```
  → Claude가 직접 코드 수정
  → 적절한 에이전트 사용 (tester, reviewer 등)
```

### 예상 4-1b: 다른 AI도 함께

```
  → team-lead: 태스크 분해
    Task 1: auth/login.ts 리팩토링 → Codex CLI worker
    Task 2: auth/session.ts 리팩토링 → Gemini CLI worker
    Task 3: auth/types.ts 타입 정리 → Ollama (단순, tier=simple 모델로)
    Task 4: 테스트 업데이트 → Claude 직접
    Task 5: 통합 테스트 → Claude 직접

  → [병렬 실행]
    Codex: tmux pane에서 login.ts 자율 작업 (worktree 격리)
    Gemini: tmux pane에서 session.ts 자율 작업 (worktree 격리)
    Ollama: ai_chat으로 types.ts 변경 제안 → Claude가 적용
    Claude: 테스트 작성 시작

  → team-lead: 30초마다 worker 상태 체크
    "Codex worker: 45초 경과, 2개 파일 변경 중..."
    "Gemini worker: 완료! diff 검토 중..."

  → 모든 작업 완료 후:
    각 worktree의 diff 검토
    충돌 없으면 merge
    충돌 있으면 Claude가 해결

  → Phase 5: QA Cycle (v2 그대로)
  → Phase 6: Quality Gate — TRUST 5 (v2 그대로)
  → Phase 7: Report
```

### 예상 4-2: QA 진행

```
  → agestra-qa 스폰: 설계 문서 대비 검증
    FAIL 시 → QA Fix Loop (v2): 다른 provider로 즉시 교체 + 풀 컨텍스트
    PASS 시 → agestra-reviewer: TRUST 5 Quality Gate
    통과 시 → 완료 보고
```

---

## Part 7: 구현 범위 요약

### MCP 서버 (TypeScript 코드)

| 파일 | 변경 | Phase | 내용 |
|------|------|-------|------|
| `packages/mcp-server/src/tools/environment.ts` | **새 파일** | A | environment_check 도구 |
| `packages/core/src/secret-scanner.ts` | **새 파일** | A | 내장 시크릿 스캐너 + preflight gate |
| `packages/core/src/worktree-manager.ts` | **새 파일** | A | git worktree 생성/정리/orphan 탐지 |
| `packages/core/src/file-change-tracker.ts` | **수정** | A | execGit 에러 묵살 버그 수정 |
| `packages/core/src/provider-capability.ts` | **수정** | A | Ollama 모델 사이즈 기반 자동 분류 |
| `packages/core/src/cli-worker-manager.ts` | **새 파일** | B | FSM, heartbeat/lease, 프로세스 관리, tmux 통합 |
| `packages/core/src/task-manifest.ts` | **새 파일** | B | task-manifest.json 생성/검증 |
| `packages/mcp-server/src/tools/cli-worker.ts` | **새 파일** | B | cli_worker_spawn/status/collect/stop 4개 도구 |
| `packages/mcp-server/src/server.ts` | **수정** | B | 새 모듈 등록 |

### 에이전트 (마크다운)

| 파일 | 변경 | Phase | 내용 |
|------|------|-------|------|
| `agents/agestra-team-lead.md` | **수정** | C | 환경체크, 작업 모드 선택, CLI worker 통합, 모니터 루프 |
| `agents/agestra-moderator.md` | **수정** | C | 독립 취합 모드, 문서 라운드 리뷰 모드, 충돌 해결 모드 추가 |

### 커맨드 (마크다운)

| 파일 | 변경 | Phase | 내용 |
|------|------|-------|------|
| `commands/review.md` | **수정** | C | 3가지 모드 (Claude only/각자 독립/끝장토론) |
| `commands/design.md` | **수정** | C | 동일 |
| `commands/idea.md` | **수정** | C | 동일 |

### 스킬 (마크다운)

| 파일 | 변경 | Phase | 내용 |
|------|------|-------|------|
| `skills/worker-manage.md` | **새 파일** | C | CLI 워커 관리 유틸리티 |
| `skills/provider-guide.md` | **수정** | C | 새 모드, 환경체크, 워커 관련 업데이트 |
| `skills/cancel.md` | **수정** | C | cli_worker 상태 감지 추가 |

---

## Part 8: Staged Rollout

> 토론 합의: 전체를 한 번에 구현하지 않고 3단계로 나누어 배포.

### Phase A: Infrastructure (기반)
1. `environment_check` MCP 도구 구현
2. tmux wrapper (배열 기반, injection-safe)
3. git worktree 관리 유틸리티 (생성/정리/orphan 탐지)
4. SecretScanner 내장 스캐너 + preflight gate
5. 기존 버그 선행 수정:
   - `file-change-tracker.ts:197-208` execGit 에러 묵살
   - `provider-capability.ts` Ollama 모델 사이즈 기반 자동 분류

### Phase B: Orchestration Core (핵심)
1. Worker FSM 구현 (7개 상태 + 전이 규칙)
2. Heartbeat + Lease 만료 메커니즘
3. Task Manifest (task-manifest.json) 생성기
4. `cli_worker_spawn/status/collect/stop` 4개 MCP 도구
5. Recovery 절차 (오케스트레이터 재시작 시 상태 재구성)

### Phase C: Integration (통합)
1. Team Mode — team-lead의 작업 모드 선택 + CLI worker 통합
2. 3-way merge + moderator conflict resolution
3. 리뷰 3가지 모드 (Claude only / 각자 독립 / 끝장토론)
4. 커맨드 수정 (review.md, design.md, idea.md)
5. cancel.md에 cli_worker 상태 감지 추가
6. worker-manage.md 스킬

---

## Open Questions

> 토론 합의: "없음"에서 정정. Round 1 피드백에서 도출된 미해결 항목 7개.

1. **자동 merge 허용 규칙의 정확한 범위** — 파일 타입별(바이너리 제외), 충돌 라인 수 임계값, hunk 유형별 규칙. Phase C 구현 시 확정.
2. **Retry 정책** — 재시도 횟수 (현재 1회), backoff 전략, transient 오류 분류 기준 (네트워크 타임아웃, OOM 등). Phase B 구현 시 확정.
3. **Secret scanning false-positive 처리** — 차단(기본) vs 경고+계속. 사용자 설정으로 전환 가능 여부. Phase A 구현 시 확정.
4. **Lease timeout / heartbeat interval 기본값** — heartbeat: 10초(잠정), lease: timeout_minutes 값 사용(잠정). Phase B 성능 테스트 후 확정.
5. **Sandbox 위반 시 중단 범위** — 해당 worker만 중단(잠정). 전체 orchestration 중단 옵션 필요 여부. Phase A 구현 시 확정.
6. **execGit 에러 묵살 버그의 수정 범위** — file-change-tracker.ts 단독 수정 또는 execGit 유틸리티 전역 리팩토링. Phase A 선행 수정 시 확정.
7. **CLI worker 통합테스트 전략** — mock CLI binary 사용, tmux 시뮬레이션, worktree 격리 테스트 방법. Phase B 구현 시 확정.

---

## Debate Record

본 설계는 외부 AI 끝장토론(3자: Gemini, Codex, Claude)을 거쳐 합의된 결과물이다.

- **Round 1** (2026-03-07, 이전 세션): 각자 독립 분석. Gemini 5개, Codex 5개, Claude 17개 개선점 도출.
- **Round 2** (2026-03-07, 본 세션): 피드백 기반 합의 도출. 7개 핵심 항목 전원 동의.
- **합의 결과:** FSM(Codex 전이 규칙안), Security(내장 스캐너+preflight), Merge(3-way+안전규칙), Recovery(heartbeat+lease), Task Manifest(JSON), Staged Rollout(A→B→C), Open Questions 7개 정정.
