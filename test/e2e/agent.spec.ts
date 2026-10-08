import { test, expect, type Page } from '@playwright/test'

// Replace only the transport boundary. The real Vue UI, Pinia state, Muya,
// CodeMirror, review validation and undo paths run unchanged in the browser.
const transportFixture = `
let handler; let active; let timers = [];
let config = {baseUrl:'https://api.deepseek.com',model:'deepseek-flash',hasKey:false,hasHeaders:false};
let skills = ['eli5','mermaid-diagrams','writing-clearly-and-concisely','crafting-effective-readmes','internal-comms','markdown-coauthor'].map(name=>({id:'builtin:'+name,name,description:name,license:name==='internal-comms'?'Apache-2.0':'MIT',source:'https://github.com/DreambigOu/ELI5',builtin:true,enabled:true}));
export const agentTransport = {
  historySettings: async()=>({enabled:false}), historyList: async()=>[],
  getConfig: async()=>{if(window.__keychainUnavailable && config.authMode!=='none')throw new Error('agent:keychain');return {...config}},
  saveConfig: async(settings, apiKey, headers)=>{window.__agentConfigSave={settings,apiKey,headers};if(window.__keychainUnavailable && settings.authMode!=='none')throw new Error('agent:keychain');config={...settings,hasKey:apiKey === '' ? false : !!apiKey || config.hasKey,hasHeaders:Array.isArray(headers) ? headers.length > 0 : config.hasHeaders};return {...config}},
  testConnection: async()=>{},
  listSkills: async()=>skills.map(s=>({...s})),
  importSkill: async()=>{if(skills.some(s=>s.id==='user:team-style'))throw new Error('agent:skillExists');skills.push({id:'user:team-style',name:'team-style',description:'Team writing rules',license:'MIT',source:null,builtin:false,enabled:true});return skills.map(s=>({...s}));},
  setSkillEnabled: async(id,enabled)=>{skills=skills.map(s=>s.id===id?{...s,enabled}:s);return skills.map(s=>({...s}));},
  removeSkill: async(id)=>{skills=skills.filter(s=>s.id!==id);return skills.map(s=>({...s}));},
  readSkill: async(id)=>({id,instructions:'# Skill instructions\\nUse examples for clear writing.',files:['references/examples.md']}),
  listen: async(fn)=>{handler=fn;return ()=>{handler=null}},
  start: async(request)=>{
    window.__agentRequest=request;
    active=request.requestId;
    const text=request.messages.at(-1).content;
    const send=(event)=>handler?.({requestId:request.requestId,...event});
    if(text==='wait') return;
    if(text==='error'){timers.push(setTimeout(()=>send({kind:'error',text:'agent:auth'}),20));return;}
    const oldText = request.context?.markdown.includes('hello world') ? 'hello world' : request.context?.markdown || '';
    timers.push(setTimeout(()=>send({kind:'tool',text:request.skillIds?.length ? 'read_skill' : 'read_document'}),20));
    timers.push(setTimeout(()=>send({kind:'delta',text:'这里是 **更自然的表达**。<img src="https://invalid.example/tracker"><script>alert(1)</script>'}),50));
    if(request.context)timers.push(setTimeout(()=>send({kind:'proposal',proposal:{title:'润色文字',oldText,newText:'Hello, world!'}}),80));
    timers.push(setTimeout(()=>send({kind:'done'}),120));
  },
  cancel: async(id)=>{timers.forEach(clearTimeout);timers=[];handler?.({requestId:id,kind:'cancelled'})},
};`

async function setup(page: Page, source = false) {
  await page.route('**/src/services/agent-transport.ts', route => route.fulfill({ contentType: 'text/javascript', body: transportFixture }))
  await page.goto('/')
  await page.locator('.muya-host [contenteditable="true"]').waitFor()
  await page.evaluate(async source => {
    const editorPath = '/src/stores/editor.ts', prefsPath = '/src/stores/preferences.ts', localePath = '/src/i18n/index.ts'
    const { useEditorStore } = await import(editorPath)
    const { usePreferencesStore } = await import(prefsPath)
    const { setLocale } = await import(localePath)
    Object.assign(usePreferencesStore(), { language:'zh-CN', theme:'light', autoSave:false, sideBarVisibility:false })
    setLocale('zh-CN')
    const editor = useEditorStore()
    const tab = editor.newUntitledTab('# 写作笔记\n\nhello world\n')
    tab.filename = '写作笔记.md'; tab.pendingBaselineUpdate = false
    editor.tabs = [tab]
    editor.sourceCodeMode = source
  }, source)
  await page.getByRole('button', { name: /^AI 助手(?: \(.+\))?$/ }).click()
  await expect(page.getByRole('heading', { name:'一起把想法写好' })).toBeVisible()
}

