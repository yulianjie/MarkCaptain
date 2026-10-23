import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

const sideBar = readSource('../../src/components/sideBar/SideBar.vue')
const treePane = readSource('../../src/components/sideBar/TreePane.vue')
const openedFileRow = readSource('../../src/components/sideBar/OpenedFileRow.vue')

describe('sidebar accessibility contract', () => {
  it('names rail actions and exposes their expanded state', () => {
    expect(sideBar).toContain(':aria-label="t(item.titleKey)"')
    expect(sideBar).toContain(':aria-pressed="layout.navigationPanel === item.key"')
    expect(sideBar).toContain(':aria-expanded="layout.navigationPanel === item.key"')
    expect(sideBar).toContain(':aria-label="t(\'sideBar.preferences\')"')
  })

  it('supports pointer and keyboard sidebar resizing with separator semantics', () => {
    expect(sideBar).toContain('role="separator"')
    expect(sideBar).toContain('aria-orientation="vertical"')
    expect(sideBar).toContain('tabindex="0"')
    expect(sideBar).toContain('@keydown="onResizeKeydown"')
    expect(sideBar).toContain("event.key === 'ArrowLeft'")
    expect(sideBar).toContain("event.key === 'ArrowRight'")
    expect(sideBar).toContain('@pointerdown="onResizeDown"')
  })

  it('uses real buttons for collapsible section headings', () => {
    expect(treePane).toContain('id="opened-files-heading"')
    expect(treePane).toContain(':aria-expanded="!openedCollapsed"')
    expect(treePane).toContain('aria-controls="opened-files-content"')
    expect(treePane).toContain('id="project-heading"')
    expect(treePane).toContain(':aria-expanded="!projectCollapsed"')
    expect(treePane).toContain('aria-controls="project-content"')
    expect(treePane.match(/class="section-toggle"/g)).toHaveLength(2)
  })

  it('keeps the no-project state compact and focus rings visible', () => {
    expect(treePane).toContain(':class="{ \'has-project\': project.projectTree }"')
    expect(treePane).toMatch(/\.section\.project-section\.has-project\s*\{\s*flex:\s*1;/)
    expect(treePane).toMatch(/\.empty-state\s*\{[\s\S]*?display:\s*flex;[\s\S]*?padding:\s*10px 12px;/)
    expect(treePane).toMatch(/\.section-toggle:focus-visible/)
  })

  it('exposes the active project storage mode and project-scoped sync action', () => {
    expect(treePane).toContain('project.storageMode')
    expect(treePane).toContain("t(`sideBar.storageMode.${project.storageMode}`)")
    expect(treePane).toContain('v-if="project.storageConnection"')
    expect(treePane).toContain('@click.stop="syncProject"')
    expect(treePane).toContain('@click.stop="openSettings"')
  })
})

describe('opened-file row accessibility contract', () => {
  it('is keyboard activatable and exposes selection/current state', () => {
    expect(openedFileRow).toContain('role="listitem"')
    expect(openedFileRow).toContain('tabindex="0"')
    expect(openedFileRow).toContain(":aria-current=\"active ? 'page' : undefined\"")
    expect(openedFileRow).toContain("ev.key !== 'Enter' && ev.key !== ' '")
    expect(openedFileRow).toContain('if (ev.target !== ev.currentTarget) return')
    expect(openedFileRow).toContain('@keydown="onRowKeydown"')
  })

  it('keeps the close action visible, focusable, and at least 24px square', () => {
    expect(openedFileRow).toContain('type="button"')
    expect(openedFileRow).toContain(":aria-label=\"`${t('tabs.closeTab')}: ${tab.filename}`\"")
    expect(openedFileRow).toMatch(/\.close\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?width:\s*24px;[\s\S]*?height:\s*24px;/)
    expect(openedFileRow).toMatch(/\.close:focus-visible/)
    expect(openedFileRow).not.toMatch(/\.close\s*\{[\s\S]*?display:\s*none;/)
  })
})
