// Native scan/index/search responsiveness with an isolated project fixture.
import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
const output = path.resolve('output/notebook-native')
const root = path.join(output, `scale-${Date.now()}`)
await mkdir(root, { recursive: true })
const count = 1200
for (let i = 0; i < count; i += 40) await Promise.all(Array.from({ length: Math.min(40, count - i) }, (_, offset) => {
  const n = i + offset
  return writeFile(path.join(root, `${n}.md`), `---\ntags: [scale]\naliases: [scale-${n}]\n---\n# Note ${n}\n\n- [ ] task ${n}\n\n${'text '.repeat(300)}\n`)
}))
const browser = await chromium.connectOverCDP('http://127.0.0.1:9335')
const page = browser.contexts().flatMap(context => context.pages()).find(page => /localhost:1420/.test(page.url()))
if (!page) throw new Error('No isolated debug webview')
const receipt = { native: true, backendMocked: false, files: count, success: false }
try {
  const previousRoot = await page.evaluate(async root => {
    const p = '/src/stores/project.ts'; const n = '/src/stores/notebook.ts'
    const project = (await import(p)).useProjectStore(); const notebook = (await import(n)).useNotebookStore()
    const previousRoot = project.projectTree?.pathname
    await project.openRoot(root)
    await notebook.rebuild(true)
    return previousRoot
  }, root)
  // Opening a root also schedules its configuration/index hydration. Let that
  // complete before measuring an explicit cancel/rebuild operation.
  await expect.poll(() => page.evaluate(async () => { const n = '/src/stores/notebook.ts'; return (await import(n)).useNotebookStore().notes.length }), { timeout: 20000 }).toBe(count)
  const result = await page.evaluate(async () => {
    const n = '/src/stores/notebook.ts'; const notebook = (await import(n)).useNotebookStore()
    const cancelled = notebook.rebuild(true)
    notebook.cancel()
    const cancelledImmediately = !notebook.busy && !notebook.indexing
    await cancelled
    let beats = 0; const timer = setInterval(() => beats++, 10); const start = performance.now()
    await notebook.rebuild(true)
    clearInterval(timer)
    return { cancelledImmediately, beats, elapsedMs: Math.round(performance.now() - start), notes: notebook.notes.length, errors: notebook.notes.filter(note => note.error).length }
  })
  Object.assign(receipt, result)
  if (!result.cancelledImmediately || result.notes !== count || result.errors || result.beats < 5) throw new Error('Native index did not cancel/recover/yield correctly')
  await expect.poll(() => page.evaluate(async () => { const n = '/src/stores/notebook.ts'; return (await import(n)).useNotebookStore().analyses.length })).toBe(count)
  await page.evaluate(async () => { const l = '/src/stores/layout.ts'; const n = '/src/stores/notebook.ts'; (await import(l)).useLayoutStore().rightColumn = 'notes'; (await import(n)).useNotebookStore().panel = 'search' })
  const input = page.locator('.notebook-panel form input')
  await input.fill('tag:scale task:open'); await input.press('Enter')
  await expect(page.locator('.notebook-panel')).toContainText('1200 results')
  await expect(page.locator('.notebook-panel .result')).toHaveCount(1000)
  receipt.success = true
  if (previousRoot) await page.evaluate(async root => { const p = '/src/stores/project.ts'; await (await import(p)).useProjectStore().openRoot(root) }, previousRoot)
} catch (error) { receipt.error = String(error); throw error }
finally { await writeFile(path.join(output, 'scale-receipt.json'), JSON.stringify(receipt, null, 2)); await browser.close() }
