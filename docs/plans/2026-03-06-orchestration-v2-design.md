# Orchestration v2 Design — Autopilot Pipeline

## Problem

현재 오케스트레이션의 한계:

1. **team-lead가 매 단계 수동 승인 필요** — Phase 2에서 사용자 승인 대기, QA 실패 시 수동 대응
2. **QA가 판정만 하고 끝** — FAIL 판정 후 사람이 직접 수정해야 함. 자동 수정 루프 없음
3. **designer의 명확성 판단이 주관적** — "충분히 이해했다"의 기준이 정량화되지 않음
4. **moderator가 전문 에이전트를 실제 호출하지 않음** — Claude 턴에서 specialist perspective를 참조하지만 spawn하지 않음
5. **품질 게이트가 단편적** — qa의 설계 대비 검증과 reviewer의 7점 체크리스트가 독립적으로 존재. 통합 프레임워크 없음

## Approach

기존 에이전트 6개 (team-lead, designer, qa, reviewer, moderator, ideator)를 유지하면서:
- 각 에이전트에 **자동화 루프와 정량적 게이트**를 추가
- team-lead의 파이프라인을 **5단계 자동 진행 가능**하게 개조
- 사용자 개입 지점을 **선택적**으로 변경 (자동/수동 모드)

## Architecture

### Pipeline Overview

```
User Request
    |
    v
[Phase 0: Clarity Gate] ---- designer (Deep Interview)
    |                         ambiguity <= 20% ? --> proceed
    |                         ambiguity > 20%  ? --> keep asking
    v
[Phase 1: Design] ----------- designer (Explore + Propose + Document)
    |                         design doc in docs/plans/
    v
[Phase 2: Execute] ---------- team-lead (Task decomposition + Dispatch)
    |                         parallel AI execution
    |                         result inspection
    v
[Phase 3: QA Cycle] --------- qa (Verify) <--> team-lead (Re-assign fix)
    |                         max 5 cycles
    |                         3 identical failures --> escalate
    v
[Phase 4: Quality Gate] ----- reviewer (TRUST 5)
    |                         all 5 pass --> proceed
    |                         failure --> back to Phase 2 for targeted fix
    v
[Phase 5: Report] ----------- team-lead (Summary + Commit recommendation)
```

### Phase 0: Clarity Gate (designer 보강)

designer agent의 Phase 1 (Understand)에 정량적 모호성 채점을 통합.

**변경점 — `agestra-designer.md` Phase 1:**

```markdown
### Phase 1: Understand (with Clarity Gate)

Before asking questions, assess initial ambiguity:

Clarity Dimensions:
| Dimension        | Weight (new) | Weight (existing code) |
|-----------------|-------------|----------------------|
| Goal            | 40%         | 35%                  |
| Constraints     | 30%         | 25%                  |
| Success Criteria| 30%         | 25%                  |
| Context         | N/A         | 15%                  |

For each answer:
1. Score all dimensions 0.0-1.0
2. Calculate: ambiguity = 1 - weighted_sum
3. Display progress:
   Round {n} | Ambiguity: {score}% | Targeting: {weakest dimension}
4. If ambiguity <= 20% --> proceed to Phase 2
5. If ambiguity > 20% --> continue questioning

Question targeting: always ask about the WEAKEST dimension.
One question at a time. Expose assumptions, not feature lists.

Challenge modes (each used once):
- Round 4+: Contrarian — "What if the opposite were true?"
- Round 6+: Simplifier — "What's the simplest version that's still valuable?"
- Round 8+: Ontologist — "What IS this, really?" (if ambiguity still > 30%)

Soft limits:
- Round 3+: allow early exit with ambiguity warning
- Round 10: soft warning
- Round 20: hard cap, proceed with current clarity

If request is already clear (file paths, function names, concrete criteria):
--> Score immediately, skip interview if ambiguity <= 20%
```

**기존과 달라지는 점:**
- designer가 기존처럼 질문을 하되, 매 답변마다 **점수를 보여줌**
- 20% 기준으로 **자동으로 다음 단계 진행 판단**
- 이미 명확한 요청은 인터뷰 없이 바로 설계 단계로

### Phase 3: QA Cycle (qa + team-lead 연동)

현재 qa는 PASS/FAIL 판정 후 종료. 이를 자동 수정 루프로 확장.

**변경점 — `agestra-qa.md`에 Phase 6 추가:**

```markdown
### Phase 6: Auto-Fix Cycle (when invoked with auto_fix: true)

If verdict is FAIL:

1. Classify each failure:
   - BUILD_ERROR: build/typecheck failure --> trigger build-fix skill
   - DESIGN_GAP: requirement not implemented --> create fix task for team-lead
   - INTEGRATION_BREAK: cross-AI output conflict --> create fix task for team-lead
   - TEST_FAILURE: implementation bug --> create fix task for team-lead

2. Report failures with classification to the invoker (team-lead).

If verdict is CONDITIONAL PASS:
- Report issues but do NOT trigger auto-fix cycle.
- team-lead decides whether to fix or accept.
```

