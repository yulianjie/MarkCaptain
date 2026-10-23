import { expect, test, type Page } from '@playwright/test'
import type { AgentRequest } from '../../src/services/agent'
import type { AgentDocumentVersion } from '../../src/services/tauri-invoke'

declare global {
  interface Window {
    __a07Requests: AgentRequest[]
    __a07Disk: Record<string, AgentDocumentVersion>
    __a07Saves: { path: string; markdown: string }[]
    __a07Hold: boolean
    __a07Finish: () => void
  }
}

// Keep the real controller, editor, Muya/CodeMirror and dialog. Only model
// transport and filesystem IPC are deterministic fixtures.
const transportFixture = `
const listeners = new Set();
window.__a07Requests = []; window.__a07Hold = false;
export const agentTransport = {
  historySettings: async()=>({enabled:false}), historyList: async()=>[],
  getConfig: async()=>({baseUrl:'http://localhost:11434/v1',model:'a07-fixture',authMode:'none',hasKey:false,hasHeaders:false}),
  listSkills: async()=>[],
  listen: async handler => {listeners.add(handler);return ()=>listeners.delete(handler)},
  cancel: async()=>{},
  start: async request => {
    window.__a07Requests.push(request);
    const send=event=>listeners.forEach(handler=>handler({requestId:request.requestId,...event}));
    window.__a07Finish = () => {
      for (const document of request.editableDocuments ?? []) {
        const oldText = document.markdown.includes('Alpha') ? 'Alpha' : 'Beta';
        const from = document.markdown.indexOf(oldText);
        send({kind:'proposal',proposal:{documentId:document.documentId,title:'Revise '+document.name,
          changes:[{oldText,newText:oldText+' revised',anchor:{snapshotId:document.snapshotId,from,to:from+oldText.length}}]}});
      }
      send({kind:'done'});
    };
    if (!window.__a07Hold) setTimeout(()=>window.__a07Finish(), 15);
  },
};`

const ipcFixture = `
export * from '/src/services/tauri-invoke.ts?a07-original';
window.__a07Disk = {}; window.__a07Saves = [];
export const agentDocumentVersions = async paths => paths.map(path=>({...window.__a07Disk[path]}));
export const saveMarkdown = async (path, markdown) => {window.__a07Saves.push({path,markdown})};
export const localHistoryCapture = async()=>{};
`

const errors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const collected: string[] = []
  errors.set(page, collected)
  page.on('pageerror', error => collected.push(error.message))
})
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]) })

async function setup(page: Page, source: boolean) {
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/src/services/agent-transport.ts*', route => route.fulfill({ contentType: 'text/javascript', body: transportFixture }))
  await page.route('**/src/services/tauri-invoke.ts*', route => route.request().url().includes('a07-original')
    ? route.continue() : route.fulfill({ contentType: 'text/javascript', body: ipcFixture }))
  await page.goto('/')
  await page.locator('.muya-host [contenteditable="true"]').first().waitFor()
  const ids = await page.evaluate(async source => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    const prefs = (await import('/src/stores/preferences.ts')).usePreferencesStore()
    Object.assign(prefs, { language: 'en', theme: 'light', autoSave: false, sideBarVisibility: false })
    ;(await import('/src/i18n/index.ts')).setLocale('en')
    if (editor.startupHydrationPending) editor.finishStartupHydration()
    const documents = [['alpha.md', '# First\n\nAlpha original.\n'], ['beta.md', '# Second\n\nBeta original.\n'], ['private.md', 'Unselected private draft.\n']]
    const created = documents.map(([name, markdown]) => {
      const tab = editor.newUntitledTab(markdown)
      tab.filename = name; tab.pathname = `C:/a07/${name}`
      tab.lastSavedMarkdown = markdown; tab.isSaved = true; tab.pendingBaselineUpdate = false
      return tab
    })
    for (const tab of created) tab.sourceMode = source
    editor.tabs = created
    editor.setCurrent(created[0].id)
    editor.sourceCodeMode = source
    editor.splitPane('horizontal')
    editor.activatePane(editor.panes[1].id)
    editor.setCurrent(created[1].id)
    return created.map(tab => tab.id)
  }, source)
  // Set the baseline after the real editor's initial parse/normalization.
  await expect(page.locator('.editing-region')).toHaveCount(2)
  await page.locator('.editing-region.active').locator(source ? '.cm-content' : '.muya-host [contenteditable="true"]').waitFor()
  await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    for (const tab of editor.tabs) {
      tab.pendingBaselineUpdate = false; tab.lastSavedMarkdown = tab.markdown; tab.isSaved = true
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tab.markdown.replace(/\r\n?/g, '\n')))
      const contentHash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
      window.__a07Disk[tab.pathname] = { path: tab.pathname, contentHash, fingerprint: `raw-${contentHash}` }
    }
    ;(await import('/src/stores/preferences.ts')).usePreferencesStore().autoSave = true
  })
  await page.getByRole('button', { name: /^AI assistant(?: \(.+\))?$/ }).click()
  await page.getByTestId('agent-multi-open').click()
  await expect(page.getByTestId('agent-multi-dialog')).toBeVisible()
  return ids
}

