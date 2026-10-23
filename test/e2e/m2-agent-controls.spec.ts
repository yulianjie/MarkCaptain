import { expect, test, type Page } from '@playwright/test'

interface M2Request {
  readOnly?: boolean
  projectSearch?: { grantId: string; buffers: { path: string; markdown: string }[] }
  messages?: unknown[]
  webResearch?: { enabled: boolean; topic: string; allowDocumentQueries: boolean; approvedQueries: string[]; urls: string[]; publicDns: boolean }
}
declare global {
  interface Window {
    __m2Ipc: { grants: { grantId: string }[]; revokes: string[]; configLoads: string[]; checks: unknown[] }
    __m2Requests: M2Request[]
    __m2Xss?: boolean
    __m2HoldChecks?: boolean
    __m2ReleaseChecks?: (() => void)[]
  }
}

const tauriFixture = `
export * from '/src/services/tauri-invoke.ts?m2-controls-original';
window.__m2Ipc ??= { grants: [], revokes: [], configLoads: [], checks: [] };
export const agentProjectLoadConfig = async root => {
  window.__m2Ipc.configLoads.push(root);
  return { config: { schemaVersion: 1, projectSearch: { enabledByDefault: true, include: ['notes/**/*.md'], exclude: [] }, writing: { language: 'zh-CN', audience: 'writers', tone: 'clear', glossary: [] } }, fingerprint: 'fixture-fingerprint' };
};
export const agentProjectGrant = async (root, include, exclude) => {
  const grant = { grantId: '00000000-0000-4000-8000-000000000001', root, include: [...include], exclude: [...exclude] };
  window.__m2Ipc.grants.push(grant); return grant;
};
export const agentProjectRevoke = async grantId => { window.__m2Ipc.revokes.push(grantId); };
export const agentProjectSaveConfig = async (root, config, expectedFingerprint) => ({ config, fingerprint: 'saved-fingerprint' });
export const agentCheckDocument = async (markdown, root, sourcePath) => {
  window.__m2Ipc.checks.push({ markdown, root, sourcePath });
  const evidence = 'No evidence'; const from = markdown.indexOf(evidence);
  if (window.__m2HoldChecks) await new Promise(resolve => { (window.__m2ReleaseChecks ??= []).push(resolve); });
  return { issues: from < 0 ? [] : [{ id: 'missing-evidence', kind: 'glossary', severity: 'warning', message: 'Add supporting evidence.', from, to: from + evidence.length, line: 3, column: 1, evidence, replacement: 'Add a cited result.' }], complete: true, externalLinksUnchecked: 1, localTargetsChecked: 2, truncated: false, scope: 'current buffer' };
};
`

const transportFixture = `
let handler;
window.__m2Requests = [];
const config = { baseUrl: 'http://localhost:11434/v1', model: 'm2-controls-test', authMode: 'none', hasKey: false, hasHeaders: false };
export const agentTransport = {
  historySettings: async()=>({enabled:false}), historyList: async()=>[], historyRead: async()=>null,
  getConfig: async()=>({...config}), saveConfig: async()=>({...config}), testConnection: async()=>{},
  listSkills: async()=>[], importSkill: async()=>[], setSkillEnabled: async()=>[], removeSkill: async()=>[], readSkill: async(id)=>({id,instructions:'',files:[]}),
  listen: async(fn)=>{handler=fn;return()=>{handler=null}}, cancel: async()=>{},
  start: async(request)=>{
    window.__m2Requests.push(request);
    const send=event=>handler?.({requestId:request.requestId,...event});
    setTimeout(()=>{
      if(request.readOnly){ send({kind:'delta',text:'只读检查：请补充原文依据。'}); send({kind:'done'}); return; }
      if(request.webResearch?.enabled){
        send({kind:'web_source',text:JSON.stringify({sourceId:'source-1',title:'<img src=x onerror="window.__m2Xss=true">',url:'http://example.com/article',fetchedAt:'2026-10-22T00:00:00.000Z',excerpt:'<script>window.__m2Xss=true</script>',status:'snippet'})});
        send({kind:'delta',text:'网页候选已列出。'}); send({kind:'done'}); return;
      }
      send({kind:'proposal',proposal:{title:'Evidence repair draft',changes:[{oldText:'No evidence',newText:'Evidence is pending review.'}]}});
      send({kind:'done'});
    },10);
  },
};
`

