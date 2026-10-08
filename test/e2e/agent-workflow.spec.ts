import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const pageErrors = new WeakMap<Page,string[]>()
test.beforeEach(({page})=>{
  const errors:string[]=[]
  pageErrors.set(page,errors)
  page.on('pageerror',error=>errors.push(error.message))
})
test.afterEach(({page})=>{expect(pageErrors.get(page)).toEqual([])})

// Independent workflow checks exercise the actual editor and review controls.
// Only the provider/IPC boundary is replaced; no editor behavior is mocked.
const fixture = `
let handler;
const loadHistory=()=>JSON.parse(localStorage.getItem('workflow-history')||'{"enabled":false,"records":[]}');
const saveHistory=value=>localStorage.setItem('workflow-history',JSON.stringify(value));
export const agentTransport = {
  getConfig: async()=>({baseUrl:'http://localhost:9999',model:'workflow-fixture',hasKey:false,hasHeaders:false}),
  listSkills: async()=>[],
  historySettings:async()=>({enabled:loadHistory().enabled}),
  historySetEnabled:async(enabled)=>{const h=loadHistory();h.enabled=enabled;saveHistory(h);return {enabled}},
  historyList:async()=>loadHistory().records,
  historyRead:async(id)=>loadHistory().records.find(r=>r.id===id),
  historyWrite:async(record)=>{
    const h=loadHistory();if(!h.enabled)throw new Error('agent:historyDisabled');
    const old=h.records.find(r=>r.id===record.id);
    const saved={...record,revision:(old?.revision??0)+1};
    h.records=h.records.filter(r=>r.id!==record.id);h.records.unshift(saved);saveHistory(h);return saved;
  },
  historyDelete:async(id,revision)=>{const h=loadHistory();h.records=h.records.filter(r=>r.id!==id);saveHistory(h)},
  listen: async(fn)=>{handler=fn;return ()=>{handler=null}},
  start: async(request)=>{
    window.__workflowRequest=request;
    const send=event=>handler?.({requestId:request.requestId,...event});
    if(request.readOnly){
      window.__summaryRequests??=[];
      window.__summaryRequests.push(request);
      if(window.__summaryRequests.length===window.__pauseSummaryAt)return;
      setTimeout(()=>{send({kind:'delta',text:'已归纳本部分材料，保留主要论点与限制。'});send({kind:'done'})},40);
      return;
    }
    setTimeout(()=>{
      if(request.messages.at(-1).content.startsWith('请按审阅意见重写修改项')){
        const reviewed=request.messages.find(message=>message.content.includes('[User review feedback]'));
        const feedback=JSON.parse(reviewed.content.split('[User review feedback]\\n')[1]);
        const target=feedback.changes.find(change=>request.messages.at(-1).content.includes(change.id));
        send({kind:'delta',text:'保留已接受的修改，按逐项意见继续。'});
        if(target)send({kind:'proposal',proposal:{title:'按意见重写',changes:[{oldText:target.oldText,newText:'最后一段，表达更克制。'}]}});
        send({kind:'done'});
        return;
      }
      if(request.messages.at(-1).content==='compare'){
        const reference=request.references[0];
        send({kind:'source',text:JSON.stringify({documentId:reference.documentId,startLine:1,endLine:1,label:'参考笔记依据',quote:reference.markdown.split('\\n')[0]})});
        send({kind:'delta',text:'当前笔记与参考笔记已经对照。'});
        send({kind:'done'});
        return;
      }
      if(request.messages.at(-1).content==='answer'){
        send({kind:'source',text:JSON.stringify({startLine:3,endLine:9,label:'首尾段落',quote:request.context.markdown.split('\\n').slice(2,9).join('\\n')})});
        send({kind:'delta',text:'## 阅读摘要\\n\\n这是一份可以保存的摘要。'});
        send({kind:'done'});
        return;
      }
      if(request.editRange){
        send({kind:'delta',text:'参考全文，仅修改附加选区。'});
        send({kind:'proposal',proposal:{title:'仅修改选区',changes:[{oldText:request.context.markdown.slice(request.editRange.from,request.editRange.to),newText:'选区已更新 🌱'}]}});
        send({kind:'done'});
        return;
      }
      send({kind:'delta',text:'修改了两个段落，保留中间的代码。'});
      send({kind:'proposal',proposal:{title:'两处独立修改',changes:[
        {oldText:'第一段 🌱',newText:'第一段已扩写 🌱，保留中文与表情。'},
        {oldText:'最后一段',newText:'最后一段已修改'}
      ]}});
      send({kind:'done'});
    },20);
  },
  cancel: async(id)=>handler?.({requestId:id,kind:'cancelled'}),
};`

