import { changeDiff, type AgentChange, type DiffLine } from './agent'

export interface InlineDiffPart { kind: 'same' | 'removed' | 'added'; text: string }
export interface ReadableDiffLine {
  kind: 'same' | 'removed' | 'added' | 'change'
  beforeText?: string
  afterText?: string
  before?: InlineDiffPart[]
  after?: InlineDiffPart[]
}
export interface LinkDestinationChange { syntax: 'markdown' | 'wikilink'; labelBefore: string; labelAfter: string; targetBefore: string; targetAfter: string }
export interface TableCellChange { before: string; after: string; changed: boolean }
export interface TableDiff { before: string[][]; after: string[][]; rows: TableCellChange[][] }
export interface CodeDiff { languageBefore: string; languageAfter: string; before: string[]; after: string[] }
export interface FrontmatterFieldChange { key: string; before: string; after: string; changed: boolean }
export interface StructuredReviewDiff {
  readable: ReadableDiffLine[]
  raw: DiffLine[]
  links: LinkDestinationChange[]
  table?: TableDiff
  code?: CodeDiff
  frontmatter?: FrontmatterFieldChange[]
}

const MAX_LCS_CELLS = 240_000
const MAX_FINE_DIFF_CHARS = 80_000

function tokens(value: string, locale: string): string[] {
  try {
    const Segmenter = Intl.Segmenter
    if (Segmenter) return [...new Segmenter(locale, { granularity: 'word' }).segment(value)].map(item => item.segment)
  } catch { /* Use deterministic code-point tokenization when Segmenter is unavailable. */ }
  return value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}_]/gu) ?? []
}

function diffTokens(before: string[], after: string[]): InlineDiffPart[] {
  if (before.length * after.length > MAX_LCS_CELLS) {
    let prefix = 0
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
    let suffix = 0
    while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
    return [
      ...(before.slice(0, prefix).length ? [{ kind: 'same' as const, text: before.slice(0, prefix).join('') }] : []),
      ...(before.slice(prefix, before.length - suffix).length ? [{ kind: 'removed' as const, text: before.slice(prefix, before.length - suffix).join('') }] : []),
      ...(after.slice(prefix, after.length - suffix).length ? [{ kind: 'added' as const, text: after.slice(prefix, after.length - suffix).join('') }] : []),
      ...(suffix ? [{ kind: 'same' as const, text: before.slice(before.length - suffix).join('') }] : []),
    ]
  }
  const rows = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1))
  for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) {
    rows[i]![j] = before[i] === after[j] ? rows[i + 1]![j + 1]! + 1 : Math.max(rows[i + 1]![j]!, rows[i]![j + 1]!)
  }
  const result: InlineDiffPart[] = []
  const push = (kind: InlineDiffPart['kind'], text: string) => {
    if (!text) return
    const last = result.at(-1)
    if (last?.kind === kind) last.text += text
    else result.push({ kind, text })
  }
  let i = 0, j = 0
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      push('same', before[i]!)
      i++; j++
    }
    else if (i < before.length && (j === after.length || rows[i + 1]![j]! >= rows[i]![j + 1]!)) push('removed', before[i++]!)
    else push('added', after[j++]!)
  }
  return result
}

export function inlineMarkdownDiff(before: string, after: string, locale = 'en'): { before: InlineDiffPart[]; after: InlineDiffPart[] } {
  if (before.length + after.length > MAX_FINE_DIFF_CHARS) return {
    before: before ? [{ kind: 'removed', text: before }] : [],
    after: after ? [{ kind: 'added', text: after }] : [],
  }
  const parts = diffTokens(tokens(before, locale), tokens(after, locale))
  return {
    before: parts.filter(part => part.kind !== 'added'),
    after: parts.filter(part => part.kind !== 'removed'),
  }
}

function readableDiff(raw: DiffLine[], locale: string): ReadableDiffLine[] {
  const result: ReadableDiffLine[] = []
  for (let i = 0; i < raw.length;) {
    const line = raw[i]!
    if (line.kind === 'same') { result.push({ kind: 'same', beforeText: line.text, afterText: line.text }); i++; continue }
    const removed: string[] = [], added: string[] = []
    while (i < raw.length && raw[i]!.kind !== 'same') {
      const change = raw[i++]!
      if (change.kind === 'removed') removed.push(change.text)
      if (change.kind === 'added') added.push(change.text)
    }
    const paired = Math.min(removed.length, added.length)
    for (let index = 0; index < paired; index++) {
      const beforeText = removed[index]!, afterText = added[index]!
      const parts = inlineMarkdownDiff(beforeText, afterText, locale)
      result.push({ kind: 'change', beforeText, afterText, ...parts })
    }
    for (const text of removed.slice(paired)) result.push({ kind: 'removed', beforeText: text })
    for (const text of added.slice(paired)) result.push({ kind: 'added', afterText: text })
  }
  return result
}

function markdownLinks(text: string, syntax: 'markdown' | 'wikilink') {
  if (syntax === 'markdown') {
    const pattern = /(!?)\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g
    return [...text.matchAll(pattern)].map(match => ({ label: match[2] ?? '', target: match[3] ?? match[4] ?? '' }))
  }
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g
  return [...text.matchAll(pattern)].map(match => ({ label: match[2] ?? match[1] ?? '', target: match[1] ?? '' }))
}