async function setup(page: Page) {
  await page.addInitScript(() => { localStorage.clear(); window.__m2Ipc = { grants: [], revokes: [], configLoads: [], checks: [] }; window.__m2Requests = [] })
  await page.route('**/src/services/tauri-invoke.ts*', route => route.request().url().includes('m2-controls-original')
    ? route.continue()
    : route.fulfill({ contentType: 'text/javascript', body: tauriFixture }))
  await page.route('**/src/services/agent-transport.ts*', route => route.fulfill({ contentType: 'text/javascript', body: transportFixture }))
  await page.goto('/')
  await page.locator('.muya-host [contenteditable="true"]').waitFor()
  await page.evaluate(async () => {
    const prefs = (await import('/src/stores/preferences.ts')).usePreferencesStore()
    Object.assign(prefs, { language: 'zh-CN', theme: 'light', autoSave: false, sideBarVisibility: true })
    ;(await import('/src/i18n/index.ts')).setLocale('zh-CN')
    const project = (await import('/src/stores/project.ts')).useProjectStore()
    project.projectTree = { id:'root', name:'M2 notes', pathname:'C:/M2-notes', isDirectory:true, isFile:false, isRoot:true, folders:[], files:[], isCollapsed:false, childrenLoaded:true }
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    if (editor.startupHydrationPending) editor.finishStartupHydration()
    const tab = editor.newUntitledTab('# Local doc\n\nNo evidence yet.\n')
    tab.filename = 'current.md'; tab.pathname = 'C:/M2-notes/notes/current.md'; tab.pendingBaselineUpdate = false
  })
  await page.getByRole('button', { name: /^AI 助手(?: \(.+\))?$/ }).click()
  await expect(page.locator('.agent-panel')).toBeVisible()
  await expect.poll(() => page.evaluate(async () => (await import('/src/stores/agent.ts')).useAgentStore().projectConfigRoot)).toBe('C:/M2-notes')
}

test('completed clean checks disappear after editing or switching documents', async ({ page }) => {
  await setup(page)
  const section = page.locator('.agent-m2-section').nth(2)
  await section.locator(':scope > summary').click()
  await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    editor.setMarkdownExternal(editor.currentFileId!, '# Clean document\n')
  })
  await section.getByRole('button', { name: '检查文档', exact: true }).click()
  await expect(section).toContainText('没有发现确定性问题。')
  await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    editor.setMarkdownExternal(editor.currentFileId!, '# Changed document\n')
  })
  await expect(section).not.toContainText('没有发现确定性问题。')
  await expect(section).not.toContainText('检查完成')
  await expect(section.getByRole('alert')).toContainText('请重新检查')
  await section.getByRole('button', { name: '检查文档', exact: true }).click()
  await expect(section).toContainText('没有发现确定性问题。')
  await page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore().newUntitledTab('# Other document\n'))
  await expect(section).not.toContainText('没有发现确定性问题。')
  await expect(section).not.toContainText('检查完成')
  await expect(section.getByRole('alert')).toContainText('请重新检查')
})

test('an older pending check cannot replace the newer document result', async ({ page }) => {
  await setup(page)
  const section = page.locator('.agent-m2-section').nth(2)
  await section.locator(':scope > summary').click()
  await page.evaluate(() => { window.__m2HoldChecks = true })
  await section.getByRole('button', { name: '检查文档', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__m2ReleaseChecks?.length)).toBe(1)
  await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    editor.setMarkdownExternal(editor.currentFileId!, '# Clean new version\n')
    window.__m2HoldChecks = false
  })
  await section.getByRole('button', { name: '检查文档', exact: true }).click()
  await expect(section).toContainText('没有发现确定性问题。')
  await page.evaluate(() => window.__m2ReleaseChecks?.shift()?.())
  await expect(section).toContainText('没有发现确定性问题。')
  await expect(section.locator('.agent-m2-issue')).toHaveCount(0)
  await expect(section.getByRole('alert')).toHaveCount(0)
})

test('brace glob grants preserve dirty candidates for local backend filtering without adding them to model messages', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    editor.setMarkdownExternal(editor.currentFileId!, '# UNSAVED BRACE CANDIDATE\n')
    const agent = (await import('/src/stores/agent.ts')).useAgentStore()
    agent.includeDocument = false
  })
  const section = page.locator('.agent-m2-section').nth(0)
  await section.locator(':scope > summary').click()
  await section.getByRole('textbox', { name: '包含的 Markdown 路径' }).fill('**/*.{md,markdown}')
  await section.getByRole('textbox', { name: '排除的路径' }).fill('**/{private,secret}/**')
  await section.getByRole('button', { name: '允许搜索项目' }).click()
  await expect.poll(() => page.evaluate(() => window.__m2Ipc.grants.length)).toBe(1)
  await page.getByRole('textbox', { name: '发送给写作助手的消息' }).fill('Find project notes')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__m2Requests.length)).toBe(1)
  const request = await page.evaluate(() => window.__m2Requests[0])
  expect(request.projectSearch?.buffers).toContainEqual({ path: 'C:/M2-notes/notes/current.md', markdown: '# UNSAVED BRACE CANDIDATE\n' })
  expect(JSON.stringify(request.messages)).not.toContain('UNSAVED BRACE CANDIDATE')
})