async function send(page: Page, text = 'polish') {
  await page.getByRole('textbox', { name: '发送给写作助手的消息' }).fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}
async function markdown(page: Page) {
  return page.evaluate(async () => { const path='/src/stores/editor.ts'; return (await import(path)).useEditorStore().currentFile.markdown })
}

test('recovers from missing Secret Service by explicitly saving an unauthenticated local model', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__keychainUnavailable = true })
  await setup(page)
  await expect(page.locator('.agent-banner').first()).toContainText('无法访问系统凭据库')
  await page.getByRole('button', { name: '模型设置', exact: true }).click()
  await page.locator('#agent-provider').selectOption('ollama')
  await page.locator('#agent-model').fill('local-tools-model')
  await expect(page.locator('#agent-auth-mode')).toHaveValue('none')
  await expect(page.locator('#agent-key')).toHaveCount(0)
  await expect(page.locator('#agent-headers')).toHaveCount(0)
  await page.getByRole('button', { name: '保存并测试', exact: true }).click()
  await expect(page.locator('.agent-settings-feedback')).toContainText('连接成功')
  const saved = await page.evaluate(() => (window as any).__agentConfigSave)
  expect(saved.settings).toMatchObject({ authMode: 'none', baseUrl: 'http://localhost:11434/v1', model: 'local-tools-model' })
  expect(saved.apiKey).toBeUndefined(); expect(saved.headers).toBeUndefined()
  await page.locator('#agent-auth-mode').selectOption('system')
  await expect(page.locator('#agent-key')).toBeVisible()
  await page.getByRole('button', { name: '保存并测试', exact: true }).click()
  await expect(page.locator('.agent-settings .agent-error')).toContainText('无法访问系统凭据库')
})

async function pictureData(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 480; canvas.height = 280
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#f2eee6'; ctx.fillRect(0, 0, 480, 280)
    ctx.fillStyle = '#456250'; ctx.fillRect(28, 30, 5, 215)
    ctx.fillStyle = '#23382c'; ctx.font = 'bold 28px sans-serif'; ctx.fillText('Writing notes', 52, 75)
    ctx.font = '18px sans-serif'; ctx.fillText('1. Keep the original meaning', 52, 124)
    ctx.fillText('2. Make the next step clear', 52, 164)
    ctx.fillText('3. Review before applying', 52, 204)
    return canvas.toDataURL('image/png')
  })
}

async function pastePicture(page: Page, dataUrl: string, text = '') {
  await page.getByRole('textbox', { name: '发送给写作助手的消息' }).evaluate((input, { dataUrl, text }) => {
    const data = new DataTransfer()
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), c => c.charCodeAt(0))
    data.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }))
    if (text) data.setData('text/plain', text)
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, { dataUrl, text })
}

