import { test, expect } from '@playwright/test'

// The desktop transport is delayed deliberately. Components and both editors
// remain real, so changes arriving across an IPC boundary exercise the guards.
const transport = `
export * from '/src/services/tauri-invoke.ts?review-original';
const root = 'C:/review';
const docs = {'note.md':'current content\\n','Templates/example.md':'inserted template'};
export const notesConfig = async () => ({templateDirectory:'Templates',dailyDirectory:'Daily',dailyFormat:'YYYY-MM-DD',dailyTemplate:''});
export const notesList = async () => Object.entries(docs).map(([relative,markdown]) => ({relative,path:root+'/'+relative,size:markdown.length,modified:1}));
export const notesRead = async (_, relative) => {
  if (window.__delayTemplate && relative === 'Templates/example.md') {
    window.__templateStarted = true;
    await new Promise(resolve => { window.__finishTemplate = resolve });
  }
  return {path:root+'/'+relative,markdown:docs[relative],encoding:'utf8',lineEnding:'lf',bom:false,hadDecodeErrors:false,fingerprint:docs[relative]};
};
export const readMarkdown = async path => notesRead(root,path.slice(root.length+1));
export const localHistoryList = async path => [{id:'older',path,timestamp:1,size:5,contentId:'fixture'}];
export const localHistoryRead = async path => ({id:'older',path,timestamp:1,markdown:'older content'});
export const localHistorySettings = async () => ({intervalSeconds:60,retentionDays:30,maxMegabytes:256});
export const localHistoryCapture = async () => {
  window.__captureStarted = true;
  await new Promise(resolve => { window.__finishCapture = resolve });
};
`
async function setup(page: import('@playwright/test').Page) {
  await page.route('**/src/services/tauri-invoke.ts*', route => route.request().url().includes('review-original') ? route.continue() : route.fulfill({ contentType: 'text/javascript', body: transport }))
  await page.goto('/')
  await page.locator('.muya-host [contenteditable=true]').first().waitFor()
  await page.evaluate(async () => {
    const p = '/src/stores/project.ts'; const n = '/src/stores/notebook.ts'; const e = '/src/stores/editor.ts'
    ;(await import(p)).useProjectStore().projectTree = {id:'root',name:'review',pathname:'C:/review',isDirectory:true,isFile:false,isRoot:true,folders:[],files:[],isCollapsed:false,childrenLoaded:true}
    await (await import(n)).useNotebookStore().rebuild(true)
    const editor = (await import(e)).useEditorStore(); await editor.openFile('C:/review/note.md'); editor.sourceCodeMode = true
  })
}

test('history restore refuses a document switch while the protection snapshot is pending', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => { const n = '/src/stores/notebook.ts'; (await import(n)).useNotebookStore().dialog = 'history' })
  await page.locator('.versions button').first().click()
  await page.getByRole('button', {name:'Restore current document',exact:true}).click()
  await page.locator('.el-message-box .el-button--primary').click()
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as {__captureStarted?:boolean}).__captureStarted))).toBe(true)
  await page.evaluate(async () => {
    const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore()
    editor.newUntitledTab('other document')
    ;(window as unknown as {__finishCapture:()=>void}).__finishCapture()
  })
  await expect(page.getByRole('alert').filter({hasText:'The active document changed'})).toBeVisible()
  const documents = await page.evaluate(async () => { const e = '/src/stores/editor.ts'; return (await import(e)).useEditorStore().tabs.map(tab => tab.markdown) })
  expect(documents.map(markdown => markdown.trimEnd())).toContain('current content')
  expect(documents.map(markdown => markdown.trimEnd())).toContain('other document')
  expect(documents.some(markdown => markdown.includes('older content'))).toBe(false)
})

test('template insertion refuses the same document in another region after a delayed read', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    const e = '/src/stores/editor.ts'; const n = '/src/stores/notebook.ts'
    ;(await import(e)).useEditorStore().splitPane('horizontal')
    ;(window as unknown as {__delayTemplate:boolean}).__delayTemplate = true
    ;(await import(n)).useNotebookStore().dialog = 'templates'
  })
  await page.getByRole('button', {name:'Templates/example.md',exact:true}).click()
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as {__templateStarted?:boolean}).__templateStarted))).toBe(true)
  await page.evaluate(async () => {
    const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore(); editor.activatePane(editor.panes[1].id)
    ;(window as unknown as {__finishTemplate:()=>void}).__finishTemplate()
  })
  await expect(page.getByRole('alert').filter({hasText:'The active document changed'})).toBeVisible()
  const markdown = await page.evaluate(async () => { const e = '/src/stores/editor.ts'; return (await import(e)).useEditorStore().currentFile.markdown })
  expect(markdown).toBe('current content\n')
})

test('a delayed hidden Muya render cannot erase an immediate source edit in shared regions', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore()
    editor.newUntitledTab('restored version'); editor.splitPane('horizontal')
    ;(window as unknown as {__hiddenMuya:unknown}).__hiddenMuya = editor.getMuyaInstance()
  })
  const second = page.locator('.editing-region').nth(1).locator('.cm-content')
  await second.click(); await page.keyboard.press('Control+a'); await page.keyboard.type('source edit kept')
  await page.evaluate(() => { (window as unknown as {__hiddenMuya:{dispatchChange:()=>void}}).__hiddenMuya.dispatchChange() })
  await expect(second).toHaveText('source edit kept')
  await expect(page.locator('.editing-region').first().locator('.cm-content')).toHaveText('source edit kept')
  expect(await page.evaluate(async () => { const e = '/src/stores/editor.ts'; return (await import(e)).useEditorStore().currentFile.isSaved })).toBe(false)
})
