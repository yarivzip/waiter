import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { WaiterDone, WaiterMode, WaiterPlan, WaiterSessionTask } from '../types'
import {
  DEFAULT_RATE,
  bar,
  clock,
  duration,
  estimate,
  isPlanPath,
  matchCommits,
  parseGitLog,
  parsePlan,
  parseStatus,
  sessionPlan,
} from './plan'
import type { Row, View } from './plan'

const PANE = 'waiter'
const TITLE = 'Waiter'

const planA = atom({ plugin: 'waiter', key: 'plan' } as const, null)
const doneA = atom({ plugin: 'waiter', key: 'done' } as const, {})
const sessionA = atom({ plugin: 'waiter', key: 'session' } as const, [])
const startedA = atom({ plugin: 'waiter', key: 'startedAt' } as const, 0)
const rateA = atom({ plugin: 'waiter', key: 'rate' } as const, DEFAULT_RATE)
const modeA = atom({ plugin: 'waiter', key: 'mode' } as const, 'pane')
const noteA = atom({ plugin: 'waiter', key: 'note' } as const, '')
const restoredA = atom({ plugin: 'waiter', key: 'isRestored' } as const, false)
const changedA = atom({ plugin: 'waiter', key: 'changed' } as const, [])

type $ = EngineInterface

const norm = (p: string) => p.replace(/\\/g, '/')
const dirOf = (p: string) => norm(p).replace(/\/[^/]*$/, '') || '/'
const isAbsolute = (p: string) => /^[a-zA-Z]:\//.test(norm(p)) || norm(p).startsWith('/')
const same = (a: string, b: string) => norm(a).toLowerCase() === norm(b).toLowerCase()

