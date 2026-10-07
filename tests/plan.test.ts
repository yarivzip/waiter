import { describe, expect, test } from 'claude-code/testing'

import {
  estimate,
  isPlanPath,
  matchCommits,
  parseGitLog,
  parsePlan,
  parseStatus,
  sessionPlan,
  stepReached,
} from '../hooks/plan'

const MIN = 60_000

// The shape of this project's plans: ### Task N headings, nested ** Step ** checkboxes,
// code fences holding lines that look like headings.
const SUPERPOWERS = `# Card Editor — Delivery 4b: Per-Card Keys — Implementation Plan

## Global Constraints
- keep it small

### Task 1: Worktree; key store

- [ ] **Step 1: Create the worktree**
- [ ] **Step 2: Write the failing tests**

\`\`\`python
# --- not a heading -----------------
def test(): pass
\`\`\`

- [ ] **Step 3: Commit**

### Task 2: Profile fields

- [x] **Step 1: Write the failing tests**
- [x] **Step 2: Implement**

### Task 3: CONTROLLER — the rehearsal on card 03

- [ ] **Step 1: Ask Yariv**
`

const GSD = `# Phase 2 Plan
<task type="auto">
  <name>Create the model</name>
  <action>write it</action>
</task>
<task type="auto" status="done">
  <name>Wire the API</name>
</task>
<task type="checkpoint:human-verify">
  <name>Check it by hand</name>
</task>
`

const CHECKLIST = `# Release checklist
- [x] Bump the version
- [ ] Build
  - [x] windows
  - [ ] mac
- [ ] Publish
`

const NUMBERED = `# Migration
## 1. Back up the database
text
## 2. Run the migration
text
### 2.1 sub step
## 3. Verify
`

describe('parsePlan', () => {
  test('task headings: steps stay inside their task, code fences are not headings', () => {
    const plan = parsePlan(SUPERPOWERS, 'D:/x/documents/design/plans/2026-10-07-card-editor-4b.md')!
    expect(plan.kind).toBe('headings')
    expect(plan.token).toBe('4b')
    expect(plan.tasks.map(t => t.num)).toEqual(['1', '2', '3'])
    expect(plan.tasks[0].steps).toBe(3)
    expect(plan.tasks[0].isDone).toBe(false)
    expect(plan.tasks[1].isDone).toBe(true)
    expect(plan.tasks[2].isManual).toBe(true)
    expect(plan.tasks[0].weight > plan.tasks[1].weight).toBe(true)
  })

  test('GSD <task> blocks', () => {
    const plan = parsePlan(GSD, 'C:/p/.planning/phases/02/02-01-PLAN.md')!
    expect(plan.kind).toBe('xml')
    expect(plan.tasks.map(t => t.title)).toEqual(['Create the model', 'Wire the API', 'Check it by hand'])
    expect(plan.tasks[1].isDone).toBe(true)
    expect(plan.tasks[2].isManual).toBe(true)
  })

  test('a flat checkbox list, nested boxes as steps', () => {
    const plan = parsePlan(CHECKLIST, '/r/todo.md')!
    expect(plan.kind).toBe('checkboxes')
    expect(plan.tasks.length).toBe(3)
    expect(plan.tasks[0].isDone).toBe(true)
    expect(plan.tasks[1].steps).toBe(2)
    expect(plan.tasks[1].stepsDone).toBe(1)
  })

  test('numbered headings, sub-numbers are not tasks', () => {
    const plan = parsePlan(NUMBERED, '/r/notes.md')!
    expect(plan.kind).toBe('numbered')
    expect(plan.tasks.map(t => t.num)).toEqual(['1', '2', '3'])
  })

  test('prose is not a plan', () => {
    expect(parsePlan('# Notes\n\nJust some text.\n', '/r/notes.md')).toBe(null)
  })

  test('plan paths', () => {
    expect(isPlanPath('D:/x/documents/design/plans/a.md')).toBe(true)
    expect(isPlanPath('/r/PLAN.md')).toBe(true)
    expect(isPlanPath('/r/explanation.md')).toBe(false)
  })
})