test('pastes, previews, removes and sends images with follow-up history and retry', async ({ page }) => {
  await setup(page)
  await page.locator('.agent-context-row input').uncheck()
  const input = page.getByRole('textbox', { name: '发送给写作助手的消息' })
  const dataUrl = await pictureData(page)
  await input.fill('Review: ')
  await input.press('End')
  await pastePicture(page, dataUrl, 'these notes')
  await expect(input).toHaveValue('Review: these notes')
  await expect(page.locator('.agent-draft-images img')).toHaveCount(1)
  expect(await page.locator('.agent-draft-images img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480)
  await page.getByRole('button', { name: '查看图片 clipboard.png' }).click()
  await expect(page.locator('.mt-image-preview-img')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '移除图片 clipboard.png' }).click()
  await expect(page.locator('.agent-draft-images img')).toHaveCount(0)
  await pastePicture(page, dataUrl)
  await input.fill('error')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.agent-message .agent-error')).toBeVisible()
  await expect(page.locator('.agent-draft-images img')).toHaveCount(0)
  await expect(page.locator('.agent-sent-images img')).toHaveCount(1)
  await page.locator('.agent-message-actions').getByRole('button', { name: '重试' }).click()
  await expect(page.locator('.agent-message .agent-error')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__agentRequest.messages.at(-1).images)).toEqual([{ name: 'clipboard.png', dataUrl }])
  await send(page, 'Explain the second note')
  await expect(page.locator('.agent-working')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__agentRequest.messages[0].images)).toEqual([{ name: 'clipboard.png', dataUrl }])
  await pastePicture(page, dataUrl)
  for (const width of [1280, 540]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport()
    expect(await page.locator('.agent-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: `output/agent-multimodal/images-${width}.png` })
  }
})

test('supports image-only file input, validation, and ordinary text paste', async ({ page }) => {
  await setup(page)
  await page.locator('.agent-context-row input').uncheck()
  const dataUrl = await pictureData(page)
  const picker = page.locator('.agent-image-input')
  await picker.setInputFiles({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') })
  await expect(page.locator('.agent-draft-images img')).toHaveCount(1)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.agent-working')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__agentRequest.messages.at(-1))).toMatchObject({ content: '', images: [{ name: 'notes.png', dataUrl }] })
  await picker.setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') })
  await expect(page.locator('.agent-composer-error')).toContainText('支持 PNG')
  await picker.setInputFiles({ name: 'too-big.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) })
  await expect(page.locator('.agent-composer-error')).toContainText('超过 5 MB')
  await picker.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') })
  await expect(page.locator('.agent-composer-error')).toContainText('无法读取')
  const file = { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') }
  await picker.setInputFiles(Array.from({ length: 5 }, () => file))
  await expect(page.locator('.agent-composer-error')).toContainText('最多附加 4 张')
  const input = page.getByRole('textbox', { name: '发送给写作助手的消息' })
  // The browser performs the actual default paste after our listener returns.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => navigator.clipboard.writeText('普通粘贴文字'))
  await input.click()
  await page.keyboard.press('Control+V')
  await expect(input).toHaveValue('普通粘贴文字')
  await expect(page.locator('.agent-draft-images img')).toHaveCount(0)
})

for (const source of [false, true]) {
  test(`automatically attaches editor selections on focus and open in ${source ? 'source' : 'wysiwyg'} mode`, async ({ page }) => {
    await setup(page, source)
    const input = page.getByRole('textbox', { name: '发送给写作助手的消息' })
    const select = async () => {
      const line = source ? page.locator('.source-pane .cm-line').filter({ hasText: 'hello world' }) : page.locator('.muya-host').getByText('hello world', { exact: true })
      await line.click()
      await page.keyboard.press('Home')
      await page.keyboard.press('Shift+End')
    }
    await select()
    await input.click()
    await expect(page.locator('.agent-context-row label')).toContainText('选中内容')
    await page.locator('.agent-selection-preview summary').click()
    await expect(page.locator('.agent-selection-preview pre')).toHaveText('hello world')
    await page.getByRole('button', { name: '切换为整篇文档' }).click()
    await input.click()
    await expect(page.locator('.agent-context-row label')).toContainText('当前文档')
    await select()
    await page.keyboard.press('Shift+ArrowLeft') // a fresh, shorter selection
    await page.getByRole('button', { name: /^AI 助手(?: \(.+\))?$/ }).click()
    await page.keyboard.press('Control+Shift+A')
    await expect(page.locator('.agent-context-row label')).toContainText('选中内容')
    await send(page)
    await expect(page.locator('.agent-working')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__agentRequest.context.markdown)).toBe('hello worl')
    await page.locator('.agent-context-row input').uncheck()
    await select()
    await input.click()
    await expect(page.locator('.agent-context-row input')).not.toBeChecked()
    await send(page, 'No document')
    await expect(page.locator('.agent-working')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__agentRequest.context)).toBeNull()
  })
}

test('imports, selects, inspects, disables and removes writing skills', async ({ page }) => {
  await setup(page)
  await expect(page.locator('.agent-context-row')).toContainText('按需读取')
  await expect(page.getByRole('combobox', { name: '选择写作技能' })).toHaveValue('')
  await page.getByRole('button', { name: '技能管理', exact: true }).click()
  await expect(page.locator('.agent-skill-card')).toHaveCount(6)
  await expect(page.locator('[data-skill-id="builtin:internal-comms"]')).toContainText('Apache-2.0')
  await expect(page.locator('[data-skill-id="builtin:markdown-coauthor"]')).toContainText('Markdown 协作写作')
  await page.getByRole('button', { name: '导入 SKILL.md' }).click()
  const custom = page.locator('[data-skill-id="user:team-style"]')
  await expect(custom).toContainText('Team writing rules')
  await custom.getByRole('button', { name: '查看内容' }).click()
  await expect(page.locator('.agent-skill-content')).toContainText('Skill instructions')
  await page.getByRole('button', { name: '返回技能列表' }).click()
  await page.getByRole('button', { name: '返回对话' }).click()
  await page.getByRole('combobox', { name: '选择写作技能' }).selectOption('user:team-style')
  await page.locator('.agent-context-row input').uncheck()
  await send(page, 'Use the team writing style')
  await expect(page.locator('.agent-working')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __agentRequest: { skillIds: string[]; context: unknown } }).__agentRequest)).toMatchObject({ skillIds: ['user:team-style'], context: null })
  await page.locator('.agent-tool-list summary').click()
  await expect(page.locator('.agent-tool-list')).toContainText('加载写作技能')
  await page.getByRole('button', { name: '技能管理', exact: true }).click()
  await custom.getByRole('checkbox').uncheck()
  await page.getByRole('button', { name: '返回对话' }).click()
  await expect(page.getByRole('combobox', { name: '选择写作技能' })).toHaveValue('')
  await expect(page.locator('.agent-skill-picker option[value="user:team-style"]')).toHaveCount(0)
  await page.getByRole('button', { name: '技能管理', exact: true }).click()
  await custom.getByRole('checkbox').check()
  await page.getByRole('button', { name: '导入 SKILL.md' }).click()
  await expect(page.locator('.agent-skills [role="alert"]')).toContainText('同名技能已导入')
  await custom.getByRole('button', { name: '删除 team-style' }).click()
  await expect(custom).toHaveCount(0)
})

test('skill management fits narrow panels and updates language and theme live', async ({ page }) => {
  await setup(page)
  await page.setViewportSize({ width: 760, height: 760 })
  await page.getByRole('button', { name: '技能管理', exact: true }).click()
  for (const locale of ['zh-CN', 'en', 'ja']) {
    await page.evaluate(async locale => {
      const i18n = '/src/i18n/index.ts', prefs = '/src/stores/preferences.ts'
      ;(await import(i18n)).setLocale(locale)
      ;(await import(prefs)).usePreferencesStore().theme = locale === 'en' ? 'dark' : 'light'
    }, locale)
    await expect(page.locator('.agent-skills')).not.toContainText('agent.skills.')
    expect(await page.locator('.agent-skills').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: `output/agent-skills/skills-${locale}.png` })
  }
})

