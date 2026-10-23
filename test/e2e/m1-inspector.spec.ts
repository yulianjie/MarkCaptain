import { expect, test, type Page } from '@playwright/test'

const notebookTransport = `
export * from '/src/services/tauri-invoke.ts?m1-inspector-original';
const documents = {
  'target.md': '# Target note\\n\\nThis document has a backlink.\\n',
  'reference.md': 'See [[target|Target note]].\\n',
};
const root = 'C:/M1-notes';
const relative = path => path.replaceAll('\\\\','/').slice(root.length+1);
export const notesConfig = async (_, value) => value || {templateDirectory:'Templates',dailyDirectory:'Daily',dailyFormat:'YYYY-MM-DD',dailyTemplate:'builtin:work'};
export const notesList = async workspace => Object.entries(documents).map(([relative,markdown])=>({relative,path:workspace+'/'+relative,size:markdown.length,modified:1}));
export const notesRead = async (workspace,path) => { if(!(path in documents)) throw new Error('not found'); return {path:workspace+'/'+path,markdown:documents[path],encoding:'utf8',lineEnding:'lf',bom:false,hadDecodeErrors:false,fingerprint:documents[path]}; };
export const readMarkdown = async path => notesRead(root,relative(path));
export const notesCreate = async (_,path,markdown) => { if(path in documents) throw new Error('already exists'); documents[path]=markdown; return root+'/'+path; };
export const notesCancel = async () => undefined;
export const localHistorySettings = async value => value || {intervalSeconds:3600,retentionDays:30,maxMegabytes:256};
export const localHistoryCapture = async () => undefined;
`

const agentTransport = `
let handler;
const config = {baseUrl:'https://example.invalid/v1',model:'inspector-test-model',hasKey:false,hasHeaders:false};
export const agentTransport = {
  historySettings: async()=>({enabled:false}), historyList: async()=>[],
  getConfig: async()=>({...config}), saveConfig: async()=>({...config}), testConnection: async()=>{},
  listSkills: async()=>[], setSkillEnabled: async()=>[], removeSkill: async()=>[], readSkill: async(id)=>({id,instructions:'',files:[]}),
  listen: async(fn)=>{handler=fn;return()=>{handler=null}}, start: async()=>{}, cancel: async()=>{},
};`

async function setupInspector(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/src/services/tauri-invoke.ts*', route => route.request().url().includes('m1-inspector-original')
    ? route.continue()
    : route.fulfill({ contentType: 'text/javascript', body: notebookTransport }))
  await page.route('**/src/services/agent-transport.ts*', route => route.fulfill({ contentType: 'text/javascript', body: agentTransport }))
  await page.goto('/')
  await page.evaluate(async () => {
    const project = (await import('/src/stores/project.ts')).useProjectStore()
    project.projectTree = { id:'root',name:'M1 notes',pathname:'C:/M1-notes',isDirectory:true,isFile:false,isRoot:true,folders:[],files:[],isCollapsed:false,childrenLoaded:true }
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    if (editor.startupHydrationPending) editor.finishStartupHydration()
    const prefs = (await import('/src/stores/preferences.ts')).usePreferencesStore()
    prefs.sideBarVisibility = true
    prefs.autoSave = false
    editor.sourceCodeMode = true
    await editor.openFile('C:/M1-notes/target.md')
    const notebook = (await import('/src/stores/notebook.ts')).useNotebookStore()
    await notebook.rebuild(true)
    const layout = (await import('/src/stores/layout.ts')).useLayoutStore()
    layout.navigationPanel = 'files'
    layout.showInspector = true
    layout.inspectorPanel = 'links'
  })
  await page.locator('.editing-region').first().waitFor()
  await page.locator('.cm-content').first().waitFor()
  await expect(page.locator('.tree-pane')).toBeVisible()
  await expect(page.locator('.document-inspector .notebook-panel')).toBeVisible()
  await expect(page.locator('.source-group')).toHaveCount(1)
}

async function openFirstBacklink(page: Page, otherPane = false) {
  const group = page.locator('.source-group').filter({ hasText: 'reference.md' })
  await expect(group).toHaveCount(1)
  if (!await group.evaluate(element => (element as HTMLDetailsElement).open)) await group.locator(':scope > summary').click()
  if (otherPane) await group.getByRole('button', { name: 'Open in another split' }).click()
  else await group.getByRole('button', { name: 'Open source location: reference.md:1' }).click()
}

