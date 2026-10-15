import { test, expect } from '@playwright/test'
const notebookTransport = `
export * from '/src/services/tauri-invoke.ts?notebook-original';
const documents = { '目标.md':'---\\naliases: [别名]\\ntags: [work/team]\\npriority: 3\\nunknown: {x: y}\\n---\\n# 标题\\n\\n- [ ] 中文任务\\n', '目录/引用.md':'[[目标#标题|显示]]\\n\\n别名 未链接提及\\n', 'Templates/example.md':'# {{title}}\\n{{date}}\\n' };
const root = 'C:/测试项目';
const relative = path => path.replaceAll('\\\\','/').slice(root.length+1);
const templateReadState = globalThis.__notebookTemplateReadState ??= { blocked:false, pending:false, release:null };
export const setTemplateReadBlocked = value => { templateReadState.blocked = value };
export const hasPendingTemplateRead = () => templateReadState.pending;
export const releasePendingTemplateRead = () => { templateReadState.blocked = false; templateReadState.release?.(); templateReadState.release = null };
export const notesConfig = async (_, value) => value || {templateDirectory:'Templates',dailyDirectory:'Daily',dailyFormat:'YYYY-MM-DD',dailyTemplate:'builtin:work'};
export const notesList = async()=>Object.entries(documents).map(([relative,markdown])=>({relative,path:root+'/'+relative,size:markdown.length,modified:1}));
export const notesRead = async(_, path)=> {if(templateReadState.blocked && path.startsWith('Templates/')) await new Promise(resolve=>{templateReadState.pending=true;templateReadState.release=()=>{templateReadState.pending=false;resolve()}});if(!(path in documents))throw new Error('not found');return {path:root+'/'+path,markdown:documents[path],encoding:'utf8',lineEnding:'lf',bom:false,hadDecodeErrors:false,fingerprint:documents[path]}};
export const readMarkdown = async path => notesRead(root,relative(path));
export const notesCreate = async(_, path, markdown)=>{if(path in documents)throw new Error('already exists');documents[path]=markdown;return root+'/'+path};
export const saveMarkdown = async(path, markdown)=>{documents[relative(path)]=markdown};
export const localHistorySettings = async value => value || {intervalSeconds:60,retentionDays:30,maxMegabytes:256};
export const localHistoryList = async path => [{id:'history-version-1',path,timestamp:1,size:12,contentId:'a'.repeat(64)}];
export const localHistoryRead = async path => ({id:'history-version-1',path,timestamp:1,markdown:'historical version'});
export const localHistoryCapture = async (path, markdown, force) => {
  globalThis.__historyCaptureArgs = {path, markdown, force};
  if (globalThis.__deferHistoryCapture) await new Promise(resolve => { globalThis.__resumeHistoryCapture = resolve });
};
`
async function setupNotebook(page: import('@playwright/test').Page) {
  await page.route('**/src/services/tauri-invoke.ts*', route => route.request().url().includes('notebook-original') ? route.continue() : route.fulfill({ contentType: 'text/javascript', body: notebookTransport }))
  await page.goto('/')
  await page.locator('.muya-host [contenteditable="true"]').first().waitFor()
  await page.evaluate(async () => {
    const projects = '/src/stores/project.ts'; const notes = '/src/stores/notebook.ts'; const editors = '/src/stores/editor.ts'; const layouts = '/src/stores/layout.ts'
    const project = (await import(projects)).useProjectStore()
    project.projectTree = { id:'root',name:'测试项目',pathname:'C:/测试项目',isDirectory:true,isFile:false,isRoot:true,folders:[],files:[],isCollapsed:false,childrenLoaded:true }
    const notebook = (await import(notes)).useNotebookStore(); await notebook.rebuild(true)
    const editor = (await import(editors)).useEditorStore(); await editor.openFile('C:/测试项目/目标.md'); editor.sourceCodeMode = true
    const layout = (await import(layouts)).useLayoutStore(); layout.rightColumn = 'notes'
  })
  await expect(page.locator('.notebook-panel')).toBeVisible()
}
async function startDelayedTemplateRead(page: import('@playwright/test').Page) {
  await page.evaluate(async () => { const api = await import('/src/services/tauri-invoke.ts'); api.setTemplateReadBlocked(true); const notebook = (await import('/src/stores/notebook.ts')).useNotebookStore(); notebook.dialog = 'templates' })
  const template = page.getByRole('button', { name: 'Templates/example.md', exact: true })
  await expect(template).toBeEnabled()
  await template.click()
  await expect.poll(() => page.evaluate(async () => (await import('/src/services/tauri-invoke.ts')).hasPendingTemplateRead())).toBe(true)
}
test('split regions share edits, dirty state, undo and the active Agent target', async ({ page }) => {
  await page.goto('/')
  await page.locator('.muya-host [contenteditable="true"]').first().waitFor()
  await page.evaluate(async () => {
    const path = '/src/stores/editor.ts'; const editor = (await import(path)).useEditorStore()
    const tab = editor.newUntitledTab('original\n'); tab.pendingBaselineUpdate = false
    editor.sourceCodeMode = true; await new Promise(r => setTimeout(r, 20)); editor.splitPane('horizontal')
  })
  await expect(page.locator('.editing-region')).toHaveCount(2)
  const second = page.locator('.editing-region').nth(1)
  await second.locator('.cm-content').click()
  await page.keyboard.press('Control+a'); await page.keyboard.type('changed')
  await expect(page.locator('.editing-region').first().locator('.cm-content')).toHaveText('changed')
  await page.keyboard.press('Control+z')
  await expect(second.locator('.cm-content')).toHaveText('original')
  await page.keyboard.press('Control+y')
  await expect(second.locator('.cm-content')).toHaveText('changed')
  await page.evaluate(async () => {
    const path = '/src/stores/editor.ts'; const editor = (await import(path)).useEditorStore()
    editor.applyAgentEdit(editor.currentFileId, editor.currentFile.markdown, 'Agent edit')
  })
  await expect(second.locator('.cm-content')).toHaveText('Agent edit')
  await second.locator('.cm-content').click(); await page.keyboard.press('Control+z')
  await expect(second.locator('.cm-content')).toHaveText('changed')
  await page.evaluate(async () => {
    const path = '/src/stores/editor.ts'; const editor = (await import(path)).useEditorStore()
    editor.activatePane('main'); editor.newUntitledTab('independent')
  })
  await expect(page.locator('.editing-region').first().locator('.cm-content')).toHaveText('independent')
  await expect(second.locator('.cm-content')).toHaveText('changed')
})
test('two visual regions share edits and keep independent documents when switching', async ({ page }) => {
  await page.goto('/'); await page.locator('.muya-host [contenteditable="true"]').waitFor()
  await page.evaluate(async () => { const path = '/src/stores/editor.ts'; const editor = (await import(path)).useEditorStore(); const tab = editor.newUntitledTab('visual original\n'); tab.pendingBaselineUpdate = false; editor.splitPane('vertical') })
  const second = page.locator('.editing-region').nth(1).locator('.muya-host [contenteditable="true"]')
  await second.click(); await page.keyboard.press('Control+a'); await page.keyboard.type('visual changed')
  await expect(page.locator('.editing-region').first().locator('.muya-host [contenteditable="true"]')).toContainText('visual changed')
  await page.keyboard.press('Control+z'); await expect(second).toContainText('visual original')
  await page.keyboard.press('Control+y'); await expect(second).toContainText('visual changed')
  await page.evaluate(async () => { const path = '/src/stores/editor.ts'; const editor = (await import(path)).useEditorStore(); editor.activatePane('main'); editor.newUntitledTab('another visual') })
  await expect(page.locator('.editing-region').first().locator('.muya-host [contenteditable="true"]')).toContainText('another visual')
  await expect(second).toContainText('visual changed')
})
test('same-document source regions restore their own selection on activation', async ({ page }) => {
  await page.goto('/'); await page.locator('.muya-host [contenteditable="true"]').waitFor()
  await page.evaluate(async () => { const path = '/src/stores/editor.ts'; const editor = (await import(path)).useEditorStore(); const tab = editor.newUntitledTab('first line\nsecond line\n'); tab.pendingBaselineUpdate = false; editor.sourceCodeMode = true; await new Promise(r => setTimeout(r, 20)); editor.splitPane('horizontal') })
  const selection = () => page.evaluate(async () => { const path = '/src/stores/editor.ts'; return (await import(path)).useEditorStore().currentFile.sourceSelection })
  await page.locator('.editing-region').first().locator('.cm-line').first().click(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End')
  const leftSelection = await selection()
  await page.locator('.editing-region').nth(1).locator('.cm-line').nth(1).click(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End')
  const rightSelection = await selection(); expect(rightSelection).not.toEqual(leftSelection)
  await page.evaluate(async () => { const path = '/src/stores/editor.ts'; (await import(path)).useEditorStore().activatePane('main') })
  expect(await selection()).toEqual(leftSelection)
})
test('quick open, templates and notebook settings use localized command entries', async ({ page }) => {
  await page.goto('/')
  await page.locator('.muya-host [contenteditable="true"]').first().waitFor()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Quick open note' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Alt+t')
  await expect(page.getByRole('dialog', { name: 'Insert document template' })).toBeVisible()
  await page.getByRole('button', { name: 'Meeting notes', exact: true }).click()
  await expect(page.locator('.muya-host [contenteditable="true"]').first()).toContainText('Agenda')
})
test('template insertion keeps its pane, document, content and cursor target across async reads', async ({ page }) => {
  await setupNotebook(page)
  await expect(page.locator('.cm-content').first()).toBeVisible()
  await page.evaluate(async () => { const editor = (await import('/src/stores/editor.ts')).useEditorStore(); editor.splitPane('horizontal'); editor.activatePane('main') })
  const before = await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    const tab = editor.currentFile!
    return { markdown: tab.markdown, cursor: JSON.parse(JSON.stringify(tab.sourceSelection ?? null)), id: tab.id }
  })
  await startDelayedTemplateRead(page)
  await page.evaluate(async () => { const editor = (await import('/src/stores/editor.ts')).useEditorStore(); editor.activatePane(editor.panes[1].id) })
  await page.evaluate(async () => (await import('/src/services/tauri-invoke.ts')).releasePendingTemplateRead())
  await expect(page.getByRole('alert')).toContainText('The active document changed')
  const afterPaneSwitch = await page.evaluate(async id => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore(); const tab = editor.tabs.find(t => t.id === id)!
    return tab.markdown
  }, before.id)
  expect(afterPaneSwitch).toBe(before.markdown)
  await page.keyboard.press('Escape')
  await page.evaluate(async () => { const editor = (await import('/src/stores/editor.ts')).useEditorStore(); editor.activatePane('main') })
  await startDelayedTemplateRead(page)
  await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    editor.currentFile!.sourceSelection = { ranges: [{ anchor: 4, head: 4 }], main: 0 }
  })
  await page.evaluate(async () => (await import('/src/services/tauri-invoke.ts')).releasePendingTemplateRead())
  await expect(page.getByRole('alert')).toContainText('The active document changed')
  const afterCursorChange = await page.evaluate(async id => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore(); return editor.tabs.find(t => t.id === id)!.markdown
  }, before.id)
  expect(afterCursorChange).toBe(before.markdown)
})
test('indexes aliases, backlinks, tags and task edits through undo', async ({ page }) => {
  await setupNotebook(page)
  await expect(page.locator('.notebook-panel')).toContainText('目录/引用.md')
  await page.locator('.notebook-panel header select').selectOption('tags')
  await expect(page.locator('.notebook-panel')).toContainText('#work/team')
  await page.locator('.notebook-panel header select').selectOption('search')
  await page.locator('.notebook-panel form input').fill('tag:work prop.priority:>=2 task:open')
  await page.locator('.notebook-panel form').locator('button').first().click()
  await expect(page.locator('.notebook-panel')).toContainText('目标.md')
  await page.locator('.notebook-panel header select').selectOption('tasks')
  await expect(page.locator('.notebook-panel')).toContainText('中文任务')
  await page.getByRole('checkbox', { name: 'Complete task' }).click()
  await expect(page.locator('.cm-content').first()).toContainText('[x] 中文任务')
  await page.locator('.cm-content').first().click(); await page.keyboard.press('Control+z')
  await expect(page.locator('.cm-content').first()).toContainText('[ ] 中文任务')
  await page.locator('.notebook-panel header select').selectOption('properties')
  await page.locator('.properties .field').filter({ has: page.locator('strong', { hasText: /^priority$/ }) }).getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.properties form input[type=number]').fill('4')
  await page.locator('.properties form').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.properties [role="alert"]')).toHaveCount(0)
  await expect(page.locator('.properties form')).toHaveCount(0)
  await expect(page.locator('.cm-content').first()).toContainText('priority: 4')
  await expect(page.locator('.cm-content').first()).toContainText('unknown: {x: y}')
})
test('daily creation reopens existing content and quick open uses aliases', async ({ page }) => {
  await setupNotebook(page)
  await page.keyboard.press('Control+k')
  await page.locator('.note-picker input').fill('别名')
  await expect(page.locator('#note-results')).toContainText('目标.md')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+Alt+d')
  await expect(page.locator('.cm-content').first()).toContainText('Priorities')
  await page.locator('.cm-content').first().click(); await page.keyboard.press('Control+End'); await page.keyboard.type('kept unsaved')
  await page.keyboard.press('Control+Alt+d')
  await expect(page.locator('.cm-content').first()).toContainText('kept unsaved')
})
test('an index rebuild after cancellation recovers every file', async ({ page }) => {
  await setupNotebook(page)
  await page.evaluate(async () => {
    const module = '/src/stores/notebook.ts'; const notebook = (await import(module)).useNotebookStore()
    notebook.notes = []; await new Promise(r => setTimeout(r, 30))
    await notebook.rebuild(true); notebook.cancel()
    await new Promise(r => setTimeout(r, 30)); await notebook.rebuild(true)
  })
  await expect.poll(() => page.evaluate(async () => { const module = '/src/stores/notebook.ts'; return (await import(module)).useNotebookStore().analyses.length })).toBe(3)
  await expect(page.locator('.notebook-panel')).toContainText('目录/引用.md')
})
test('restored/new initial content is unsaved and link popup keeps its owning region', async ({ page }) => {
  await setupNotebook(page)
  await page.evaluate(async () => {
    const path = '/src/stores/editor.ts'; const editor = (await import(path)).useEditorStore()
    const tab = editor.newUntitledTab('restored history content')
    if (tab.isSaved || tab.lastSavedMarkdown !== '') throw new Error('new content was treated as saved')
    await editor.openFile('C:/测试项目/目录/引用.md'); editor.sourceCodeMode = false
  })
  await page.locator('.muya-host [contenteditable="true"]').first().waitFor()
  await page.evaluate(async () => { const path = '/src/stores/editor.ts'; const editor = (await import(path)).useEditorStore(); window.__linkOwner = editor.getMuyaInstance(); editor.splitPane('horizontal'); editor.activatePane(editor.panes[1].id); editor.newUntitledTab('other region') })
  await page.evaluate(() => { window.__linkOwner.linkTools.options.jumpClick({ href: '../目标.md#标题' }) })
  await expect.poll(() => page.evaluate(async () => { const path = '/src/stores/editor.ts'; const editor = (await import(path)).useEditorStore(); return [editor.activePaneId, editor.currentFile.pathname] })).toEqual(['main', 'C:/测试项目/目标.md'])
})
test('empty quick query follows recent-note order across Windows path spellings', async ({ page }) => {
  await setupNotebook(page)
  const paths = await page.evaluate(async () => { const n = '/src/stores/notebook.ts'; const p = '/src/stores/preferences.ts'; (await import(p)).usePreferencesStore().recentFiles = ['c:\\测试项目\\目录\\引用.md', 'c:\\测试项目\\目标.md']; return (await import(n)).useNotebookStore().quickResults('').map(n => n.relative) })
  expect(paths).toEqual(['目录/引用.md', '目标.md'])
})
test('history restore rechecks the document path after its protection snapshot resolves', async ({ page }) => {
  await setupNotebook(page)
  await page.evaluate(async () => {
    const notebook = (await import('/src/stores/notebook.ts')).useNotebookStore()
    ;(window as any).__deferHistoryCapture = true
    notebook.dialog = 'history'
  })
  await expect(page.getByRole('dialog', { name: 'Local history' })).toBeVisible()
  await page.locator('.versions button').first().click()
  await page.getByRole('button', { name: 'Restore current document' }).click()
  await page.getByRole('button', { name: 'OK', exact: true }).click()
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__resumeHistoryCapture))).toBe(true)

  const before = await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    const tab = editor.currentFile!
    const markdown = tab.markdown
    tab.pathname = 'C:/测试项目/移动后.md'
    return markdown
  })
  await page.evaluate(() => (window as any).__resumeHistoryCapture())
  await expect(page.getByRole('alert')).toContainText('The active document changed')
  const after = await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    return { pathname: editor.currentFile!.pathname, markdown: editor.currentFile!.markdown }
  })
  expect(after.pathname).toBe('C:/测试项目/移动后.md')
  expect(after.markdown).toBe(before)
  expect(after.markdown).not.toBe('historical version')
})