test('selects both new writing skills without attaching a document', async ({ page }) => {
  await setup(page)
  await page.locator('.agent-context-row input').uncheck()
  for (const id of ['builtin:internal-comms', 'builtin:markdown-coauthor']) {
    await page.getByRole('combobox', { name: '选择写作技能' }).selectOption(id)
    await send(page, 'Draft a concise Markdown project update')
    await expect(page.locator('.agent-working')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __agentRequest: unknown }).__agentRequest)).toMatchObject({ skillIds: [id], context: null })
    await expect(page.locator('.agent-edit')).toHaveCount(0)
    await page.getByRole('button', { name: '新对话' }).click()
  }
})

for (const source of [false, true]) {
  test(`reviews edits and integrates undo in ${source ? 'source' : 'wysiwyg'} mode`, async ({ page }) => {
    await setup(page, source)
    const original = await markdown(page)
    await send(page)
    const apply = page.getByRole('button', { name:'应用修改' })
    await expect(apply).toBeEnabled()
    expect(await markdown(page)).toBe(original)
    await expect(page.locator('.agent-markdown img, .agent-markdown script')).toHaveCount(0)
    await expect(page.locator('.agent-markdown strong')).toHaveText('更自然的表达')
    await apply.click()
    await expect.poll(() => markdown(page)).toContain('Hello, world!')
    await page.getByRole('button', { name:'撤回', exact: true }).click()
    await expect.poll(() => markdown(page)).toBe(original)
    // Generate a fresh edit, apply it, then use the editor's native undo path.
    await page.getByRole('button', { name:'新对话' }).click()
    await send(page)
    await expect(apply).toBeEnabled()
    await apply.click()
    await expect.poll(() => markdown(page)).toContain('Hello, world!')
    await page.evaluate(async () => { const path='/src/bus.ts'; const {bus}=await import(path);bus.emit('undo',undefined) })
    await expect.poll(() => markdown(page)).toBe(original)
  })
}