test('keeps file navigation beside links and returns from current or other-pane relation jumps', async ({ page }) => {
  await setupInspector(page)
  await expect(page.locator('.tree-pane')).toBeVisible()
  await expect(page.locator('.document-inspector')).toBeVisible()
  await expect(page.locator('.relation-section').first()).toContainText('Backlinks')

  await openFirstBacklink(page)
  await expect.poll(() => page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore().currentFile?.pathname)).toBe('C:/M1-notes/reference.md')
  await page.getByRole('button', { name: 'Back to previous location' }).click()
  await expect.poll(() => page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore().currentFile?.pathname)).toBe('C:/M1-notes/target.md')

  await openFirstBacklink(page, true)
  await expect(page.locator('.editing-region')).toHaveCount(2)
  const openedInOtherPane = await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    return [editor.activePaneId, editor.currentFile?.pathname]
  })
  expect(openedInOtherPane[0]).not.toBe('main')
  expect(openedInOtherPane[1]).toBe('C:/M1-notes/reference.md')
  await page.getByRole('button', { name: 'Back to previous location' }).click()
  await expect.poll(() => page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    return [editor.activePaneId, editor.currentFile?.pathname]
  })).toEqual(['main', 'C:/M1-notes/target.md'])
})

test('pins links with Agent, synchronizes Agent visibility, and reopens the inspector rail on narrow windows', async ({ page }) => {
  await setupInspector(page)
  const titlebarAgent = page.getByRole('button', { name: 'AI assistant' })
  await titlebarAgent.click()
  await expect(page.getByRole('tab', { name: 'Agent' })).toHaveAttribute('aria-selected', 'true')
  await expect(titlebarAgent).toHaveAttribute('aria-expanded', 'true')
  await titlebarAgent.click()
  await expect.poll(() => page.evaluate(async () => (await import('/src/stores/agent.ts')).useAgentStore().visible)).toBe(false)
  await expect(page.getByRole('tab', { name: 'Outline' })).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('tab', { name: 'Links' }).click()
  await page.getByRole('button', { name: 'Pin links above the current panel' }).click()
  await expect(page.getByRole('tab', { name: 'Agent' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.pinned-links .notebook-panel')).toBeVisible()
  await expect(page.locator('#agent-panel')).toBeVisible()
  await expect.poll(() => page.evaluate(async () => (await import('/src/stores/agent.ts')).useAgentStore().visible)).toBe(true)
  expect(await page.evaluate(() => localStorage.getItem('mt:documentInspectorLinksPinned'))).toBe('true')

  await page.setViewportSize({ width: 900, height: 760 })
  await expect(page.locator('.document-inspector')).toHaveCount(0)
  await expect(page.locator('.document-inspector-rail')).toBeVisible()
  await page.locator('.document-inspector-rail').getByRole('button', { name: 'Agent' }).click()
  await expect(page.locator('.document-inspector')).toBeVisible()
  await expect(page.locator('.document-inspector')).toHaveCSS('position', 'fixed')
  const agentBox = await page.locator('#agent-panel').evaluate(element => ({
    minWidth: getComputedStyle(element).minWidth,
    position: getComputedStyle(element).position,
    width: element.getBoundingClientRect().width,
    inspectorWidth: element.parentElement?.getBoundingClientRect().width ?? 0,
  }))
  expect(agentBox.minWidth).toBe('0px')
  expect(agentBox.position).toBe('relative')
  expect(agentBox.width).toBeLessThanOrEqual(agentBox.inspectorWidth + 1)

  await page.locator('#agent-panel').getByRole('button', { name: 'Close' }).click()
  await expect.poll(() => page.evaluate(async () => (await import('/src/stores/agent.ts')).useAgentStore().visible)).toBe(false)
  await expect(page.getByRole('tab', { name: 'Links' })).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('tab', { name: 'Agent' }).click()
  await expect(page.locator('#agent-panel')).toBeVisible()
  await expect.poll(() => page.evaluate(async () => (await import('/src/stores/agent.ts')).useAgentStore().visible)).toBe(true)

  await page.getByRole('button', { name: 'Hide inspector' }).click()
  await expect(page.locator('.document-inspector')).toHaveCount(0)
  await expect(page.locator('.document-inspector-rail')).toBeVisible()
  await page.locator('.document-inspector-rail').getByRole('button', { name: 'Outline' }).click()
  await expect(page.locator('.document-inspector .toc-pane')).toBeVisible()
  await expect(page.locator('.document-inspector-rail')).toHaveCount(0)
})
