// Pure plan logic: parse a plan's structure, match commits to its tasks, and
// estimate the time left. No `$` here, so the tests drive it with fixtures.

import type {
  WaiterDone,
  WaiterKind,
  WaiterPlan,
  WaiterSessionTask,
  WaiterTask,
} from '../types'

export const DEFAULT_RATE = 6_000 // ms per non-blank plan line, before anything is learned
export const ITEM_MS = 10 * 60_000 // a session task with no history
export const MANUAL_MIN_MS = 20 * 60_000 // floor for a hands-on task
export const GAP_MS = 4 * 60 * 60_000 // a longer gap is a break, not work
// A task's commit is often followed by review and fix commits: the newest
// committed task counts as in review until it has been quiet this long.
export const REVIEW_MS = 20 * 60_000

const NOUNS = 'task|step|phase|milestone|stage|part|chunk|story|epic|deliverable|wave|sprint|item'
const TASK_HEADING = new RegExp(
  `^(#{1,6})\\s+(?:\\[[ xX]\\]\\s+)?(?:~~)?\\s*(${NOUNS})\\s*#?\\s*(\\d+[a-z]?(?:\\.\\d+)*)\\b\\s*[:.)\\-–—]?\\s*(.*)$`,
  'i',
)
const NUMBERED_HEADING = /^(#{2,6})\s+(\d+(?:\.\d+)*)[.)]?\s+(.+)$/
const ANY_HEADING = /^(#{1,6})\s+(.+)$/
const CHECKBOX = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/
const NUMBERED_ITEM = /^\s*\d+[.)]\s+\S/
// Explicit marks only: "done" as a plain word in a title is prose, not a mark.
const DONE_MARK = /✅|✔|☑|\[[xX]\]|\((done|DONE)\)|\bDONE\b|\bCOMPLETED?\b|^\s*~~/
const MANUAL_MARK = /CONTROLLER|\bmanual\b|by hand|\bhuman\b|checkpoint|acceptance|with (the )?user/i
const TOKEN = /\b(?:delivery|phase|milestone|sprint|release|iteration|stage|plan)\s+([0-9]+[a-z]?(?:\.[0-9]+)?)\b/i
// A path that says it holds a plan: a plans/ folder, PLAN.md, *-plan.md, todo.md ...
const PLAN_PATH = /(^|[/\\._-])(plans?|todos?|tasks|roadmap|backlog|checklist)([/\\._-]|$)/i

type Line = { text: string; isCode: boolean }

function lines(text: string): Line[] {
  let isFence = false
  return text.split(/\r?\n/).map(raw => {
    const fence = /^\s*(```|~~~)/.test(raw)
    const isCode = isFence || fence
    if (fence) isFence = !isFence
    return { text: raw, isCode }
  })
}

function clean(title: string): string {
  return title.replace(/\*\*|__|`|~~/g, '').replace(/\s+/g, ' ').trim()
}

function baseName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/i, '') ?? path
}

const EXT = 'py|pyi|ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|toml|java|kt|kts|swift|go|rs|rb|cs|cpp|cc|c|h|hpp|sql|sh|ps1|html|css|scss|xml|gradle|ini|cfg|txt'
// A file a step names: `tools/desfire/ops.py`, burn_wizard.py, src/app.ts ...
const FILE_NAME = new RegExp(`(?:^|[\\s(\`'"])((?:[\\w.-]+/)*[\\w-][\\w.-]*\\.(?:${EXT}))(?=$|[\\s)\`'",.:;])`, 'g')

// Code a step names by module, `ops.burn` or `ev1fake.burn_script`: the module
// is kept as "~ops", which matches a changed file named ops.<anything>.
const MODULE_REF = new RegExp(`\`([A-Za-z_]\\w*)\\.(?!(?:${EXT})\`)[A-Za-z_][\\w.]*(?:\\(\\))?\``, 'g')

function filesIn(text: string): string[] {
  const files = [...text.matchAll(FILE_NAME)].map(m => m[1].replace(/^\.\//, '').toLowerCase())
  const modules = [...text.matchAll(MODULE_REF)].map(m => `~${m[1].toLowerCase()}`)
  return [...files, ...modules]
}

// The section of a task: its own line to the line before `end`. Its steps are
// its checkboxes (else its numbered items); each step keeps the files it names
// first, so a later "commit these files" step does not claim them.
function section(all: Line[], start: number, end: number) {
  let weight = 0
  let ticked = 0
  const boxes: number[] = []
  const numbered: number[] = []
  for (let i = Math.max(start, 0); i < end; i += 1) {
    const { text, isCode } = all[i]
    if (text.trim() !== '') weight += 1
    if (isCode || i === start) continue
    const box = CHECKBOX.exec(text)
    if (box) {
      boxes.push(i)
      if (box[2] !== ' ') ticked += 1
    } else if (NUMBERED_ITEM.test(text)) {
      numbered.push(i)
    }
  }
  const starts = boxes.length > 0 ? boxes : numbered
  // A step's own line names what it works on; its notes may mention files of
  // other steps. So the step lines claim first, then the notes, each in order.
  const seen = new Set<string>()
  const stepTitles = starts.map(from => clean(all[from].text.replace(CHECKBOX, '$3').replace(/^\s*\d+[.)]\s+/, '')).slice(0, 80))
  const stepFiles: string[][] = starts.map(() => [])
  const claim = (n: number, text: string) => {
    for (const f of filesIn(text)) {
      if (!seen.has(f)) {
        seen.add(f)
        stepFiles[n].push(f)
      }
    }
  }
  starts.forEach((from, n) => claim(n, all[from].text))
  starts.forEach((from, n) => {
    const to = n + 1 < starts.length ? starts[n + 1] : end
    for (let i = from + 1; i < to; i += 1) if (!all[i].isCode) claim(n, all[i].text)
  })
  return {
    weight: Math.max(1, weight),
    steps: starts.length,
    stepsDone: boxes.length > 0 ? ticked : 0,
    stepTitles,
    stepFiles,
  }
}

// The furthest step (1-based) that names a file now being changed; 0 for none.
export function stepReached(t: WaiterTask, changed: readonly string[]): number {
  const files = t.stepFiles ?? []
  const hit = (named: string) =>
    changed.some(c => {
      const path = c.replace(/\\/g, '/').toLowerCase()
      if (named.startsWith('~')) return (path.split('/').pop() ?? '').replace(/\.[^.]*$/, '') === named.slice(1)
      return path === named || path.endsWith(`/${named}`)
    })
  let reached = 0
  files.forEach((names, i) => {
    if (names.some(hit)) reached = i + 1
  })
  return reached
}

// `git status --porcelain` lines to the paths they name.
export function parseStatus(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter(line => line.length > 3)
    .map(line => {
      const path = line.slice(3)
      const to = path.includes(' -> ') ? path.split(' -> ').pop()! : path
      return to.replace(/^"|"$/g, '')
    })
}

function task(key: string, title: string, s: ReturnType<typeof section>, extra: Partial<WaiterTask>): WaiterTask {
  const t = clean(title)
  const isDone = DONE_MARK.test(title) || (s.steps > 0 && s.stepsDone === s.steps)
  return { key, title: t, ...s, isDone, isManual: MANUAL_MARK.test(t), ...extra }
}

function byHeadings(all: Line[], match: (text: string) => { level: number; num?: string; noun?: string; title: string } | null) {
  const found = all
    .map((l, i) => (l.isCode ? null : { i, m: match(l.text) }))
    .filter((x): x is { i: number; m: NonNullable<ReturnType<typeof match>> } => x !== null && x.m !== null)
  if (found.length < 2) return null
  // The level that holds most of them is the task level.
  const counts = new Map<number, number>()
  for (const f of found) counts.set(f.m.level, (counts.get(f.m.level) ?? 0) + 1)
  const level = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
  const picked = found.filter(f => f.m.level === level)
  if (picked.length < 2) return null
  return picked.map(f => {
    let end = all.length
    for (let j = f.i + 1; j < all.length; j += 1) {
      const h = all[j].isCode ? null : ANY_HEADING.exec(all[j].text)
      if (h && h[1].length <= level) {
        end = j
        break
      }
    }
    const key = f.m.num !== undefined ? `${(f.m.noun ?? '').toLowerCase()}-${f.m.num}` : `l${f.i}`
    return task(key, f.m.title, section(all, f.i, end), { num: f.m.num, noun: f.m.noun })
  })
}

function byXml(text: string): WaiterTask[] | null {
  const blocks = [...text.matchAll(/<task\b([^>]*)>([\s\S]*?)<\/task>/gi)]
  if (blocks.length < 2) return null
  return blocks.map((b, n) => {
    const name = /<name>([\s\S]*?)<\/name>/i.exec(b[2])?.[1] ?? b[2].trim().split(/\r?\n/)[0] ?? `Task ${n + 1}`
    const body = lines(b[2])
    const s = section(body, -1, body.length)
    const isDone = /status\s*=\s*["']?(done|complete|completed)/i.test(b[1])
    const t = task(`task-${n + 1}`, name, s, { num: String(n + 1), noun: 'Task' })
    return { ...t, isDone: t.isDone || isDone }
  })
}

function byCheckboxes(all: Line[]): WaiterTask[] | null {
  const top = all
    .map((l, i) => ({ i, m: l.isCode ? null : CHECKBOX.exec(l.text) }))
    .filter(x => x.m !== null && x.m[1].length === 0)
  if (top.length < 2) return null
  return top.map((x, n) => {
    let end = all.length
    for (let j = x.i + 1; j < all.length; j += 1) {
      const l = all[j]
      if (l.isCode) continue
      const box = CHECKBOX.exec(l.text)
      if ((box && box[1].length === 0) || ANY_HEADING.test(l.text)) {
        end = j
        break
      }
    }
    const s = section(all, x.i, end)
    const own = x.m![2] !== ' '
    const t = task(`box-${n + 1}`, x.m![3], s, {})
    // A ticked top-level box is done whatever its children say.
    return { ...t, isDone: own || t.isDone }
  })
}

// Reads a plan's structure. Null when the text holds no recognizable list of tasks.
export function parsePlan(text: string, path: string): WaiterPlan | null {
  const all = lines(text)
  const h1 = all.find(l => !l.isCode && /^#\s+\S/.test(l.text))
  const title = clean(h1 ? h1.text.replace(/^#\s+/, '') : baseName(path))
  const token = (TOKEN.exec(title) ?? TOKEN.exec(baseName(path).replace(/[-_]/g, ' ')))?.[1]?.toLowerCase()

  const tries: [WaiterKind, () => WaiterTask[] | null][] = [
    ['xml', () => byXml(text)],
    [
      'headings',
      () =>
        byHeadings(all, t => {
          const m = TASK_HEADING.exec(t)
          return m ? { level: m[1].length, noun: m[2], num: m[3], title: `${m[2]} ${m[3]}: ${m[4] || ''}`.replace(/:\s*$/, '') } : null
        }),
    ],
    [
      'numbered',
      () =>
        byHeadings(all, t => {
          const m = NUMBERED_HEADING.exec(t)
          return m && !m[2].includes('.') ? { level: m[1].length, num: m[2], title: `${m[2]}. ${m[3]}` } : null
        }),
    ],
    ['checkboxes', () => byCheckboxes(all)],
    [
      'sections',
      () => {
        if (!isPlanPath(path)) return null
        const found = byHeadings(all, t => {
          const m = ANY_HEADING.exec(t)
          return m && m[1].length >= 2 && m[1].length <= 4 ? { level: m[1].length, title: m[2] } : null
        })
        return found && found.length >= 3 ? found : null
      },
    ],
  ]
  for (const [kind, run] of tries) {
    const tasks = run()
    if (tasks && tasks.length >= 2) return { title, path, kind, token, tasks }
  }
  return null
}

export function isPlanPath(path: string): boolean {
  return PLAN_PATH.test(path)
}

// The session's own task list as a plan of equal-weight tasks.
export function sessionPlan(list: readonly WaiterSessionTask[]): WaiterPlan | null {
  if (list.length === 0) return null
  return {
    title: 'Session tasks',
    path: '',
    kind: 'session',
    tasks: list.map(s => ({
      key: `s-${s.id}`,
      title: s.subject,
      weight: 1,
      steps: 0,
      stepsDone: 0,
      isDone: s.status === 'completed',
      isManual: false,
    })),
  }
}

export type Commit = { at: number; subject: string }

// Which plan tasks the commits finish: "Task 3", "(4b Task 3)", "Phase 2: ...".
// Commits before the plan existed, commits about the plan itself, and commits
// tagged with another delivery's token ("4b" against a "4c" plan) do not count.
export function matchCommits(plan: WaiterPlan, commits: readonly Commit[], since: number): WaiterDone {
  const done: WaiterDone = {}
  const shape = /\b\d+[a-z]\b/gi
  for (const c of commits) {
    if (c.at < since) continue
    if (/^\s*(plan|spec|design|memo|notes?|wip)\b/i.test(c.subject)) continue
    if (plan.token) {
      const tokens = (c.subject.match(shape) ?? []).map(t => t.toLowerCase())
      if (tokens.length > 0 && !tokens.includes(plan.token)) continue
    }
    for (const t of plan.tasks) {
      if (t.num === undefined || t.noun === undefined) continue
      const re = new RegExp(`\\b${t.noun}\\s*#?${t.num.replace(/\./g, '\\.')}(?![.\\d])`, 'i')
      if (!re.test(c.subject)) continue
      // The last one counts: "Task 5", then "Task 5 fix 1" after the review.
      const was = done[t.key]
      if (!was || c.at > was.at) done[t.key] = { at: c.at, by: 'git' }
    }
  }
  return done
}

// Session tasks that name a plan task ("Task 3: ...") lend it their times.
export function sessionFor(plan: WaiterPlan, list: readonly WaiterSessionTask[]): Map<string, WaiterSessionTask> {
  const out = new Map<string, WaiterSessionTask>()
  if (plan.kind === 'session') {
    for (const s of list) out.set(`s-${s.id}`, s)
    return out
  }
  for (const s of list) {
    const m = new RegExp(`\\b(${NOUNS})\\s*#?(\\d+[a-z]?(?:\\.\\d+)*)\\b`, 'i').exec(s.subject)
    const hit = m
      ? plan.tasks.find(t => t.num === m[2] && (t.noun ?? '').toLowerCase() === m[1].toLowerCase())
      : plan.tasks.find(t => t.title.toLowerCase().includes(s.subject.toLowerCase()))
    if (hit) out.set(hit.key, s)
  }
  return out
}

export type RowState = 'done' | 'current' | 'todo'
export type Row = {
  key: string
  title: string
  state: RowState
  isManual: boolean
  steps: number
  stepsDone: number
  estMs: number
  tookMs?: number
  leftMs?: number // current only; negative = over the estimate
  isReview?: boolean // committed, review and fixes may still follow
  stepAt?: number // current only: the step its changed files have reached (1-based)
  stepTitle?: string
  fraction: number // 0..1 for this task's bar
}
export type View = {
  title: string
  path: string
  kind: WaiterKind
  rows: Row[]
  doneCount: number
  fraction: number
  leftMs: number
  etaAt: number
  rate: number
  measured: number // tasks whose real duration fed the rate
}

// Puts times on the plan: what is done, which task runs, how long each takes.
export function estimate(
  plan: WaiterPlan,
  done: WaiterDone,
  session: readonly WaiterSessionTask[],
  startedAt: number,
  learnedRate: number,
  now: number,
  changed: readonly string[] = [],
): View {
  const linked = sessionFor(plan, session)
  const perItem = plan.kind === 'session'
  const finished = plan.tasks.map(t => {
    const s = linked.get(t.key)
    const at = s?.doneAt ?? done[t.key]?.at
    const isDone = t.isDone || s?.status === 'completed' || done[t.key] !== undefined
    return { t, s, isDone, at }
  })
  // Plans run in order: a finished task means the ones before it are finished too
  // (an older plan whose commits never named its tasks still reads as done).
  const lastDoneIdx = finished.map(f => f.isDone).lastIndexOf(true)
  for (let i = 0; i < lastDoneIdx; i += 1) finished[i].isDone = true
  // The newest task finished only by a recent commit is still in review, unless
  // the session already marked it done or works on a later task.
  let reviewIdx = -1
  const newest = finished[lastDoneIdx]
  if (newest) {
    const g = done[newest.t.key]
    const next = finished[lastDoneIdx + 1]
    const isLaterRunning =
      finished.slice(lastDoneIdx + 1).some(f => f.s?.status === 'in_progress') ||
      (next !== undefined && stepReached(next.t, changed) > 0)
    if (
      !newest.t.isDone &&
      newest.s?.status !== 'completed' &&
      g?.by === 'git' &&
      now - g.at < REVIEW_MS &&
      !isLaterRunning
    ) {
      newest.isDone = false
      reviewIdx = lastDoneIdx
    }
  }

  // Real durations, in plan order: each task from the end of the one before.
  let prev = startedAt
  let spent = 0
  let weighed = 0
  let measured = 0
  const took = new Map<string, number>()
  for (const f of finished) {
    if (!f.isDone || f.at === undefined) continue
    const from = f.s?.startedAt ?? prev
    const ms = f.at - from
    if (ms > 0 && ms <= GAP_MS) {
      took.set(f.t.key, ms)
      if (!f.t.isManual) {
        spent += ms
        weighed += f.t.weight
        measured += 1
      }
    }
    prev = Math.max(prev, f.at)
  }
  const rate = perItem
    ? measured > 0
      ? spent / weighed
      : ITEM_MS
    : measured > 0
      ? spent / weighed
      : learnedRate
  const est = (t: WaiterTask) => {
    const ms = t.weight * rate
    return t.isManual ? Math.max(ms, MANUAL_MIN_MS) : ms
  }

  const lastDone = finished.reduce((m, f) => (f.isDone && f.at !== undefined ? Math.max(m, f.at) : m), startedAt)
  const currentIdx = (() => {
    if (reviewIdx >= 0) return reviewIdx
    const running = finished.findIndex(f => !f.isDone && f.s?.status === 'in_progress')
    return running >= 0 ? running : finished.findIndex(f => !f.isDone)
  })()

  let total = 0
  let doneWeight = 0
  let partWeight = 0
  let leftMs = 0
  const rows: Row[] = finished.map((f, i) => {
    const { t } = f
    total += t.weight
    const e = est(t)
    const base = { key: t.key, title: t.title, isManual: t.isManual, steps: t.steps, stepsDone: t.stepsDone, estMs: e }
    if (f.isDone) {
      doneWeight += t.weight
      return { ...base, state: 'done', tookMs: took.get(t.key), fraction: 1 }
    }
    if (i === reviewIdx) {
      partWeight += t.weight * 0.95
      return { ...base, state: 'current', isReview: true, fraction: 0.95 }
    }
    if (i === currentIdx) {
      const from = f.s?.startedAt ?? lastDone
      const elapsed = now - from >= 0 && now - from <= GAP_MS ? now - from : 0
      const byTime = Math.min(elapsed / e, 0.95)
      const ticked = t.steps > 0 ? t.stepsDone / t.steps : 0
      // The files being changed say which step the work is on: halfway through it.
      const reached = stepReached(t, changed)
      if (reached > 0 && t.steps > 0) {
        const fraction = Math.max((reached - 0.5) / t.steps, ticked)
        partWeight += t.weight * fraction
        const left = e * (1 - fraction)
        leftMs += left
        return { ...base, state: 'current', leftMs: left, fraction, stepAt: reached, stepTitle: t.stepTitles?.[reached - 1] }
      }
      const fraction = Math.max(byTime, ticked)
      partWeight += t.weight * fraction
      const left = e - elapsed
      leftMs += Math.max(left, 0)
      return { ...base, state: 'current', leftMs: left, fraction }
    }
    leftMs += e
    return { ...base, state: 'todo', fraction: t.steps > 0 ? t.stepsDone / t.steps : 0 }
  })

  return {
    title: plan.title,
    path: plan.path,
    kind: plan.kind,
    rows,
    doneCount: rows.filter(r => r.state === 'done').length,
    fraction: total > 0 ? (doneWeight + partWeight) / total : 0,
    leftMs,
    etaAt: now + leftMs,
    rate,
    measured,
  }
}

export function bar(fraction: number, width: number): string {
  const w = Math.max(1, Math.floor(width))
  const full = Math.round(Math.min(Math.max(fraction, 0), 1) * w)
  return '█'.repeat(full) + '░'.repeat(w - full)
}

export function duration(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60_000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r === 0 ? `${h}h` : `${h}h ${r}m`
}

export function clock(at: number): string {
  const d = new Date(at)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export function parseGitLog(stdout: string): Commit[] {
  return stdout
    .split(/\r?\n/)
    .map(line => {
      const tab = line.indexOf('\t')
      if (tab < 0) return null
      const at = Number(line.slice(0, tab)) * 1000
      return Number.isFinite(at) ? { at, subject: line.slice(tab + 1) } : null
    })
    .filter((c): c is Commit => c !== null)
}