async function contents(page: Page) {
  return page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore().tabs.map(tab => tab.markdown))
}

async function send(page: Page, ids: string[]) {
  for (const id of ids) await page.locator(`[data-testid="agent-multi-candidate"][value="${id}"]`).check()
  await page.getByTestId('agent-multi-prompt').fill('Polish only the selected documents')
  await page.getByTestId('agent-multi-send').click()
  await expect(page.getByTestId('agent-multi-target')).toHaveCount(ids.length)
}

for (const source of [false, true]) {
  test(`A07 explicit per-file review and independent split-pane undo in ${source ? 'source' : 'WYSIWYG'}`, async ({ page }) => {
    const ids = await setup(page, source)
    const original = await contents(page)
    await expect(page.locator('[data-testid="agent-multi-candidate"]:checked')).toHaveCount(0)
    await expect(page.getByTestId('agent-multi-send')).toBeDisabled()
    expect(await page.evaluate(() => window.__a07Requests)).toEqual([])
    await send(page, ids.slice(0, 2))
    const cards = page.getByTestId('agent-multi-target')
    await expect(cards.nth(0).getByTestId('agent-multi-apply')).toBeEnabled()
    const sent = await page.evaluate(() => window.__a07Requests[0])
    expect(sent.context).toBeNull()
    expect(sent.editableDocuments?.map(document => document.name)).toEqual(['alpha.md', 'beta.md'])
    expect(JSON.stringify(sent)).not.toContain('Unselected private draft')
    expect(await contents(page)).toEqual(original)
    await cards.nth(0).getByTestId('agent-multi-apply').click()
    await expect.poll(() => contents(page)).toEqual([original[0].replace('Alpha', 'Alpha revised'), original[1], original[2]])
    await cards.nth(1).getByTestId('agent-multi-apply').click()
    await expect.poll(() => contents(page)).toEqual([original[0].replace('Alpha', 'Alpha revised'), original[1].replace('Beta', 'Beta revised'), original[2]])
    await cards.nth(0).getByText('View original copy', { exact: true }).click()
    await expect(cards.nth(0).getByTestId('agent-multi-snapshot')).toHaveValue(original[0])
    await expect(cards.nth(0).getByTestId('agent-multi-snapshot')).toHaveAttribute('readonly', '')
    await cards.nth(0).getByTestId('agent-multi-locate').click()
    await expect(page.getByTestId('agent-multi-dialog')).toBeHidden()
    const input = page.locator('.editing-region.active').locator(source ? '.cm-content' : '.muya-host [contenteditable="true"]')
    await input.click()
    await page.keyboard.press('Control+z')
    await expect.poll(() => contents(page)).toEqual([original[0], original[1].replace('Beta', 'Beta revised'), original[2]])
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(() => contents(page)).toEqual([original[0].replace('Alpha', 'Alpha revised'), original[1].replace('Beta', 'Beta revised'), original[2]])
    await page.getByTestId('agent-multi-open').click()
    await cards.nth(1).getByTestId('agent-multi-revert').click()
    await expect.poll(() => contents(page)).toEqual([original[0].replace('Alpha', 'Alpha revised'), original[1], original[2]])
    expect(await page.evaluate(() => window.__a07Saves)).toEqual([])
  })
}

test('A07 disk conflict blocks only the affected file and preserves its original viewer', async ({ page }) => {
  const ids = await setup(page, true)
  const original = await contents(page)
  await send(page, ids.slice(0, 2))
  const cards = page.getByTestId('agent-multi-target')
  await expect(cards.nth(0).getByTestId('agent-multi-apply')).toBeEnabled()
  await page.evaluate(() => { window.__a07Disk['C:/a07/alpha.md'].fingerprint = 'outside-change' })
  await cards.nth(0).getByTestId('agent-multi-apply').click()
  await expect(cards.nth(0).getByTestId('agent-multi-apply')).toBeDisabled()
  await expect(cards.nth(0).getByRole('alert').first()).toContainText('no longer matches')
  await cards.nth(1).getByTestId('agent-multi-apply').click()
  await expect.poll(() => contents(page)).toEqual([original[0], original[1].replace('Beta', 'Beta revised'), original[2]])
  await cards.nth(0).getByText('View original copy', { exact: true }).click()
  await expect(cards.nth(0).getByTestId('agent-multi-snapshot')).toHaveValue(original[0])
  expect(await page.evaluate(() => window.__a07Saves)).toEqual([])
})

test('A07 stopping ignores late proposals and does not write any selected file', async ({ page }) => {
  const ids = await setup(page, true)
  const original = await contents(page)
  await page.evaluate(() => { window.__a07Hold = true })
  await send(page, ids.slice(0, 2))
  await page.getByTestId('agent-multi-cancel').click()
  await page.evaluate(() => window.__a07Finish())
  await expect(page.getByTestId('agent-multi-apply')).toHaveCount(0)
  expect(await contents(page)).toEqual(original)
  expect(await page.evaluate(() => window.__a07Saves)).toEqual([])
})