async function setup(page: Page, source: boolean) {
  await page.route('**/src/services/agent-transport.ts', route => route.fulfill({ contentType: 'text/javascript', body: fixture }))
  await page.goto('/')
  await page.locator('.muya-host [contenteditable="true"]').waitFor()
  await page.evaluate(async source => {
    const ep='/src/stores/editor.ts', pp='/src/stores/preferences.ts', lp='/src/i18n/index.ts'
    const editor=(await import(ep)).useEditorStore()
    Object.assign((await import(pp)).usePreferencesStore(), {language:'zh-CN',theme:'light',autoSave:false,sideBarVisibility:false})
    ;(await import(lp)).setLocale('zh-CN')
    const tab=editor.newUntitledTab('# 独立审阅\n\n第一段 🌱\n\n```js\nconst untouched = true\n```\n\n最后一段\n')
    tab.pendingBaselineUpdate=false
    editor.tabs=[tab]
    editor.sourceCodeMode=source
  }, source)
  await page.getByRole('button', { name: /^AI 助手(?: \(.+\))?$/ }).click()
}

async function markdown(page: Page) {
  return page.evaluate(async()=>{const p='/src/stores/editor.ts';return (await import(p)).useEditorStore().currentFile.markdown as string})
}

async function propose(page: Page) {
  await page.getByRole('textbox', {name:'发送给写作助手的消息'}).fill('修改首尾两段')
  await page.getByRole('button', {name:'发送',exact:true}).click()
  await expect(page.locator('.agent-working')).toHaveCount(0)
  await expect(page.getByText('两处独立修改', {exact:true}).last()).toBeVisible()
}

