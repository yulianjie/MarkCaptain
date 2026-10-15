import { autocompletion, type CompletionContext } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import { useNotebookStore } from '@/stores/notebook'
import { noteStem } from './notebook'
import { resolveNoteLink, splitTarget, type NoteAnalysis } from './note-index'

export interface WikiCompletionOption { label: string; detail: string; value: string }

function wikiPath(note: NoteAnalysis, notes: readonly NoteAnalysis[]) {
  const stem = noteStem(note.relative)
  const key = stem.toLocaleLowerCase()
  return notes.some(other => other !== note && noteStem(other.relative).toLocaleLowerCase() === key)
    ? note.relative
    : stem
}

export function wikiCompletionOptions(query: string, current: string, notes: readonly NoteAnalysis[]): WikiCompletionOption[] {
  const target = splitTarget(query)
  if (query.includes('#')) {
    const candidates = resolveNoteLink(current, { kind: 'wiki', target: query }, notes)
    return candidates.flatMap(note => note.headings.map(heading => {
      const referencePath = candidates.length > 1 ? wikiPath(note, notes) : target.path || wikiPath(note, notes)
      const labelPath = target.path || referencePath
      const fragment = heading.slug || heading.title
      return {
        label: `${labelPath}#${fragment}${candidates.length > 1 ? ` — ${note.relative}` : ''}`,
        detail: note.relative,
        value: `${referencePath}#${fragment}`,
      }
    }))
  }

  const choices: { name: string; note: NoteAnalysis }[] = []
  for (const note of notes) {
    const names = [...new Map([noteStem(note.relative), ...note.aliases].filter(name => name.trim()).map(name => [name.toLocaleLowerCase(), name])).values()]
    for (const name of names) choices.push({ name, note })
  }
  const counts = new Map<string, Set<string>>()
  for (const choice of choices) {
    const key = choice.name.toLocaleLowerCase()
    const paths = counts.get(key) ?? new Set<string>()
    paths.add(choice.note.relative)
    counts.set(key, paths)
  }
  return choices.map(({ name, note }) => ({
    label: (counts.get(name.toLocaleLowerCase())?.size ?? 0) > 1 ? `${name} — ${note.relative}` : name,
    detail: note.relative,
    value: wikiPath(note, notes),
  }))
}

export function noteCompletions() {
  return autocompletion({ override: [(context: CompletionContext) => {
    let node = syntaxTree(context.state).resolveInner(context.pos, -1)
    while (node.parent) { if (['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock'].includes(node.name)) return null; node = node.parent }
    const match = context.matchBefore(/\[\[[^\]\n]*/); if (!match) return null
    const notebook = useNotebookStore(); const query = match.text.slice(2)
    const options = wikiCompletionOptions(query, notebook.currentNote?.relative ?? '', notebook.analyses)
    return { from: match.from + 2, options: options.map(option => ({ ...option, apply: option.value + (context.state.sliceDoc(context.pos, context.pos + 2) === ']]' ? '' : ']]') })), validFor: /^[^\]\n]*$/ }
  }] })
}
