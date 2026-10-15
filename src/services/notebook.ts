import dayjs from 'dayjs'
import { parseDocument } from 'yaml'

export function frontmatter(markdown: string) {
  const match = /^(?:\uFEFF)?---\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)(?:\r?\n|$)/.exec(markdown)
  const document = parseDocument(match?.[1] ?? '', { uniqueKeys: true })
  let properties: Record<string, unknown> = {}
  if (match && !document.errors.length) {
    try {
      const value: unknown = document.toJS({ maxAliasCount: 100 })
      if (value && typeof value === 'object' && !Array.isArray(value)) properties = value as Record<string, unknown>
    } catch {
      // Keep the source usable when safe YAML alias expansion refuses a large graph.
      // Consumers can still inspect and preserve the raw YAML nodes without expanding them.
    }
  }
  return { match, document, properties }
}
export function stringList(value: unknown): string[] {
  return (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).filter((v): v is string => typeof v === 'string')
}
export function noteAliases(markdown: string): string[] { return stringList(frontmatter(markdown).properties.aliases) }
export function noteStem(path: string) { return path.replace(/\.(md|markdown|mkd|mdown|mkdn|mdtxt|mdtext)$/i, '') }
export function fuzzyScore(query: string, candidate: string): number {
  const q = query.toLocaleLowerCase(); const c = candidate.toLocaleLowerCase()
  if (q === c) return 10000
  if (c.includes(q)) return 1000 - c.indexOf(q) - c.length / 100
  let index = 0; let distance = 0
  for (const char of q) { const next = c.indexOf(char, index); if (next < 0) return -1; distance += next - index; index = next + char.length }
  return 100 - distance - c.length / 100
}
export function newNotePath(name: string): string {
  const path = name.trim().replace(/\\/g, '/')
  if (!path || path.split('/').some(p => !p || p === '.' || p === '..' || /[<>:"|?*]/.test(p) || [...p].some(c => c.charCodeAt(0) < 32) || /[. ]$/.test(p))) throw new Error('notes.invalidPath')
  return /\.md$/i.test(path) ? path.replace(/\.md$/i, '.md') : `${path}.md`
}
export function expandTemplate(content: string, title: string, date = new Date()): string {
  return content.replace(/\{\{\s*(title|date|time)(?::([^}]+))?\s*\}\}/g, (_, variable: string, format?: string) =>
    variable === 'title' ? title : dayjs(date).format(format?.trim() || (variable === 'date' ? 'YYYY-MM-DD' : 'HH:mm')))
}
export const BUILTIN_TEMPLATES = {
  'builtin:meeting': '# {{title}}\n\n{{date}} {{time}}\n\n## Agenda\n\n## Notes\n\n## Actions\n\n- [ ] \n',
  'builtin:reading': '# {{title}}\n\n{{date}}\n\n## Book\n\n## Key ideas\n\n## Reflections\n',
  'builtin:work': '# {{title}}\n\n## {{date}}\n\n## Priorities\n\n- [ ] \n\n## Progress\n\n## Next steps\n',
} as const