test('sends item-level review feedback and rewrites only the requested rejected item', async ({page}) => {
  await setup(page, true)
  await propose(page)
  const first = page.locator('.agent-change').nth(0), second = page.locator('.agent-change').nth(1)
  const firstId = await first.getAttribute('data-change-id'), secondId = await second.getAttribute('data-change-id')
  expect(firstId).not.toBe(secondId)
  await first.getByRole('textbox', { name: '审阅意见（可选）' }).fill('保留这处扩写')
  await first.getByRole('button', { name: '应用此处', exact: true }).click()
  await second.getByRole('textbox', { name: '审阅意见（可选）' }).fill('保持克制，不要增加新事实')
  await second.getByRole('button', { name: '忽略此处', exact: true }).click()
  const accepted = await markdown(page)
  await second.getByRole('button', { name: '按这个意见重写', exact: true }).click()
  const request = await page.evaluate(() => (window as any).__workflowRequest)
  expect(request.messages.at(-1).content).toContain(secondId)
  expect(request.messages.at(-1).content).toContain('保持克制，不要增加新事实')
  expect(request.context.markdown).toBe(accepted)
  const feedback = JSON.parse(request.messages[1].content.split('[User review feedback]\n')[1])
  expect(feedback.changes[0]).toMatchObject({ id: firstId, status: 'applied', reason: '保留这处扩写' })
  expect(feedback.changes[1]).toMatchObject({ id: secondId, status: 'dismissed', oldText: '最后一段', reason: '保持克制，不要增加新事实' })
  await expect(page.locator('.agent-working')).toHaveCount(0)
  expect(await markdown(page)).toBe(accepted)
  await page.setViewportSize({ width: 540, height: 800 })
  expect(await page.locator('.agent-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: 'output/agent-feedback/review-narrow.png' })
})

async function answer(page: Page) {
  await page.getByRole('textbox', {name:'发送给写作助手的消息'}).fill('answer')
  await page.getByRole('button', {name:'发送',exact:true}).click()
  await expect(page.locator('.agent-markdown')).toContainText('这是一份可以保存的摘要。')
  await expect(page.locator('.agent-working')).toHaveCount(0)
}

for (const source of [false, true]) {
  test(`independent review applies disjoint Unicode changes and undoes the batch in ${source ? 'source' : 'wysiwyg'}`, async ({page})=>{
    await setup(page,source)
    const original=await markdown(page)
    await propose(page)
    expect(await markdown(page)).toBe(original)
    await page.getByRole('button', {name:'全部应用',exact:true}).click()
    await expect.poll(()=>markdown(page)).toContain('第一段已扩写 🌱，保留中文与表情。')
    expect(await markdown(page)).toContain('最后一段已修改')
    expect(await markdown(page)).toContain('```js\nconst untouched = true\n```')
    await page.evaluate(async()=>{const p='/src/bus.ts';(await import(p)).bus.emit('undo',undefined)})
    await expect.poll(()=>markdown(page)).toBe(original)
  })
}

test('partial review preserves accepted changes and blocks overwriting subsequent typing', async ({page})=>{
  await setup(page,true)
  await propose(page)
  await page.getByRole('button',{name:'应用此处',exact:true}).first().click()
  await expect.poll(()=>markdown(page)).toContain('第一段已扩写')
  expect(await markdown(page)).not.toContain('最后一段已修改')
  await page.getByRole('button',{name:'应用此处',exact:true}).click()
  await expect.poll(()=>markdown(page)).toContain('最后一段已修改')
  await page.getByRole('button',{name:'撤回已应用',exact:true}).click()
  await propose(page)
  await page.evaluate(async()=>{const p='/src/stores/editor.ts';const e=(await import(p)).useEditorStore();e.setMarkdownExternal(e.currentFileId,e.currentFile.markdown+'\n手动新增内容')})
  await page.getByRole('button',{name:'全部应用',exact:true}).last().click()
  await expect(page.locator('.agent-composer-error')).toContainText('文档已变化')
  expect(await markdown(page)).toContain('手动新增内容')
  expect(await markdown(page)).not.toContain('最后一段已修改')
})

test('multi-change review remains readable in narrow light and dark panels', async ({page})=>{
  await setup(page,false)
  await propose(page)
  for (const theme of ['light','dark']) {
    await page.evaluate(async theme=>{const p='/src/stores/preferences.ts';(await import(p)).usePreferencesStore().theme=theme},theme)
    await page.setViewportSize({width:540,height:850})
    const panel=page.locator('.agent-panel')
    expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
    await expect(page.getByRole('button',{name:'全部应用',exact:true})).toBeVisible()
    await page.screenshot({path:`output/agent-workflow/review-${theme}.png`})
  }
})

for (const source of [false,true]) {
  test(`completed answers append with undo and create a new note in ${source ? 'source':'wysiwyg'}`, async ({page})=>{
    await setup(page,source)
    const original=await markdown(page)
    await answer(page)
    await page.getByText('使用回答',{exact:true}).click()
    await page.getByRole('button',{name:'追加到文末',exact:true}).click()
    await expect.poll(()=>markdown(page)).toContain('这是一份可以保存的摘要。')
    expect(await markdown(page)).toContain('第一段 🌱')
    await page.evaluate(async()=>{const p='/src/bus.ts';(await import(p)).bus.emit('undo',undefined)})
    await expect.poll(()=>markdown(page)).toBe(original)
    await page.getByRole('button',{name:'新建 Markdown 笔记',exact:true}).click()
    await expect.poll(()=>markdown(page)).toContain('## 阅读摘要')
    const tabs=await page.evaluate(async()=>{const p='/src/stores/editor.ts';const e=(await import(p)).useEditorStore();return e.tabs.map((t:{markdown:string;isSaved:boolean})=>({markdown:t.markdown,isSaved:t.isSaved}))})
    expect(tabs).toHaveLength(2)
    expect(tabs[0].markdown).toBe(original)
    expect(tabs[1].isSaved).toBe(false)
  })

  test(`source references reveal a multiline passage without edits in ${source ? 'source':'wysiwyg'}`, async ({page})=>{
    await setup(page,source)
    const original=await markdown(page)
    await answer(page)
    await page.getByRole('button',{name:/首尾段落.*3.*9/}).click()
    expect(await markdown(page)).toBe(original)
    const selection=await page.evaluate(async source=>{
      const p='/src/stores/editor.ts';const e=(await import(p)).useEditorStore()
      if(source){const s=e.currentFile.sourceSelection;const r=s.ranges[s.main??0];return e.currentFile.markdown.slice(Math.min(r.anchor,r.head),Math.max(r.anchor,r.head))}
      return window.getSelection()?.toString()??''
    },source)
    expect(selection).toContain('第一段 🌱')
    expect(selection).toContain('最后一段')
  })

  test(`answer replaces an explicit selection and inserts at the cursor in ${source ? 'source':'wysiwyg'}`,async({page})=>{
    await setup(page,source)
    const original=await markdown(page)
    await answer(page)
    await page.getByRole('button',{name:/首尾段落.*3.*9/}).click()
    await page.getByText('使用回答',{exact:true}).click()
    await page.getByRole('button',{name:'替换选区',exact:true}).click()
    await expect.poll(()=>markdown(page)).toContain('这是一份可以保存的摘要。')
    expect(await markdown(page)).toContain('# 独立审阅')
    expect(await markdown(page)).not.toContain('第一段 🌱')
    await page.evaluate(async()=>{const p='/src/bus.ts';(await import(p)).bus.emit('undo',undefined)})
    await expect.poll(()=>markdown(page)).toBe(original)
    await page.getByRole('button',{name:/首尾段落.*3.*9/}).click()
    await page.keyboard.press('ArrowLeft')
    await page.getByRole('button',{name:'插入到光标处',exact:true}).click()
    await expect.poll(()=>markdown(page)).toContain('这是一份可以保存的摘要。')
    expect(await markdown(page)).toContain('第一段 🌱')
    expect(await markdown(page)).toContain('最后一段')
    await page.evaluate(async()=>{const p='/src/bus.ts';(await import(p)).bus.emit('undo',undefined)})
    await expect.poll(()=>markdown(page)).toBe(original)
  })
}

test('keyboard focus preserves answer selection and stale sources cannot jump into edited text',async({page})=>{
  await setup(page,true)
  const original=await markdown(page)
  await answer(page)
  await page.getByRole('button',{name:/首尾段落.*3.*9/}).click()
  const summary=page.locator('.agent-answer-actions summary')
  await summary.focus()
  await summary.press('Enter')
  const replace=page.getByRole('button',{name:'替换选区',exact:true})
  await replace.focus()
  await replace.press('Enter')
  await expect.poll(()=>markdown(page)).toContain('这是一份可以保存的摘要。')
  expect(await markdown(page)).not.toContain('第一段 🌱')
  await page.getByRole('button',{name:/首尾段落.*3.*9/}).click()
  await expect(page.locator('.agent-composer-error')).toBeVisible()
  expect(await markdown(page)).not.toBe(original)
})

test('full-document reference preserves an independently bounded selection edit',async({page})=>{
  await setup(page,true)
  const line=page.locator('.source-pane .cm-line').filter({hasText:'第一段 🌱'})
  await line.click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.getByRole('textbox',{name:'发送给写作助手的消息'}).click()
  await page.getByLabel('参考全文，仅修改选区',{exact:true}).check()
  await page.getByRole('textbox',{name:'发送给写作助手的消息'}).fill('按全文风格改写选区')
  await page.getByRole('button',{name:'发送',exact:true}).click()
  await expect(page.getByText('仅修改选区',{exact:true})).toBeVisible()
  const sent=await page.evaluate(()=>{
    const r=(window as unknown as {__workflowRequest:{context:{markdown:string};editRange:{from:number;to:number}}}).__workflowRequest
    return {markdown:r.context.markdown,selected:r.context.markdown.slice(r.editRange.from,r.editRange.to)}
  })
  expect(sent.markdown).toContain('const untouched = true')
  expect(sent.selected).toBe('第一段 🌱')
  await page.getByRole('button',{name:'应用修改',exact:true}).click()
  await expect.poll(()=>markdown(page)).toContain('选区已更新 🌱')
  expect(await markdown(page)).toContain('最后一段')
  expect(await markdown(page)).toContain('const untouched = true')
})

test('chapter summary resumes after stopping and completes synthesis without changing the document',async({page})=>{
  await setup(page,true)
  const longMarkdown='# 长文\n\n'+Array.from({length:9},(_,i)=>`## 第 ${i+1} 章\n\n${'这一章有中文论点与表情 🌱。'.repeat(260)}\n\n`).join('')
  await page.evaluate(async text=>{
    const p='/src/stores/editor.ts';const editor=(await import(p)).useEditorStore()
    const tab=editor.newUntitledTab(text);tab.pendingBaselineUpdate=false
    ;(window as unknown as {__pauseSummaryAt:number}).__pauseSummaryAt=2
  },longMarkdown)
  const original=await markdown(page)
  await page.getByRole('button',{name:'分章总结',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {__summaryRequests:unknown[]}).__summaryRequests?.length??0)).toBe(2)
  await page.getByRole('button',{name:'停止生成',exact:true}).click()
  await expect(page.getByRole('button',{name:'继续分章总结',exact:true})).toBeEnabled()
  await page.getByRole('button',{name:'继续分章总结',exact:true}).click()
  await expect.poll(()=>page.evaluate(async()=>{const p='/src/stores/agent.ts';return (await import(p)).useAgentStore().conversation.messages.at(-1)?.completed}),{timeout:20000}).toBe(true)
  expect(await markdown(page)).toBe(original)
  await expect(page.locator('.agent-summary-progress')).toBeVisible()
  const requests=await page.evaluate(()=>(window as unknown as {__summaryRequests:{readOnly:boolean;context:{markdown:string}|null}[]}).__summaryRequests)
  expect(requests.every(r=>r.readOnly)).toBe(true)
  expect(requests.length).toBeGreaterThan(3)
  // The completed first chunk is reused on resume, while the interrupted chunk is retried.
  expect(requests.filter(r=>r.context?.markdown===requests[0].context?.markdown)).toHaveLength(1)
  await page.locator('.agent-answer-actions summary').last().click()
  await expect(page.getByRole('button',{name:'新建 Markdown 笔记',exact:true}).last()).toBeEnabled()
  await page.screenshot({path:'output/agent-workflow/summary-complete.png'})
})

test('manual references use unsaved tab snapshots and citations navigate to the correct document',async({page})=>{
  await setup(page,true)
  const referenceId=await page.evaluate(async()=>{
    const p='/src/stores/editor.ts';const e=(await import(p)).useEditorStore(),primary=e.currentFileId
    const tab=e.newUntitledTab('# 参考资料 🌱\n\n未保存的参考事实。\n')
    tab.filename='参考资料.md';tab.isSaved=false;tab.pendingBaselineUpdate=false
    e.setCurrent(primary)
    return tab.id as string
  })
  await page.locator('.agent-references summary').click()
  await page.getByLabel('附加已打开的标签页',{exact:true}).selectOption(referenceId)
  await expect(page.locator('.agent-reference-chips')).toContainText('参考资料.md')
  await page.getByRole('textbox',{name:'发送给写作助手的消息'}).fill('compare')
  await page.getByRole('button',{name:'发送',exact:true}).click()
  await expect(page.locator('.agent-markdown')).toContainText('当前笔记与参考笔记已经对照')
  const references=await page.evaluate(()=>(window as unknown as {__workflowRequest:{references:{name:string;markdown:string}[]}}).__workflowRequest.references)
  expect(references).toHaveLength(1)
  expect(references[0].markdown).toContain('未保存的参考事实')
  await page.getByRole('button',{name:/参考笔记依据/}).click()
  await expect.poll(()=>page.evaluate(async()=>{const p='/src/stores/editor.ts';return (await import(p)).useEditorStore().currentFileId})).toBe(referenceId)
  expect(await markdown(page)).toContain('未保存的参考事实')
  await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString()??'')).toContain('参考资料')
})

