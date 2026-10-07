import { expect, mock, test } from 'claude-code/testing'

const SCROLL = { offset: 0, bodyRows: 20 }

const PANE = {
  plugin: 'waiter',
  component: 'Pane',
  requestId: 'waiter',
  props: { title: 'Waiter', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: SCROLL, view: {} },
} as const

const BAND = {
  plugin: 'waiter',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: SCROLL, view: {} },
} as const

test('session tasks show in the pane; Minimize moves them to the band, Expand back', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const logs: string[] = []
  on('ui.log', async (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.close', async () => ({ value: undefined }))
  // The engine's own band: empty.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('tool.call', { tool: 'TodoWrite' }, async () => ({ result: { oldTodos: [], newTodos: [] } }))
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Write tests', status: 'completed', activeForm: 'Writing tests' },
      { content: 'Implement', status: 'in_progress', activeForm: 'Implementing' },
      { content: 'Review', status: 'pending', activeForm: 'Reviewing' },
    ],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /1\/3 tasks/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Implement/ })).toBeDefined()
    await pane.press({ key: 'minimize' })
    await pane.unmount()

    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ key: 'expand' })).toBeDefined()
    await band.press({ key: 'expand' })
    await band.unmount()

    const after = await $.ui.mount({ ...BAND, surface })
    expect(await after.find({ key: 'expand' })).toBe(undefined)
    await after.unmount()
  }
  expect(logs).toEqual([])
})