async function absolute($: $, p: string): Promise<string> {
  const path = norm(p.trim().replace(/^["']|["']$/g, ''))
  return isAbsolute(path) ? path : `${norm(await $.session.cwd())}/${path.replace(/^\.\//, '')}`
}

async function git($: $, argv: string[], cwd: string): Promise<string | null> {
  try {
    const r = await $.process.run(['git', ...argv], { cwd, timeoutMs: 15_000 })
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null // no git, or no host processes on this surface
  }
}

async function storeGet<T>($: $, key: string, fallback: T): Promise<T> {
  try {
    const v = await $.store.get(key)
    return v === undefined || v === null ? fallback : (v as T)
  } catch {
    return fallback
  }
}

async function storeSet($: $, key: string, value: unknown) {
  try {
    await $.store.set(key, value)
  } catch {
    // a store that refuses only costs the memory across sessions
  }
}

// Waiter reads only files a tool call already opened: those calls pass the
// session's PreToolUse guards (a project's off-limits folders), waiter's own
// reads would not. A path enters this list once such a call succeeded.
async function allow($: $, path: string) {
  const opened = await storeGet<string[]>($, 'opened', [])
  const key = norm(path).toLowerCase()
  if (!opened.includes(key)) await storeSet($, 'opened', [...opened, key].slice(-200))
}

async function isAllowed($: $, path: string): Promise<boolean> {
  return (await storeGet<string[]>($, 'opened', [])).includes(norm(path).toLowerCase())
}

// Opens `path` through the Read tool, so the session's guards decide.
async function openGuarded($: $, path: string): Promise<boolean> {
  try {
    const r = await $.tool.call({ tool: 'Read', file_path: path, limit: 1 })
    if (r.deny !== undefined || r.isError) return false
    await allow($, path)
    return true
  } catch {
    return false
  }
}

// The learned rate: the mean of the last plans' measured rates.
async function learnedRate($: $): Promise<number> {
  const rates = await storeGet<Record<string, number>>($, 'rates', {})
  const values = Object.values(rates).filter(v => v > 0)
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : DEFAULT_RATE
}

async function current($: $): Promise<WaiterPlan | null> {
  return (await read($, planA)) ?? sessionPlan(await read($, sessionA))
}

async function view($: $): Promise<View | null> {
  const plan = await current($)
  if (!plan) return null
  return estimate(
    plan,
    await read($, doneA),
    await read($, sessionA),
    await read($, startedA),
    await read($, rateA),
    await $.clock.now(),
    plan.kind === 'session' ? [] : await read($, changedA),
  )
}

// Shows the plan the way the person last chose: the pane, or the one-line band.
async function show($: $) {
  if ((await read($, modeA)) !== 'pane') return
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  if (!opened.isPlaced) await update($, modeA, () => 'band' as WaiterMode)
}

// Stops tracking, and forgets the plan so the next session does not bring it back.
async function stop($: $) {
  await update($, planA, () => null)
  await storeSet($, `last:${norm(await $.session.root())}`, '')
  await setMode($, 'hidden')
}

async function setMode($: $, mode: WaiterMode) {
  await update($, modeA, () => mode)
  if (mode !== 'hidden') await storeSet($, 'mode', mode)
  if (mode === 'pane') await $.ui.open({ id: PANE, title: TITLE })
  else await $.ui.close({ id: PANE })
}

// Reads the plan's commits and records which tasks they finish.
async function refreshGit($: $) {
  const plan = await read($, planA)
  if (!plan) return
  const since = await read($, startedA)
  const out = await git($, ['log', '--all', `--since=${Math.floor(since / 1000) - 60}`, '--format=%ct%x09%s'], dirOf(plan.path))
  if (out === null) return
  const found = matchCommits(plan, parseGitLog(out), since)
  await update($, doneA, done => {
    const next: WaiterDone = { ...done }
    for (const [k, v] of Object.entries(found)) {
      if (!next[k] || v.at < next[k].at) next[k] = v
    }
    return next
  })
  await learn($)
  await refreshChanged($)
}

// The files changed and not yet committed, in every working folder of the repo
// (a plan is often executed in a worktree). Names only: no file is opened.
async function refreshChanged($: $) {
  const plan = await read($, planA)
  if (!plan) return
  const list = await git($, ['worktree', 'list', '--porcelain'], dirOf(plan.path))
  const folders = (list ?? '')
    .split(/\r?\n/)
    .filter(l => l.startsWith('worktree '))
    .map(l => l.slice('worktree '.length))
  const changed: string[] = []
  for (const folder of folders.length > 0 ? folders : [dirOf(plan.path)]) {
    const out = await git($, ['status', '--porcelain', '--untracked-files=all'], folder)
    if (out !== null) changed.push(...parseStatus(out))
  }
  await update($, changedA, () => [...new Set(changed)].slice(0, 500))
}

// Keeps this plan's measured rate, so later plans start from it.
async function learn($: $) {
  const plan = await read($, planA)
  const v = await view($)
  if (!plan || !v || v.kind === 'session' || v.measured === 0) return
  const rates = await storeGet<Record<string, number>>($, 'rates', {})
  rates[plan.path] = v.rate
  await storeSet($, 'rates', Object.fromEntries(Object.entries(rates).slice(-10)))
}

async function created($: $, path: string): Promise<number | null> {
  const out = await git($, ['log', '--follow', '--diff-filter=A', '--format=%ct', '--', path], dirOf(path))
  const last = out?.trim().split(/\r?\n/).filter(Boolean).pop()
  return last ? Number(last) * 1000 : null
}

async function load($: $, path: string): Promise<WaiterPlan | null> {
  if (!(await isAllowed($, path))) return null
  try {
    return parsePlan(await $.fs.read(path), path)
  } catch {
    return null
  }
}

// Starts tracking the plan file at `path`. Says what happened, for the command.
async function track($: $, path: string): Promise<string> {
  const plan = await load($, path)
  if (!plan) return `no tasks found in ${path}.`
  const now = await $.clock.now()
  const seen = await storeGet<WaiterDone>($, `seen:${plan.path}`, {})
  const start = (await created($, plan.path)) ?? (await storeGet<number>($, `start:${plan.path}`, now))
  await storeSet($, `start:${plan.path}`, start)
  await update($, planA, () => plan)
  await update($, restoredA, () => false)
  await update($, doneA, () => seen)
  await update($, startedA, () => start)
  const rate = await learnedRate($)
  await update($, rateA, () => rate)
  await update($, noteA, () => `read from ${plan.kind}`)
  await storeSet($, `last:${norm(await $.session.root())}`, plan.path)
  await refreshGit($)
  await show($)
  return `tracking "${plan.title}" (${plan.tasks.length} tasks, read from ${plan.kind}).`
}

// The tracked file changed: read it again and time the tasks it newly marks done.
async function reparse($: $) {
  const old = await read($, planA)
  if (!old) return
  const plan = await load($, old.path)
  if (!plan) return
  const now = await $.clock.now()
  const was = new Map(old.tasks.map(t => [t.key, t.isDone]))
  const done = await update($, doneA, d => {
    const next: WaiterDone = { ...d }
    for (const t of plan.tasks) {
      if (t.isDone && was.get(t.key) === false && !next[t.key]) next[t.key] = { at: now, by: 'file' }
    }
    return next
  })
  await update($, planA, () => plan)
  const fileDone = Object.fromEntries(Object.entries(done).filter(([, v]) => v.by === 'file'))
  await storeSet($, `seen:${plan.path}`, fileDone)
}

// A plan-like file a tool call just opened. It replaces the tracked plan when
// nothing is tracked, the tracked one came back from an earlier session, is
// finished, this one is being written, or this one is newer: an older plan
// opened for reference does not take over this session's plan.
async function consider($: $, path: string, isWrite: boolean) {
  if (!/\.(md|markdown)$/i.test(path)) return
  await allow($, path)
  const tracked = await read($, planA)
  if (tracked && same(tracked.path, path)) return reparse($)
  const plan = await load($, path)
  if (!plan || !(isPlanPath(path) || plan.kind === 'xml')) return
  const v = await view($)
  const isFinished = v !== null && v.doneCount === v.rows.length
  const isNewer = async () => ((await created($, path)) ?? Number.MAX_SAFE_INTEGER) > (await read($, startedA))
  const isRestored = await read($, restoredA)
  if (!tracked || isRestored || isFinished || isWrite || !isPlanPath(tracked.path) || (await isNewer())) {
    await track($, path)
    return
  }
  const told = await storeGet<string[]>($, 'told', [])
  if (!told.includes(plan.path)) {
    $.ui.toast(`waiter: found plan "${plan.title}". /waiter ${plan.path} to track it`)
    await storeSet($, 'told', [...told, plan.path].slice(-50))
  }
}

function filePathOf(e: unknown): string | undefined {
  const p = (e as { file_path?: unknown }).file_path
  return typeof p === 'string' ? p : undefined
}

function commandOf(e: unknown): string {
  const c = (e as { command?: unknown }).command
  return typeof c === 'string' ? c : ''
}

function rowTime(r: Row): { text: string; color?: string } {
  if (r.state === 'done') return { text: r.tookMs !== undefined ? `took ${duration(r.tookMs)}` : 'done', color: 'green' }
  if (r.isReview) return { text: 'saved, in review', color: 'cyan' }
  if (r.state === 'current') {
    const left = r.leftMs ?? r.estMs
    if (r.stepAt !== undefined) return { text: `step ${r.stepAt}/${r.steps} ~${duration(left)}`, color: 'yellow' }
    return left >= 0 ? { text: `~${duration(left)} left`, color: 'yellow' } : { text: `over ${duration(left)}`, color: 'red' }
  }
  return { text: `~${duration(r.estMs)}` }
}

function glyph(r: Row): { text: string; color?: string } {
  if (r.state === 'done') return { text: '✓', color: 'green' }
  if (r.state === 'current') return { text: '▶', color: 'yellow' }
  return { text: '·' }
}

function headline(v: View): string {
  const pct = Math.round(v.fraction * 100)
  return `${pct}% · ${v.doneCount}/${v.rows.length} tasks · ~${duration(v.leftMs)} left · done by ${clock(v.etaAt)}`
}

async function onTasks($: $, tool: string, e: unknown, result: unknown) {
  const now = await $.clock.now()
  if (tool === 'TaskCreate') {
    const task = (result as { task?: { id?: string; subject?: string } } | undefined)?.task
    if (!task?.id) return
    const id = String(task.id)
    await update($, sessionA, list => [
      ...list.filter(s => s.id !== id),
      { id, subject: task.subject ?? '', status: 'pending' as const },
    ])
    return
  }
  if (tool === 'TaskUpdate') {
    const u = e as { taskId?: string; status?: string; subject?: string }
    if (!u.taskId) return
    await update($, sessionA, list =>
      u.status === 'deleted'
        ? list.filter(s => s.id !== u.taskId)
        : list.map(s => (s.id === u.taskId ? moved(s, u.status, u.subject, now) : s)),
    )
    return
  }
  const todos = (e as { todos?: { content: string; status: string }[] }).todos ?? []
  await update($, sessionA, list => {
    const by = new Map(list.map(s => [s.id, s]))
    return todos.map(t => {
      const was: WaiterSessionTask = by.get(t.content) ?? { id: t.content, subject: t.content, status: 'pending' }
      return moved(was, t.status, undefined, now)
    })
  })
}

function moved(s: WaiterSessionTask, status: string | undefined, subject: string | undefined, now: number): WaiterSessionTask {
  const next: WaiterSessionTask = { ...s, subject: subject ?? s.subject }
  if (status === 'in_progress' || status === 'completed' || status === 'pending') next.status = status
  if (status === 'in_progress' && next.startedAt === undefined) next.startedAt = now
  if (status === 'completed' && next.doneAt === undefined) next.doneAt = now
  return next
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'waiter',
      description: 'Plan progress and time left per task. /waiter [plan path | min | off | refresh]',
      argumentHint: '[plan path | min | off | refresh]',
    })
    const started = await next(e)

    // A redraw now and then moves the clocks; a re-read picks up work done elsewhere.
    $.clock.every(30_000, () => $.ui.invalidate('ui.render'))
    $.clock.every(60_000, () => {
      void reparse($).then(() => refreshGit($))
    })

    if ((await read($, modeA)) !== 'hidden') {
      const mode = await storeGet<WaiterMode>($, 'mode', 'pane')
      await update($, modeA, () => mode)
    }
    if (!(await read($, planA))) {
      // A new session in the same project picks its last plan back up.
      const last = await storeGet<string>($, `last:${norm(await $.session.root())}`, '')
      if (last) {
        void (async () => {
          if (!(await load($, last))) return
          await track($, last)
          await update($, restoredA, () => true)
          const v = await view($)
          if (v && v.doneCount === v.rows.length) await $.ui.close({ id: PANE })
        })()
      }
    }

    return started
  })

  on('command.run', { command: 'waiter' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === '' || arg === 'show' || arg === 'max') {
      if (!(await current($))) {
        return { text: 'waiter: no plan yet. Run /waiter <plan.md>, or read or execute a plan and it is picked up.' }
      }
      await setMode($, 'pane')
      return { text: 'waiter: pane opened.' }
    }
    if (arg === 'min') {
      await setMode($, 'band')
      return { text: 'waiter: minimized above the prompt.' }
    }
    if (arg === 'off') {
      await stop($)
      return { text: 'waiter: stopped tracking.' }
    }
    if (arg === 'refresh') {
      await reparse($)
      await refreshGit($)
      return { text: 'waiter: refreshed.' }
    }
    const path = await absolute($, arg)
    if (!(await openGuarded($, path))) return { text: `waiter: could not open ${path} (missing, or refused by a guard).` }
    if ((await read($, modeA)) === 'hidden') await update($, modeA, () => 'pane' as WaiterMode)
    return { text: `waiter: ${await track($, path)}` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const tool = String(e.tool)
    try {
      if (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
        const p = filePathOf(e)
        if (p) await consider($, await absolute($, p), tool !== 'Read')
      } else if ((tool === 'Bash' || tool === 'PowerShell') && /\bgit\b[\s\S]*\b(commit|merge|cherry-pick|rebase)\b/.test(commandOf(e))) {
        await refreshGit($)
      } else if (e.agentId === undefined && (tool === 'TaskCreate' || tool === 'TaskUpdate' || tool === 'TodoWrite')) {
        await onTasks($, tool, e, ran.result)
        if (!(await read($, planA))) await show($)
      }
    } catch (err) {
      // tracking never gets in the way of the tool
      $.ui.log(`waiter: ${String(err)}`, { to: 'debug' })
    }
    return ran
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    // The person closed the pane: keep the plan as the one-line band.
    if (e.origin.kind === 'person') await update($, modeA, () => 'band' as WaiterMode)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await view($)
    const cols = Math.max(30, e.props.bodyColumns)
    if (!v) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No plan tracked. /waiter path/to/plan.md, or start executing a plan.</Text>
          <Button key="minimize" label="Minimize" hotkey="m" onPress={() => setMode($, 'band')} />
        </Box>
      )
    }
    const note = await read($, noteA)
    const barW = Math.min(12, Math.max(6, Math.floor(cols / 6)))
    const titleW = Math.max(8, cols - barW - 18)
    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          {v.title}
        </Text>
        <Text color="green">{bar(v.fraction, Math.max(10, cols - 2))}</Text>
        <Text wrap="truncate-end">{headline(v)}</Text>
        <Text dimColor wrap="truncate-end">
          {note || v.kind} · {v.kind === 'session' ? `${duration(v.rate)} per task` : `${duration(v.rate * 10)} per 10 plan lines`}
          {v.measured > 0 ? ` (learned from ${v.measured} done)` : ' (first guess)'}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {v.rows.map(r => {
            const g = glyph(r)
            const t = rowTime(r)
            return (
              <Box key={r.key} flexDirection="column">
               <Box flexDirection="row">
                <Text color={g.color}>{g.text} </Text>
                <Box width={titleW}>
                  <Text wrap="truncate-end" dimColor={r.state === 'done'} bold={r.state === 'current'}>
                    {r.title}
                    {r.isManual ? ' [you]' : ''}
                  </Text>
                </Box>
                <Text color={r.state === 'todo' ? undefined : g.color} dimColor={r.state === 'todo'}>
                  {' '}
                  {bar(r.fraction, barW)}{' '}
                </Text>
                <Text color={t.color} dimColor={r.state === 'todo'}>
                  {t.text}
                </Text>
               </Box>
               {r.stepTitle !== undefined && (
                <Text dimColor wrap="truncate-end">
                  {'    '}step {r.stepAt} of {r.steps}: {r.stepTitle}
                </Text>
               )}
              </Box>
            )
          })}
        </Box>
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Button key="minimize" label="Minimize" hotkey="m" onPress={() => setMode($, 'band')} />
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => reparse($).then(() => refreshGit($))} />
          <Button key="stop" label="Stop tracking" onPress={() => stop($)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, modeA)) !== 'band') return next(e)
    const v = await view($)
    if (!v) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const cur = v.rows.find(r => r.state === 'current')
    const curText = cur ? ` · ▶ ${cur.title.slice(0, 40)} ${rowTime(cur).text}` : ''
    return (
      <Box flexDirection="row" gap={1}>
        <Text bold>waiter</Text>
        <Text color="green">{bar(v.fraction, 16)}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            {Math.round(v.fraction * 100)}% {v.doneCount}/{v.rows.length}
            {curText} · all ~{duration(v.leftMs)}, by {clock(v.etaAt)}
          </Text>
        </Box>
        <Button key="expand" label="Expand" hotkey="e" onPress={() => setMode($, 'pane')} />
        <Button key="hide" label="Hide" onPress={() => setMode($, 'hidden')} />
      </Box>
    )
  })
}