test('opt-in history survives reload, exports, restores safely and deletes without resurrection',async({page})=>{
  await setup(page,true)
  const original=await markdown(page)
  await page.getByRole('button',{name:'历史对话',exact:true}).click()
  await expect(page.getByLabel('在本地保存对话',{exact:true})).not.toBeChecked()
  await page.getByLabel('在本地保存对话',{exact:true}).check()
  await page.getByRole('button',{name:'历史对话',exact:true}).click()
  await answer(page)
  await page.getByRole('button',{name:'新对话',exact:true}).click()
  await expect(page.locator('.agent-markdown')).toHaveCount(0)
  await page.getByRole('button',{name:'历史对话',exact:true}).click()
  await page.getByRole('searchbox',{name:'搜索对话标题'}).fill('answer')
  await expect(page.locator('.agent-history-item')).toHaveCount(1)
  const downloadPromise=page.waitForEvent('download')
  await page.getByRole('button',{name:'导出 Markdown',exact:true}).click()
  const download=await downloadPromise
  const exported=await readFile((await download.path())!,'utf8')
  expect(exported).toContain('这是一份可以保存的摘要。')
  expect(exported).toContain('首尾段落')
  await page.reload()
  await page.locator('.muya-host [contenteditable="true"]').waitFor()
  await page.evaluate(async()=>{
    const lp='/src/i18n/index.ts',pp='/src/stores/preferences.ts';(await import(lp)).setLocale('zh-CN');(await import(pp)).usePreferencesStore().language='zh-CN'
  })
  await page.getByRole('button', { name: /^AI 助手(?: \(.+\))?$/ }).click()
  await page.getByRole('button',{name:'历史对话',exact:true}).click()
  await expect(page.getByLabel('在本地保存对话',{exact:true})).toBeChecked()
  await page.locator('.agent-history-item').first().getByRole('button',{name:'恢复',exact:true}).click()
  await expect(page.locator('.agent-markdown')).toContainText('这是一份可以保存的摘要。')
  expect(await markdown(page)).toBe(original)
  expect(await page.evaluate(async()=>{const p='/src/stores/editor.ts';return (await import(p)).useEditorStore().tabs.length})).toBeGreaterThan(1)
  await page.getByRole('button',{name:'历史对话',exact:true}).click()
  const deletedId=await page.evaluate(async()=>{const p='/src/stores/agent.ts';return (await import(p)).useAgentStore().historyItems[0].id as string})
  await page.locator('.agent-history-item').first().getByRole('button',{name:'删除',exact:true}).click()
  await page.getByRole('button',{name:'历史对话',exact:true}).click()
  await page.getByRole('button',{name:'新对话',exact:true}).click()
  await page.getByRole('button',{name:'历史对话',exact:true}).click()
  const ids=await page.evaluate(()=>JSON.parse(localStorage.getItem('workflow-history')!).records.map((r:{id:string})=>r.id))
  expect(ids).not.toContain(deletedId)
  await page.screenshot({path:'output/agent-workflow/history.png'})
})

