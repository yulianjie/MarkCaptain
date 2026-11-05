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
