// What a plan's structure came from: task headings, numbered headings, GSD
// <task> blocks, a top-level checkbox list, plain sections, or the
// session's own task list (TaskCreate / TodoWrite).
export type WaiterKind =
  | 'headings'
  | 'numbered'
  | 'xml'
  | 'checkboxes'
  | 'sections'
  | 'session'

export type WaiterTask = {
  key: string
  // The task's number as the plan writes it ("6", "2.1"), when it has one.
  num?: string
  // The word in front of the number ("Task", "Phase"): what commits say.
  noun?: string
  title: string
  // Effort proxy: non-blank lines of the task's section (1 per session task).
  weight: number
  steps: number
  stepsDone: number
  // Each step's title, and the files it is the first to name.
  stepTitles?: string[]
  stepFiles?: string[][]
  isDone: boolean
  // A hands-on task (CONTROLLER, manual, acceptance): flat estimate, not learned from.
  isManual: boolean
}

export type WaiterPlan = {
  title: string
  // Absolute path with forward slashes; '' for the session task list.
  path: string
  kind: WaiterKind
  // Delivery / phase token from the title ("4b"), used to filter commits.
  token?: string
  tasks: WaiterTask[]
}

export type WaiterSessionTask = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  startedAt?: number
  doneAt?: number
}

// When each task was seen finished (epoch ms), by task key, and by what.
export type WaiterDone = Record<string, { at: number; by: 'git' | 'file' | 'session' }>

export type WaiterMode = 'pane' | 'band' | 'hidden'

declare module 'claude-code' {
  interface PluginState {
    waiter: {
      plan: WaiterPlan | null
      done: WaiterDone
      session: WaiterSessionTask[]
      // When tracking of this plan started (plan file creation, or first seen).
      startedAt: number
      // Learned milliseconds per weight unit (lines), across plans and projects.
      rate: number
      mode: WaiterMode
      note: string
      // The plan came back from an earlier session, not from this one's work.
      isRestored: boolean
      // Files changed and not yet committed, in every working folder of the plan's repo.
      changed: string[]
    }
  }
}