describe('matchCommits', () => {
  const plan4c = parsePlan(SUPERPOWERS.replace('Delivery 4b', 'Delivery 4c'), '/r/plans/4c.md')!
  const plan4b = parsePlan(SUPERPOWERS, '/r/plans/4b.md')!
  const log = parseGitLog(
    [
      '1759835710\tProfile: factory_set (4b Task 2)',
      '1759834550\tKey store: card master list (4b Task 1)',
      '1759831243\tPlan 4b per-card keys (13 tasks)',
      '1759655000\tPlan 4a Task 10: optional picc_keyref',
    ].join('\n'),
  )
  const since = 1759831243 * 1000

  test("another delivery's commits do not finish this plan's tasks", () => {
    expect(matchCommits(plan4c, log, 0)).toEqual({})
  })

  test('commits tagged with this delivery do', () => {
    const done = matchCommits(plan4b, log, since)
    expect(Object.keys(done).sort()).toEqual(['task-1', 'task-2'])
    expect(done['task-1'].at).toBe(1759834550 * 1000)
  })

  test('commits before the plan existed, and plan edits, do not count', () => {
    const plain = parsePlan(SUPERPOWERS.replace('Delivery 4b: ', ''), '/r/plans/p.md')!
    const done = matchCommits(plain, parseGitLog('100\tTask 3 done\n300\tPlan: Task 1 reworded\n400\tTask 1: build it'), 200_000)
    expect(Object.keys(done)).toEqual(['task-1'])
  })
})

const WITH_FILES = `# Delivery 4b plan

### Task 7: Per-card Burn

- [ ] **Step 1: Extend \`ev1fake.burn_script\`** in \`tools/tests/ev1fake.py\`.
- [ ] **Step 2: Write the failing tests** — append to \`tools/tests/test_ops.py\`:
- [ ] **Step 3: Run them to see them fail**
- [ ] **Step 4: Implement in \`ops.burn\`** (tools/desfire/ops.py).
- [ ] **Step 5: Run the tests, then everything**
- [ ] **Step 6: Commit**

\`\`\`bash
git add tools/desfire/ops.py tools/tests/ev1fake.py tools/tests/test_ops.py
\`\`\`

### Task 8: Personalise

- [ ] **Step 1: Write the failing tests** in \`tools/tests/test_personalise.py\`
- [ ] **Step 2: Commit**
`

describe('steps from changed files', () => {
  const plan = parsePlan(WITH_FILES, '/r/plans/4b.md')!
  const t7 = plan.tasks[0]

  test('each step keeps the files it names first; the commit step claims none', () => {
    expect(t7.stepFiles).toEqual([
      ['tools/tests/ev1fake.py', '~ev1fake'],
      ['tools/tests/test_ops.py'],
      [],
      ['tools/desfire/ops.py', '~ops'],
      [],
      [],
    ])
  })

  test("a step's own line claims a file before an earlier step's notes", () => {
    const text = `# Plan 9\n\n### Task 1: A\n\n- [ ] **Step 1: Extend \`fake.run\`**\n  the callers in tools/tests/test_ops.py change too\n- [ ] **Step 2: Tests** in \`tools/tests/test_ops.py\`\n- [ ] **Step 3: Implement \`ops.burn\`**\n\n### Task 2: B\n\n- [ ] x\n- [ ] y\n`
    const t = parsePlan(text, '/r/plans/p.md')!.tasks[0]
    expect(t.stepFiles).toEqual([['~fake'], ['tools/tests/test_ops.py'], ['~ops']])
    expect(stepReached(t, ['tools/desfire/fake.py', 'tools/desfire/ops.py'])).toBe(3)
  })

  test('the furthest step with a changed file', () => {
    expect(stepReached(t7, [])).toBe(0)
    expect(stepReached(t7, ['tools/tests/ev1fake.py'])).toBe(1)
    expect(stepReached(t7, ['tools/tests/ev1fake.py', 'tools/desfire/ops.py', 'tools/tests/test_ops.py'])).toBe(4)
  })

  test('git status lines, renames and quoted names', () => {
    expect(parseStatus(' M tools/desfire/ops.py\n?? tools/tests/new.py\nR  a.py -> b.py\n M "a b.py"\n')).toEqual([
      'tools/desfire/ops.py',
      'tools/tests/new.py',
      'b.py',
      'a b.py',
    ])
  })

  test('the current task fills by step and says which one', () => {
    const v = estimate(plan, {}, [], 0, 6_000, 5 * MIN, ['tools/tests/ev1fake.py', 'tools/desfire/ops.py'])
    const cur = v.rows[0]
    expect(cur.stepAt).toBe(4)
    expect(cur.stepTitle).toBe('Step 4: Implement in ops.burn (tools/desfire/ops.py).')
    expect(cur.fraction).toBe(3.5 / 6)
    expect(cur.leftMs).toBe(cur.estMs * (1 - 3.5 / 6))
  })

  test("the next task's files end the review of the one before", () => {
    const done = { 'task-7': { at: 30 * MIN, by: 'git' as const } }
    const quiet = estimate(plan, done, [], 0, 6_000, 35 * MIN, [])
    expect(quiet.rows[0].isReview).toBe(true)
    const moved = estimate(plan, done, [], 0, 6_000, 35 * MIN, ['tools/tests/test_personalise.py'])
    expect(moved.rows.map(r => r.state)).toEqual(['done', 'current'])
    expect(moved.rows[1].stepAt).toBe(1)
  })
})