test('saved stopped summaries resume after reload without processing completed chunks again',async({page})=>{
  await setup(page,true)
  await page.getByRole('button',{name:'历史对话',exact:true}).click()
  await page.getByLabel('在本地保存对话',{exact:true}).check()
  await page.getByRole('button',{name:'历史对话',exact:true}).click()
  await page.evaluate(async()=>{
    const p='/src/stores/editor.ts';const e=(await import(p)).useEditorStore()
    const tab=e.newUntitledTab('# 可恢复长文\n\n'+Array.from({length:8},(_,i)=>`## ${i}\n${'需要完整保留的材料 🌱。'.repeat(250)}\n`).join(''))
    tab.pendingBaselineUpdate=false
    ;(window as unknown as {__pauseSummaryAt:number}).__pauseSummaryAt=2
  })
  await page.getByRole('button',{name:'分章总结',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {__summaryRequests:unknown[]}).__summaryRequests?.length??0)).toBe(2)
  const firstChunk=await page.evaluate(()=>(window as unknown as {__summaryRequests:{context:{markdown:string}}[]}).__summaryRequests[0].context.markdown)
  await page.getByRole('button',{name:'停止生成',exact:true}).click()
  await expect(page.getByRole('button',{name:'继续分章总结',exact:true})).toBeEnabled()
  await page.getByRole('button',{name:'新对话',exact:true}).click()
  await page.reload()
  await page.locator('.muya-host [contenteditable="true"]').waitFor()
  await page.evaluate(async()=>{const lp='/src/i18n/index.ts',pp='/src/stores/preferences.ts';(await import(lp)).setLocale('zh-CN');(await import(pp)).usePreferencesStore().language='zh-CN'})
  await page.getByRole('button', { name: /^AI 助手(?: \(.+\))?$/ }).click()
  await page.getByRole('button',{name:'历史对话',exact:true}).click()
  await page.locator('.agent-history-item').filter({hasText:'分章总结'}).getByRole('button',{name:'恢复',exact:true}).click()
  await page.getByRole('button',{name:'继续分章总结',exact:true}).click()
  await expect.poll(()=>page.evaluate(async()=>{const p='/src/stores/agent.ts';return (await import(p)).useAgentStore().conversation.messages.at(-1)?.completed}),{timeout:20000}).toBe(true)
  const repeated=await page.evaluate(text=>(window as unknown as {__summaryRequests:{context:{markdown:string}|null}[]}).__summaryRequests.some(r=>r.context?.markdown===text),firstChunk)
  expect(repeated).toBe(false)
})

test('historical edit states remain visible but cannot apply or revert against the current document',async({page})=>{
  await setup(page,true)
  await page.getByRole('button',{name:'历史对话',exact:true}).click()
  await page.getByLabel('在本地保存对话',{exact:true}).check()
  await page.getByRole('button',{name:'历史对话',exact:true}).click()
  await propose(page)
  await page.getByRole('button',{name:'应用此处',exact:true}).first().click()
  const applied=await markdown(page)
  await page.getByRole('button',{name:'新对话',exact:true}).click()
  await page.getByRole('button',{name:'历史对话',exact:true}).click()
  await page.locator('.agent-history-item').first().getByRole('button',{name:'恢复',exact:true}).click()
  await expect(page.locator('.agent-edit')).toContainText('历史修改记录')
  await expect(page.locator('.agent-change').first()).toContainText('已应用')
  await expect(page.getByRole('button',{name:'全部应用',exact:true})).toBeDisabled()
  await expect(page.getByRole('button',{name:'撤回已应用',exact:true})).toBeDisabled()
  expect(await markdown(page)).toBe(applied)
})