**변경점 — `agestra-team-lead.md` Phase 4 확장:**

```markdown
### Phase 4: QA Cycle (replaces old Phase 4: Result Inspection)

After Phase 3 execution completes:

1. Run own result inspection (existing logic — unchanged).
2. Spawn agestra-qa agent with collected results.
3. If qa returns PASS --> proceed to Phase 4b (Quality Gate).
4. If qa returns FAIL:

   QA Fix Loop (max 5 cycles):
   a. Parse qa's failure classifications.
   b. For BUILD_ERROR:
      - Invoke build-fix skill to auto-repair.
   c. For DESIGN_GAP / INTEGRATION_BREAK / TEST_FAILURE:
      - Create targeted fix tasks.
      - Re-assign to the original AI provider (or escalate to more capable).
      - Re-inspect results.
   d. Re-run agestra-qa.
   e. If same failure persists 3 consecutive times:
      - Stop the cycle.
      - Escalate to user with diagnosis.
   f. If qa returns PASS --> proceed.

5. If qa returns CONDITIONAL PASS:
   - Present issues to user.
   - User decides: fix or accept.
```

**핵심 규칙:**
- BUILD_ERROR는 build-fix skill이 자동 처리 (사람 개입 불필요)
- DESIGN_GAP은 team-lead가 재지시 (기존 "No Compromise" 원칙 활용)
- 3회 동일 실패 시 사람에게 에스컬레이션 (무한 루프 방지)

### Phase 4b: Quality Gate (reviewer 보강 — TRUST 5)

reviewer의 7점 체크리스트를 TRUST 5 프레임워크로 확장.

**변경점 — `agestra-reviewer.md` Checklist 확장:**

```markdown
<Quality_Framework>
TRUST 5 — 모든 검증의 최종 게이트.

| Gate | Criteria | Threshold | Verification Method |
|------|----------|-----------|-------------------|
| Tested | 테스트 존재 + 통과 | 변경된 public function 85%+ 커버 | test suite 실행 결과 |
| Readable | 명확한 네이밍, 구조 | 매직넘버 없음, 함수 50줄 이하 | 코드 읽기 검증 |
| Unified | 기존 컨벤션 준수 | 네이밍/구조/패턴 일관 | codebase 패턴 비교 |
| Secured | 보안 취약점 없음 | OWASP top 10 통과 | 기존 checklist #1 |
| Trackable | 추적 가능한 변경 | conventional commit, 설계문서 연결 | git log + docs 확인 |

Verdict:
- 5/5 PASS --> Quality Gate 통과
- 4/5 (non-Secured) --> CONDITIONAL, 나머지 수정 후 재검증
- Secured FAIL 또는 3개 이상 FAIL --> BLOCK, Phase 2로 되돌림
</Quality_Framework>
```

**기존 7점 체크리스트와의 관계:**
- 기존 #1 (Security) → Secured
- 기존 #2 (Orphan) → Unified의 일부
- 기존 #3 (Missing UI) → Tested의 일부 (UI feature면 테스트에 포함)
- 기존 #4 (Hardcoding) → Readable
- 기존 #5 (i18n) → Unified
- 기존 #6 (Spec drift) → Trackable
- 기존 #7 (Test gaps) → Tested

7점 체크리스트는 유지하되, TRUST 5가 상위 프레임워크로 판정 기준 통합.

### Moderator Fix (#3)

**변경점 — `agestra-moderator.md` Phase 2 Claude turn:**

```markdown
**Claude turn:**
1. Before Claude's debate turn, spawn the specialist agent to produce independent analysis:
   - Invoke the specialist agent (agestra-reviewer, agestra-designer, or agestra-ideator
     depending on the invoking command's context) with the debate topic as input.
   - Collect the specialist's analysis output.

2. Call `agent_debate_turn` with `provider: "claude"`
   - Set `claude_comment` to the specialist agent's ACTUAL analysis output.
   - This ensures Claude's debate contribution is real expert analysis,
     not the moderator's interpretation.

3. The moderator remains neutral — it relays the specialist's work,
   does not modify or editorialize the content.
```

**변경 전:** moderator가 specialist perspective를 "참조"만 함 (실제 spawn 없음)
**변경 후:** moderator가 specialist agent를 실제 spawn → 분석 결과를 받아서 → `claude_comment`로 주입

### team-lead 자동/수동 모드

team-lead에 실행 모드를 추가하여 자동화 수준을 사용자가 선택.

**변경점 — `agestra-team-lead.md` Phase 1에 모드 감지 추가:**