describe('estimate', () => {
  test('learns the rate from done tasks and times the current one', () => {
    const plan = parsePlan(SUPERPOWERS.replace(/- \[x\]/g, '- [ ]'), '/r/plans/4b.md')!
    const start = 0
    const t1 = plan.tasks[0]
    const done = { 'task-1': { at: 30 * MIN, by: 'git' as const } }
    const v = estimate(plan, done, [], start, 6_000, 55 * MIN)
    expect(v.doneCount).toBe(1)
    expect(v.measured).toBe(1)
    expect(v.rate).toBe((30 * MIN) / t1.weight)
    const cur = v.rows[1]
    expect(cur.state).toBe('current')
    expect(cur.leftMs).toBe(cur.estMs - 25 * MIN)
    expect(v.rows[2].state).toBe('todo')
    expect(v.rows[2].estMs >= 20 * MIN).toBe(true) // a hands-on task has a floor
    expect(v.fraction > 0 && v.fraction < 1).toBe(true)
  })

  test('a break longer than four hours is not counted as work', () => {
    const plan = parsePlan(SUPERPOWERS, '/r/plans/4b.md')!
    const v = estimate(plan, { 'task-1': { at: 10 * 60 * MIN, by: 'git' } }, [], 0, 6_000, 10 * 60 * MIN)
    expect(v.measured).toBe(0)
    expect(v.rate).toBe(6_000)
  })

  test('a finished task finishes the ones before it', () => {
    const plan = parsePlan(SUPERPOWERS.replace(/- \[x\]/g, '- [ ]'), '/r/plans/4b.md')!
    const v = estimate(plan, { 'task-3': { at: 30 * MIN, by: 'git' } }, [], 0, 6_000, 60 * MIN)
    expect(v.doneCount).toBe(3)
    expect(v.rows[0].tookMs).toBe(undefined)
  })

  test('a task committed minutes ago is still in review', () => {
    const plan = parsePlan(SUPERPOWERS.replace(/- \[x\]/g, '- [ ]'), '/r/plans/4b.md')!
    const v = estimate(plan, { 'task-2': { at: 30 * MIN, by: 'git' } }, [], 0, 6_000, 40 * MIN)
    expect(v.rows.map(r => r.state)).toEqual(['done', 'current', 'todo'])
    expect(v.rows[1].isReview).toBe(true)
    const later = estimate(plan, { 'task-2': { at: 30 * MIN, by: 'git' } }, [], 0, 6_000, 51 * MIN)
    expect(later.rows.map(r => r.state)).toEqual(['done', 'done', 'current'])
  })

  test('review and fix commits: the last one counts', () => {
    const done = matchCommits(parsePlan(SUPERPOWERS, '/r/plans/4b.md')!, parseGitLog('100\tOps (4b Task 1)\n200\tFix a leak (4b Task 1 fix 1)'), 0)
    expect(done['task-1'].at).toBe(200_000)
  })

  test('the session task list alone is a plan', () => {
    const list = [
      { id: '1', subject: 'Write tests', status: 'completed' as const, startedAt: 0, doneAt: 5 * MIN },
      { id: '2', subject: 'Implement', status: 'in_progress' as const, startedAt: 5 * MIN },
      { id: '3', subject: 'Review', status: 'pending' as const },
    ]
    const plan = sessionPlan(list)!
    const v = estimate(plan, {}, list, 0, 6_000, 7 * MIN)
    expect(v.rows.map(r => r.state)).toEqual(['done', 'current', 'todo'])
    expect(v.rows[0].tookMs).toBe(5 * MIN)
    expect(v.rows[1].leftMs).toBe(3 * MIN)
    expect(v.leftMs).toBe(8 * MIN)
  })

  test('a session task named "Task 2" lends its times to the plan task', () => {
    const plan = parsePlan(SUPERPOWERS.replace(/- \[x\]/g, '- [ ]'), '/r/plans/4b.md')!
    const list = [{ id: '9', subject: 'Task 2: Profile fields', status: 'in_progress' as const, startedAt: 50 * MIN }]
    const v = estimate(plan, { 'task-1': { at: 30 * MIN, by: 'git' } }, list, 0, 6_000, 55 * MIN)
    expect(v.rows[1].leftMs).toBe(v.rows[1].estMs - 5 * MIN)
  })
})
