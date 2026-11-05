import { expect, test } from '@playwright/test'

test('Files pane background opens workspace actions from Home', async ({ page }) => {
  await page.route('**/src/services/tauri-invoke.ts*', route => route.request().url().includes('sidebar-menu-original')
    ? route.continue()
    : route.fulfill({ contentType: 'text/javascript', body: `
      export * from '/src/services/tauri-invoke.ts?sidebar-menu-original';
      const workspace = 'C:/menu-notes';
      const entries = [{ path: workspace + '/existing.md', name: 'existing.md', isDir: false, size: 0, modifiedMs: 0 }];
      export const openFolder = async () => workspace;
      export const watchFolder = async path => path;
      export const listWorkspaceDirectory = async () => entries;
      export const createWorkspaceEntry = async (root, parent, name, kind) => {
        if (root !== workspace || parent !== workspace) throw new Error('Expected creation at the workspace root');
        const path = parent + '/' + name;
        entries.push({ path, name, isDir: kind === 'directory', size: 0, modifiedMs: 0 });
        return path;
      };
      export const readMarkdown = async path => ({ path, markdown: '', encoding: 'UTF-8', lineEnding: 'lf', bom: false, hadDecodeErrors: false });
    ` }))
  await page.goto('/')
  await expect(page.locator('.welcome-panel')).toBeVisible()

  const pane = page.locator('.tree-pane')
  const menu = page.locator('.mt-context-menu')
  const bounds = (await pane.boundingBox())!
  const rightClickBackground = () => pane.click({ button: 'right', position: { x: 24, y: bounds.height - 8 } })
  await pane.evaluate(el => el.addEventListener('contextmenu', event => {
    el.setAttribute('data-default-prevented', String(event.defaultPrevented))
  }))

  await rightClickBackground()
  await expect(pane).toHaveAttribute('data-default-prevented', 'true')
  await menu.getByRole('menuitem', { name: 'Open Folder…' }).click()
  const existingFile = pane.getByRole('treeitem', { name: 'existing.md' })
  await expect(existingFile).toBeVisible()

  await rightClickBackground()
  await expect(menu.getByRole('menuitem', { name: 'Paste' })).toBeDisabled()
  await page.evaluate(() => {
    const resizeSensor = document.createElement('div')
    resizeSensor.style.visibility = 'hidden'
    document.body.append(resizeSensor)
    resizeSensor.dispatchEvent(new Event('scroll'))
    resizeSensor.remove()
  })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: 'New folder' }).click()
  const folderPrompt = page.getByRole('dialog', { name: 'New folder' })
  await folderPrompt.getByRole('textbox').fill('drafts')
  await folderPrompt.getByRole('button', { name: 'Confirm' }).click()
  await expect(folderPrompt).toBeHidden()
  await expect(pane.getByRole('treeitem', { name: 'drafts' })).toBeVisible()
  await expect(page.locator('.welcome-panel')).toBeVisible()

  await existingFile.click({ button: 'right' })
  await expect(menu.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible()
  await pane.getByRole('textbox', { name: 'Filter files by name' }).click({ button: 'right' })
  await expect(menu).toBeHidden()
  await expect(pane).toHaveAttribute('data-default-prevented', 'false')

  await pane.locator('#project-heading').click()
  await expect(existingFile).toBeHidden()
  await rightClickBackground()
  await menu.getByRole('menuitem', { name: 'New file' }).click()
  const filePrompt = page.getByRole('dialog', { name: 'New file' })
  await filePrompt.getByRole('textbox').fill('draft.md')
  await filePrompt.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('tab', { name: 'draft.md' })).toHaveAttribute('aria-selected', 'true')
})

test('renaming a file in a Git workspace can keep its unsaved draft', async ({ page }) => {
  await page.route('**/src/services/tauri-invoke.ts*', route => route.request().url().includes('git-rename-original')
    ? route.continue()
    : route.fulfill({ contentType: 'text/javascript', body: `
      export * from '/src/services/tauri-invoke.ts?git-rename-original';
      const workspace = 'C:/git-notes';
      const disk = new Map([[workspace + '/old.md', '# Original\\n'], [workspace + '/reference.md', '[Original](old.md)\\n']]);
      export const openFolder = async () => workspace;
      export const watchFolder = async path => path;
      export const storageResolveProject = async () => ({ mode: 'git', connection: null });
      export const listWorkspaceDirectory = async () => [...disk].map(([path, markdown]) => ({
        path, name: path.split('/').at(-1), isDir: false, isMarkdown: true, size: markdown.length, modifiedMs: 1,
      }));
      export const readMarkdown = async path => {
        if (!disk.has(path)) throw new Error('File not found: ' + path);
        return { path, markdown: disk.get(path), encoding: 'UTF-8', lineEnding: 'lf', bom: false, hadDecodeErrors: false };
      };
      export const renameWorkspaceEntry = async (root, source, name) => {
        const target = root + '/' + name;
        if (root !== workspace || !disk.has(source) || disk.has(target)) throw new Error('Invalid rename');
        disk.set(target, disk.get(source));
        disk.delete(source);
        return target;
      };
      export const saveMarkdown = async (path, markdown) => { disk.set(path, markdown); };
    ` }))
  await page.goto('/')
  await page.evaluate(async () => {
    const prefsPath = '/src/stores/preferences.ts'
    const projectPath = '/src/stores/project.ts'
    const { usePreferencesStore } = await import(prefsPath)
    const { useProjectStore } = await import(projectPath)
    usePreferencesStore().autoSave = false
    await useProjectStore().openRoot('C:/git-notes')
  })
  const pane = page.locator('.tree-pane')
  const oldFile = pane.getByRole('treeitem', { name: 'old.md' })
  await oldFile.click()
  const heading = page.locator('.muya-host h1.ag-paragraph').getByText('Original')
  await heading.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' unsaved draft')
  const status = page.locator('[data-status="save-state"]')
  await expect(status).toHaveText('Unsaved')

  const rename = async () => {
    await oldFile.click({ button: 'right' })
    await page.locator('.mt-context-menu').getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const prompt = page.getByRole('dialog', { name: 'Rename', exact: true })
    await prompt.getByRole('textbox').fill('renamed.md')
    await prompt.getByRole('button', { name: 'Confirm', exact: true }).click()
    return prompt.filter({ has: page.getByRole('button', { name: 'Rename only' }) })
  }
  const cancelled = await rename()
  await cancelled.getByRole('button', { name: 'Cancel' }).click()
  await expect(cancelled).toBeHidden()
  await expect(oldFile).toBeVisible()
  await (await rename()).getByRole('button', { name: 'Rename only' }).click()

  await expect(pane.getByRole('treeitem', { name: 'renamed.md' })).toBeVisible()
  await expect(oldFile).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'renamed.md' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.muya-host h1.ag-paragraph')).toContainText('Original unsaved draft')
  await expect(status).toHaveText('Unsaved')

  const readDisk = () => page.evaluate(async () => {
    const ipcPath = '/src/services/tauri-invoke.ts'
    const { readMarkdown } = await import(ipcPath)
    const read = async (name: string) => (await readMarkdown(`C:/git-notes/${name}`)).markdown
    return { old: await read('old.md').catch(() => null), current: await read('renamed.md'), reference: await read('reference.md') }
  })
  expect(await readDisk()).toEqual({ old: null, current: '# Original\n', reference: '[Original](old.md)\n' })
  await page.keyboard.press('Control+s')
  await expect(status).toHaveText('Saved')
  expect(await readDisk()).toEqual({ old: null, current: '# Original unsaved draft\n', reference: '[Original](old.md)\n' })
})
