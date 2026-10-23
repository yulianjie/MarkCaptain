import type { DocumentState } from '@/stores/help'
import type { ExportDocumentSnapshot } from './types'

export function captureExportSnapshot(document: Pick<DocumentState, 'markdown' | 'pathname' | 'filename'>): ExportDocumentSnapshot {
  return Object.freeze({
    markdown: `${document.markdown}`,
    sourcePath: document.pathname || undefined,
    fileName: document.filename || 'untitled.md',
    capturedAt: new Date().toISOString(),
    revision: crypto.randomUUID(),
  })
}

export function baseName(fileName: string): string {
  return fileName.replace(/\.(?:md|markdown|mkd|mdown|mkdn|mdtxt|mdtext)$/i, '') || 'untitled'
}

export function suggestedExportFileName(
  template: string,
  snapshot: ExportDocumentSnapshot,
  profileName: string,
  format: string,
): string {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const expanded = template
    .replace(/\{name\}/g, baseName(snapshot.fileName))
    .replace(/\{profile\}/g, profileName)
    .replace(/\{date\}/g, date)
  const safe = Array.from(expanded, character => isUnsafeFileNameCharacter(character) ? '_' : character).join('')
    .replace(/[. ]+$/g, '')
    .replace(/^\.+/g, '')
  const stem = safe || 'untitled'
  const extension = format === 'html' ? '.html' : `.${format}`
  return stem.toLocaleLowerCase().endsWith(extension) ? stem : `${stem}${extension}`
}

export function projectOutputDirectory(root: string | undefined, relativeDirectory: string): string | undefined {
  if (!root || !relativeDirectory) return root
  const separator = /^[a-z]:[\\/]|^\\\\/i.test(root) ? '\\' : '/'
  const rootTrimmed = root.replace(/[\\/]+$/, '')
  const relative = relativeDirectory.replace(/[\\/]+/g, separator).replace(/^(?:\.\\|\.\/)+/, '')
  return `${rootTrimmed}${separator}${relative}`
}

/** Apply project presets only when the active saved document is under that project root. */
export function projectForExport(sourcePath?: string | null, workspaceRoot?: string | null): string | undefined {
  if (!workspaceRoot) return undefined
  if (!sourcePath) return workspaceRoot
  const root = parseAbsolutePath(workspaceRoot)
  const source = parseAbsolutePath(sourcePath)
  if (!root || !source || root.flavor !== source.flavor || root.anchor !== source.anchor) return undefined
  if (source.parts.length < root.parts.length) return undefined
  const sameComponent = root.flavor === 'windows'
    ? (left: string, right: string) => left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : (left: string, right: string) => left === right
  return root.parts.every((part, index) => sameComponent(part, source.parts[index])) ? workspaceRoot : undefined
}

function isUnsafeFileNameCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return /[<>:"/\\|?*]/.test(character) || code < 32 || code === 127
}

interface NormalizedAbsolutePath {
  flavor: 'windows' | 'posix'
  anchor: string
  parts: string[]
}

function parseAbsolutePath(pathname: string): NormalizedAbsolutePath | null {
  let path = pathname.trim().replace(/\\/g, '/')
  let windows = false
  if (/^\/\/\?\//i.test(path)) {
    path = path.slice(4)
    windows = true
    if (/^UNC\//i.test(path)) path = `//${path.slice(4)}`
  }

  let anchor: string
  let remainder: string
  const drive = path.match(/^([a-z]):\/(.*)$/i)
  if (drive) {
    windows = true
    anchor = `drive:${drive[1].toLocaleLowerCase()}`
    remainder = drive[2]
  } else if (path.startsWith('//')) {
    windows = true
    const components = path.slice(2).split('/').filter(Boolean)
    if (components.length < 2) return null
    anchor = `unc:${components[0].toLocaleLowerCase()}/${components[1].toLocaleLowerCase()}`
    remainder = components.slice(2).join('/')
  } else {
    const volume = path.match(/^(Volume\{[^}]+\})\/(.*)$/i)
    if (windows && volume) {
      anchor = `volume:${volume[1].toLocaleLowerCase()}`
      remainder = volume[2]
    } else if (path.startsWith('/')) {
      anchor = '/'
      remainder = path.slice(1)
    } else return null
  }

  const parts: string[] = []
  for (const component of remainder.split('/')) {
    if (!component || component === '.') continue
    if (component === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(component)
  }
  return { flavor: windows ? 'windows' : 'posix', anchor, parts }
}