function linkChanges(before: string, after: string): LinkDestinationChange[] {
  const changes: LinkDestinationChange[] = []
  for (const syntax of ['markdown', 'wikilink'] as const) {
    const oldLinks = markdownLinks(before, syntax), newLinks = markdownLinks(after, syntax)
    for (let i = 0; i < Math.max(oldLinks.length, newLinks.length); i++) {
      const oldLink = oldLinks[i], newLink = newLinks[i]
      if (oldLink && newLink && (oldLink.target !== newLink.target || oldLink.label !== newLink.label)) changes.push({
        syntax, labelBefore: oldLink.label, labelAfter: newLink.label, targetBefore: oldLink.target, targetAfter: newLink.target,
      })
    }
  }
  return changes
}

function splitTableRow(line: string): string[] {
    let value = line.trim().replace(/^\|/, '').replace(/\|$/, '')
    const cells: string[] = []; let current = ''; let inCode = false; let ticks = 0
    for (let index = 0; index < value.length; index++) {
      const char = value[index]!
      if (char === '`') {
        let count = 1; while (value[index + count] === '`') count++
        if (!inCode) { inCode = true; ticks = count } else if (count === ticks) inCode = false
        current += '`'.repeat(count); index += count - 1; continue
      }
      if (char === '|' && !inCode && value[index - 1] !== '\\') { cells.push(current.trim().replace(/\\\|/g, '|')); current = '' }
      else current += char
    }
    cells.push(current.trim().replace(/\\\|/g, '|'))
    return cells
}

function tableRows(text: string): string[][] | null {
  const lines = text.split('\n')
  const separator = lines.findIndex(line => line.includes('|') && splitTableRow(line).length > 1
    && splitTableRow(line).every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s/g, ''))))
  if (separator < 1 || !lines[separator - 1]!.includes('|')) return null
  let start = separator - 1
  while (start > 0 && lines[start - 1]!.includes('|')) start--
  let end = separator + 1
  while (end < lines.length && lines[end]!.includes('|')) end++
  const rows = lines.slice(start, end).filter((_, index) => start + index !== separator).map(splitTableRow)
  if (!rows.length) return null
  return rows
}

function tableDiff(beforeText: string, afterText: string): TableDiff | undefined {
  const before = tableRows(beforeText), after = tableRows(afterText)
  if (!before && !after) return undefined
  const old = before ?? [], next = after ?? []
  const rows: TableCellChange[][] = []
  for (let row = 0; row < Math.max(old.length, next.length); row++) {
    const oldRow = old[row] ?? [], newRow = next[row] ?? []
    rows.push(Array.from({ length: Math.max(oldRow.length, newRow.length) }, (_, column) => {
      const a = oldRow[column] ?? '', b = newRow[column] ?? ''
      return { before: a, after: b, changed: a !== b }
    }))
  }
  return { before: old, after: next, rows }
}

function codeBlock(text: string): { language: string; lines: string[] } | null {
  const match = text.match(/(?:^|\n)\s*(```+|~~~+)\s*([^\n]*)\n([\s\S]*?)\n\s*\1\s*(?:\n|$)/)
  return match ? { language: match[2]!.trim(), lines: match[3]!.split('\n') } : null
}

function codeDiff(beforeText: string, afterText: string): CodeDiff | undefined {
  const before = codeBlock(beforeText), after = codeBlock(afterText)
  if (!before && !after) return undefined
  return { languageBefore: before?.language ?? '', languageAfter: after?.language ?? '', before: before?.lines ?? [], after: after?.lines ?? [] }
}

function frontmatterFields(text: string): Map<string, string> | null {
  const lines = text.replace(/^\uFEFF/, '').split('\n')
  if (lines[0]?.trim() !== '---') return null
  const end = lines.indexOf('---', 1)
  if (end < 0) return null
  const values = new Map<string, string>()
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([^\s:#][^:]*):\s*(.*)$/)
    if (match) values.set(match[1]!.trim(), match[2]!.trim())
  }
  return values
}

function frontmatterDiff(beforeText: string, afterText: string): FrontmatterFieldChange[] | undefined {
  const before = frontmatterFields(beforeText), after = frontmatterFields(afterText)
  if (!before && !after) return undefined
  const keys = [...new Set([...(before?.keys() ?? []), ...(after?.keys() ?? [])])]
  return keys.map(key => {
    const a = before?.get(key) ?? '', b = after?.get(key) ?? ''
    return { key, before: a, after: b, changed: a !== b }
  })
}

export function buildReviewDiff(change: AgentChange, locale = 'en'): StructuredReviewDiff {
  const raw = changeDiff(change)
  const table = tableDiff(change.oldText, change.newText)
  const code = codeDiff(change.oldText, change.newText)
  const frontmatter = frontmatterDiff(change.oldText, change.newText)
  return {
    raw,
    readable: readableDiff(raw, locale),
    links: linkChanges(change.oldText, change.newText),
    ...(table ? { table } : {}),
    ...(code ? { code } : {}),
    ...(frontmatter ? { frontmatter } : {}),
  }
}