test('project context, local review, read-only model check, web approvals and source cards use explicit boundaries', async ({ page }) => {
  await setup(page)

  const projectSection = page.locator('.agent-m2-section').nth(0)
  await projectSection.locator(':scope > summary').click()
  await expect.poll(() => page.evaluate(async () => (await import('/src/stores/agent.ts')).useAgentStore().projectConfig.projectSearch?.include?.[0])).toBe('notes/**/*.md')
  await expect(projectSection.getByRole('textbox', { name: '包含的 Markdown 路径' })).toHaveValue('notes/**/*.md')
  expect(await page.evaluate(async () => (await import('/src/stores/agent.ts')).useAgentStore().conversation.projectAccess.grantId)).toBeNull()
  await projectSection.getByRole('textbox', { name: '包含的 Markdown 路径' }).fill('notes/**/*.md')
  await projectSection.getByRole('button', { name: '允许搜索项目' }).click()
  await expect.poll(() => page.evaluate(async () => (await import('/src/stores/agent.ts')).useAgentStore().conversation.projectAccess.grantId)).toBe('00000000-0000-4000-8000-000000000001')
  await projectSection.getByRole('textbox', { name: '排除的路径' }).fill('private/**')
  await page.getByRole('textbox', { name: '发送给写作助手的消息' }).fill('Search project')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.agent-composer-error')).toContainText('授权后搜索范围发生了变化')
  expect(await page.evaluate(() => window.__m2Requests.length)).toBe(0)
  await projectSection.getByRole('button', { name: '更新范围并授权' }).click()
  await expect.poll(() => page.evaluate(() => window.__m2Ipc.grants.length)).toBe(2)
  await expect.poll(() => page.evaluate(() => window.__m2Ipc.revokes.length)).toBe(1)
  await projectSection.getByRole('button', { name: '撤销访问' }).click()
  await expect.poll(() => page.evaluate(async () => (await import('/src/stores/agent.ts')).useAgentStore().conversation.projectAccess.grantId)).toBeNull()

  const checkSection = page.locator('.agent-m2-section').nth(2)
  await checkSection.locator(':scope > summary').click()
  await checkSection.getByRole('button', { name: '检查文档' }).click()
  await expect(checkSection.locator('.agent-m2-issue')).toContainText('Add supporting evidence.')
  await checkSection.getByRole('button', { name: '定位正文' }).click()
  const original = await page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore().currentFile?.markdown)
  await checkSection.getByRole('button', { name: '生成待审修订草稿' }).click()
  await expect(page.locator('.agent-edit')).toContainText('Evidence repair draft')
  expect(await page.evaluate(() => window.__m2Requests.at(-1)?.readOnly)).toBeUndefined()
  expect(await page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore().currentFile?.markdown)).toBe(original)

  await checkSection.getByRole('button', { name: '请 Agent 只读检查' }).click()
  await expect.poll(() => page.evaluate(() => window.__m2Requests.length)).toBe(2)
  expect(await page.evaluate(() => window.__m2Requests.at(-1)?.readOnly)).toBe(true)
  await expect(page.locator('.agent-context-readonly')).toContainText('只读检查')
  expect(await page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore().currentFile?.markdown)).toBe(original)

  const webSection = page.locator('.agent-m2-section').nth(3)
  await webSection.locator(':scope > summary').click()
  const webToggles = webSection.locator('input[type="checkbox"]')
  await expect(webToggles.nth(0)).not.toBeChecked()
  await expect(webToggles.nth(1)).toBeDisabled()
  await webToggles.nth(0).check()
  await expect(webSection).toContainText('只有你明确批准的查询词会发送给 Bing')
  await expect(webSection).toContainText('Cloudflare 只会收到用于 DNS 解析的目标域名')
  await webToggles.nth(1).check() // This request explicitly uses Cloudflare public DNS.
  await webToggles.nth(2).check() // Query suggestions remain opt-in and are locally reviewed.
  await webSection.getByRole('button', { name: '从文档建议查询' }).click()
  await expect(webSection.locator('.agent-m2-query-suggestion input')).toHaveCount(1)
  await expect(webSection.getByRole('textbox', { name: '已批准的搜索词' })).toHaveValue('')
  await webSection.locator('.agent-m2-query-suggestion input').fill('local document research')
  await webSection.getByRole('button', { name: '批准此查询' }).click()
  await expect(webSection.getByRole('textbox', { name: '已批准的搜索词' })).toHaveValue('local document research')
  await webSection.getByRole('textbox', { name: '研究主题' }).fill('A user-selected research topic')
  await webSection.getByRole('textbox', { name: '你直接提供的网址' }).fill('https://example.com/article')
  await page.getByRole('textbox', { name: '发送给写作助手的消息' }).fill('Research the approved source')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.agent-m2-source-card').last()).toContainText('此来源使用 HTTP，传输未加密。')
  const webRequest = await page.evaluate(() => window.__m2Requests.at(-1))
  expect(webRequest.webResearch).toMatchObject({ enabled: true, topic: 'A user-selected research topic', allowDocumentQueries: true,
    approvedQueries: ['local document research'], urls: ['https://example.com/article'], publicDns: true })
  expect(await page.evaluate(() => window.__m2Xss)).toBeUndefined()
  expect(await page.locator('.agent-m2-source-card img, .agent-m2-source-card script').count()).toBe(0)
  expect(await page.locator('.agent-m2-source-card').last().locator('strong').textContent()).toContain('<img src=x')
  expect(await webSection.locator('input[type="checkbox"]').nth(0).isChecked()).toBe(false)
  expect(await webSection.locator('input[type="checkbox"]').nth(1).isChecked()).toBe(false)
})