```markdown
### Execution Mode

Determine mode at start:

| Mode | Trigger | Behavior |
|------|---------|----------|
| **supervised** (default) | Normal request | User approves task plan before execution. QA failures reported for decision. |
| **autonomous** | User says "자동으로", "autopilot", "알아서 해줘" | Skips plan approval. QA cycle runs automatically. Escalates only on 3x failure or Critical. |

In autonomous mode:
- Phase 0 (Clarity Gate) still runs if request is vague
- Phase 1 (Design) still produces docs/plans/ document
- Phase 2 (Execute) proceeds without waiting for approval
- Phase 3 (QA Cycle) runs auto-fix loop without asking
- Phase 4 (Quality Gate) always runs — Secured FAIL always escalates to user
- Phase 5 (Report) summarizes everything done

User can say "stop" or "cancel" at any time to interrupt autonomous mode.
(cancel skill handles graceful shutdown)
```

## Components Summary — What Changes

| Component | Change Type | What Changes |
|-----------|------------|--------------|
| `agestra-designer.md` | **수정** | Phase 1에 모호성 채점 + Challenge modes 추가 |
| `agestra-team-lead.md` | **수정** | 자동/수동 모드 추가, Phase 4를 QA Cycle로 확장 |
| `agestra-qa.md` | **수정** | Phase 6 (failure classification) 추가 |
| `agestra-reviewer.md` | **수정** | TRUST 5 프레임워크 추가 (기존 checklist 유지) |
| `agestra-moderator.md` | **수정** | Claude turn에서 specialist agent 실제 spawn |
| `skills/build-fix.md` | 이미 추가됨 | QA cycle에서 BUILD_ERROR 시 자동 호출 |
| `skills/cancel.md` | 이미 추가됨 | autonomous 모드 중단 시 사용 |
| `skills/trace.md` | 이미 추가됨 | 파이프라인 실행 추적 |
| `agestra-ideator.md` | 변경 없음 | |
| commands/* | 변경 없음 | 기존 커맨드 구조 유지 |
| hooks/* | 변경 없음 | 기존 훅 유지 |

## Data Flow

### Supervised Mode (기본)

```
User: "이 기능 만들어줘"
  |
  v
team-lead: Phase 0 --> designer (ambiguity scoring)
  |  designer: "Ambiguity 45%. Round 1 question..."
  |  user answers...
  |  designer: "Ambiguity 18%. Clarity threshold met."
  v
team-lead: Phase 1 --> designer (explore + propose + document)
  |  designer: writes docs/plans/feature-design.md
  v
team-lead: Phase 2 --> presents task plan to user
  |  user: "좋아, 진행해"
  |  team-lead: dispatches to AI providers
  |  team-lead: inspects results
  v
team-lead: Phase 3 --> qa (verify)
  |  qa: FAIL (2 issues)
  |    - BUILD_ERROR: type mismatch in api.ts:42
  |    - DESIGN_GAP: missing endpoint from design
  |
  |  team-lead: auto-triggers build-fix for BUILD_ERROR
  |  team-lead: re-assigns DESIGN_GAP to provider
  |  team-lead: re-runs qa
  |  qa: PASS
  v
team-lead: Phase 4 --> reviewer (TRUST 5)
  |  reviewer: 5/5 PASS
  v
team-lead: Phase 5 --> report to user
```

### Autonomous Mode

```
User: "이 기능 만들어줘, 알아서 해줘"
  |
  v
team-lead: autonomous mode detected
  |
  v  (same pipeline, but no approval gates)
Phase 0 --> Phase 1 --> Phase 2 --> Phase 3 (auto-fix) --> Phase 4 --> Phase 5
  |                                    |
  |                            3x same failure?
  |                            Secured FAIL?
  |                                    |
  |                              escalate to user
  v
Report: "완료. 5개 태스크, QA 2회 사이클, TRUST 5 통과."
```

## Resolved Decisions

1. **autonomous 모드에서 Phase 1 (Design) 문서** → **보여주되 승인은 기다리지 않음** (Option A)

2. **QA cycle provider 에스컬레이션** → **즉시 다른 provider로 교체 + 풀 컨텍스트 전달**
   - 전달 항목: 원래 태스크 설명, 이전 AI 이름, 실패 분류, QA의 구체적 진단, 수정 지시, 변경 금지 항목
   - 같은 provider에 재시도하지 않음. 다른 관점 + 풀 컨텍스트가 더 효과적.

3. **TRUST 5 Tested 게이트** → **Tiered 3단계 기준**
   - 필수 (게이트): 이번에 추가/수정한 public function 85%+ 커버리지
   - 권장 (리포트): 수정한 파일 내 기존 public function 커버리지
   - 보고 (리포트): 프로젝트 전체 커버리지 추세
