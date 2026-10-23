// Real isolated WebView2 measurements. Not an input-to-photon benchmark.
import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { renderLongDocument, renderOneMiBMarkdown, generateProject } from './m0-generate-fixtures.mjs'
const base=path.resolve('output/m1-native')
const root=path.join(base,'performance-'+Date.now())
await mkdir(root,{recursive:true})
const longPath=path.join(root,'long-200k.md'), bigPath=path.join(root,'markdown-1mib.md')
await writeFile(longPath,renderLongDocument())
await writeFile(bigPath,renderOneMiBMarkdown())
const browser=await chromium.connectOverCDP(process.env.M1_CDP_URL??'http://127.0.0.1:9335')
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('localhost:1420'))
if(!page)throw new Error('Expected isolated native dev WebView')
const receipt={native:true,backendMocked:false,root,measurements:[],success:false}
const indexOnly=process.argv.includes('--index-only')
if(indexOnly){
  const prior=JSON.parse(await readFile(path.join(base,'performance.json'),'utf8'))
  receipt.measurements=prior.measurements.filter(m=>!['native-project-index','native-project-read'].includes(m.name)).map(m=>({...m,fromRun:prior.root}))
}
try {
  const identity=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:app|identifier'))
  if(identity!=='io.github.yulianjie.markcaptain.m1-validation')throw new Error('Refusing non-validation app')
  await page.evaluate(async base=>{
    const editor=(await import('/src/stores/editor.ts')).useEditorStore()
    if(editor.tabs.some(t=>t.pathname&&!t.pathname.replaceAll('\\','/').toLowerCase().startsWith(base.replaceAll('\\','/').toLowerCase()+'/')))throw new Error('Non-fixture document')
    const prefs=(await import('/src/stores/preferences.ts')).usePreferencesStore();prefs.autoSave=false
    for(const p of [...editor.panes])if(p.id!==editor.activePaneId)editor.closePane(p.id)
    for(const tab of [...editor.tabs])await editor.closeTab(tab.id,true)
    const layout=(await import('/src/stores/layout.ts')).useLayoutStore();layout.showInspector=false
  },base)
  for(const [name,file,source]of(indexOnly?[]:[['200k-codepoints-visual',longPath,false],['1MiB-source',bigPath,true]])) {
    const diskBefore = await readFile(file)
    const start=performance.now()
    await page.evaluate(async({file,source})=>{
      const editor=(await import('/src/stores/editor.ts')).useEditorStore()
      await editor.openFile(file);editor.sourceCodeMode=source
      const pane=editor.panes.find(p=>p.id===editor.activePaneId);if(pane)pane.sourceMode=source
    },{file,source})
    const editable=page.locator(source?'.editing-region.active .cm-content':'.editing-region.active .muya-host [contenteditable="true"]')
    await expect(editable).toBeVisible({timeout:60000})
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    const openToReadyMs=performance.now()-start
    const metrics=await page.evaluate(async()=>{
      const e=(await import('/src/stores/editor.ts')).useEditorStore()
      return {characters:Array.from(e.currentFile.markdown).length,bytes:new TextEncoder().encode(e.currentFile.markdown).length,source:e.sourceCodeMode}
    })
    const timings=[]
    await editable.click()
    await page.keyboard.press('Control+End')
    for(let i=0;i<12;i++){
      const begin=performance.now();await page.keyboard.insertText('x')
      await page.evaluate(async()=>{const e=(await import('/src/stores/editor.ts')).useEditorStore();return e.currentFile.markdown.length})
      timings.push(performance.now()-begin)
    }
    timings.sort((a,b)=>a-b)
    receipt.measurements.push({name,...metrics,openToReadyMs,cdpInputAndModelCommitMs:{p50:timings[5],p95:timings[11],samples:12}})
    await page.evaluate(async()=>{const e=(await import('/src/stores/editor.ts')).useEditorStore();await e.closeTab(e.currentFileId,true)})
    if(!(await readFile(file)).equals(diskBefore))throw new Error('Performance input unexpectedly saved')
  }
  for(const files of [1200,10000]) {
    const project=path.join(root,'project-'+files);await generateProject(project,files)
    const begin=performance.now()
    const result=await page.evaluate(async({project,files})=>{
      const p=(await import('/src/stores/project.ts')).useProjectStore()
      const n=(await import('/src/stores/notebook.ts')).useNotebookStore()
      const start=performance.now();await p.openRoot(project);await n.rebuild(true)
      return {files,notes:n.notes.length,elapsedMs:performance.now()-start,indexing:n.indexing,error:n.error}
    },{project,files})
    await expect.poll(()=>page.evaluate(async()=>{const n=(await import('/src/stores/notebook.ts')).useNotebookStore();return n.notes.length}),{timeout:120000}).toBe(files)
    const final=await page.evaluate(async()=>{const n=(await import('/src/stores/notebook.ts')).useNotebookStore();return {notes:n.notes.length,error:n.error}})
    if(final.error)throw new Error(JSON.stringify(final))
    receipt.measurements.push({name:'native-project-read',...result,...final,elapsedMs:performance.now()-begin})
  }
  receipt.success=true
} finally {
  await writeFile(path.join(base,'performance.json'),JSON.stringify(receipt,null,2))
  console.log(JSON.stringify(receipt,null,2));await browser.close()
}