test('protects concurrent edits and supports cancellation, retry and settings', async ({ page }) => {
  await setup(page)
  await send(page)
  await expect(page.getByRole('button', { name:'应用修改' })).toBeEnabled()
  await page.evaluate(async () => {const path='/src/stores/editor.ts';const editor=(await import(path)).useEditorStore();editor.setMarkdownExternal(editor.currentFileId,'My own edit')})
  await page.getByRole('button', { name:'应用修改' }).click()
  await expect(page.locator('.agent-composer-error')).toContainText('文档已变化')
  expect((await markdown(page)).trim()).toBe('My own edit')
  await page.getByRole('button', { name:'新对话' }).click()
  await send(page, 'wait')
  await page.getByRole('button', { name:'停止生成' }).click()
  await expect(page.getByText('已停止生成', { exact:true })).toBeVisible()
  await page.getByRole('button', { name:'新对话' }).click()
  await send(page, 'error')
  await expect(page.locator('.agent-message .agent-error')).toContainText('身份验证失败')
  await page.getByRole('button', { name:'模型设置', exact:true }).click()
  await page.getByLabel('API Key').fill('test-only-placeholder')
  await page.getByLabel('自定义请求头').fill('X-Tenant-ID: tenant-1\nAuthorization: Token test')
  await page.getByRole('button', { name:'保存并测试' }).click()
  await expect(page.getByText('连接成功，模型已响应')).toBeVisible()
  await expect(page.getByLabel('API Key')).toHaveValue('')
  await expect(page.getByLabel('自定义请求头')).toHaveValue('')
  await expect(page.getByText('已保存', { exact:true })).toHaveCount(2)
  await page.getByRole('button', { name:'删除此服务的已存请求头' }).click()
  await expect(page.getByText('此服务的请求头已删除')).toBeVisible()
  await page.getByRole('button', { name:'删除此服务的已存密钥' }).click()
  await expect(page.getByText('此服务的密钥已删除')).toBeVisible()
})

test('fits light/dark and narrow windows with selection context and per-document chats', async ({ page }) => {
  await setup(page, true)
  await page.locator('.source-pane .cm-content').click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.getByRole('button', { name:'附加编辑器选中内容' }).click()
  await expect(page.locator('.agent-context-row label')).toContainText('选中内容')
  await send(page)
  await expect(page.getByRole('button', { name:'应用修改' })).toBeEnabled()
  for (const width of [1280, 1024, 780, 540]) {
    await page.setViewportSize({ width, height:800 })
    for (const dark of [false, true]) {
      await page.evaluate(dark => {document.documentElement.classList.toggle('dark',dark);document.documentElement.dataset.theme=dark?'dark':'light'},dark)
      await expect(page.getByRole('button', { name:'发送', exact:true })).toBeInViewport()
      const overflow = await page.locator('.agent-panel').evaluate(element => element.scrollWidth > element.clientWidth + 1)
      expect(overflow).toBe(false)
      if (width === 1280 || width === 540) await page.screenshot({path:`output/agent/agent-${width}-${dark?'dark':'light'}.png`})
    }
  }
  await page.evaluate(async()=>{const path='/src/stores/editor.ts';(await import(path)).useEditorStore().newUntitledTab('another document')})
  await expect(page.locator('.agent-message')).toHaveCount(0)
  await page.getByRole('button', { name: /^AI 助手(?: \(.+\))?$/ }).click()
  await page.keyboard.press('Control+Shift+A')
  await expect(page.locator('.agent-panel')).toBeVisible()
})
