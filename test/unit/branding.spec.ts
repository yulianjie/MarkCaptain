import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

const packageConfig = JSON.parse(readSource('../../package.json')) as {
  name: string
  description: string
}
const tauriConfig = JSON.parse(readSource('../../src-tauri/tauri.conf.json')) as {
  productName: string
  identifier: string
  app: { windows: Array<{ title: string }> }
  bundle: { fileAssociations: Array<{ name: string }> }
}

describe('MarkCaptain application identity', () => {
  it('uses a distinct package and bundle identity', () => {
    expect(packageConfig.name).toBe('markcaptain')
    expect(packageConfig.description).toContain('writing Agent')
    expect(tauriConfig.productName).toBe('MarkCaptain')
    expect(tauriConfig.identifier).toBe('io.github.yulianjie.markcaptain')
    expect(tauriConfig.app.windows.map(window => window.title)).toEqual(['MarkCaptain'])
    expect(tauriConfig.bundle.fileAssociations.map(association => association.name)).toEqual([
      'MarkCaptain.Markdown',
    ])
  })

  it('keeps native package names aligned with the application identity', () => {
    const cargo = readSource('../../src-tauri/Cargo.toml')
    const windowsRegistry = readSource('../../src-tauri/windows/markdown-file-icon.wxs')
    const windowsNsis = readSource('../../src-tauri/windows/markdown-file-icon.nsh')
    const linuxDesktop = readSource('../../resources/linux/markcaptain.desktop')

    expect(cargo).toContain('name = "markcaptain"')
    expect(cargo).toContain('name = "markcaptain_lib"')
    expect(windowsRegistry).toContain('Applications\\markcaptain.exe')
    expect(windowsNsis).toContain('Software\\Classes\\MarkCaptain.Markdown')
    expect(linuxDesktop).toContain('Name=MarkCaptain')
    expect(linuxDesktop).toContain('Exec=markcaptain %F')
  })
})
