import type { NoteAnalysis } from './note-index'
import { noteStem } from './notebook'
export class QueryError extends Error { constructor(public key: string, public detail = '') { super(key) } }
function tokens(query: string): string[] {
  const result: string[] = []; let token = ''; let quoted = false; let escaped = false
  for (const char of query) {
    if (escaped) { token += char; escaped = false }
    else if (char === '\\' && quoted) escaped = true
    else if (char === '"') quoted = !quoted
    else if (!quoted && /\s/.test(char)) { if (token) { result.push(token); token = '' } }
    else token += char
  }
  if (quoted || escaped) throw new QueryError('notes.queryQuote')
  if (token) result.push(token)
  return result
}
type Predicate = (note: NoteAnalysis) => boolean
function predicate(token: string): Predicate {
  const negate = token.startsWith('-'); if (negate) token = token.slice(1)
  const separator = token.indexOf(':'); const field = separator < 0 ? 'text' : token.slice(0, separator)
  const value = separator < 0 ? token : token.slice(separator + 1)
  if (!value) throw new QueryError('notes.queryValue', field)
  const includes = (candidate: string) => candidate.toLocaleLowerCase().includes(value.toLocaleLowerCase())
  let fn: Predicate
  if (field === 'text') fn = note => includes(note.prose)
  else if (field === 'name') fn = note => includes(noteStem(note.relative.split('/').pop()!)) || note.aliases.some(includes)
  else if (field === 'path') fn = note => includes(note.relative)
  else if (field === 'tag') fn = note => note.tags.some(tag => tag.toLowerCase() === value.replace(/^#/, '').toLowerCase() || tag.toLowerCase().startsWith(value.replace(/^#/, '').toLowerCase() + '/'))
  else if (field === 'task') {
    if (!['open', 'done', 'any'].includes(value)) throw new QueryError('notes.queryTask')
    fn = note => note.tasks.some(task => value === 'any' || task.checked === (value === 'done'))
  } else if (field.startsWith('prop.')) {
    const key = field.slice(5); if (!key) throw new QueryError('notes.queryField', field)
    const comparison = /^(>=|<=|>|<|=)?(.+)$/.exec(value)!
    const expected = comparison[2]; const operator = comparison[1] ?? '='
    if (operator !== '=' && !Number.isFinite(Number(expected))) throw new QueryError('notes.queryValue', field)
    fn = note => {
      if (!Object.prototype.hasOwnProperty.call(note.properties, key)) return false
      const property = note.properties[key]
      if (operator === '=') return (Array.isArray(property) ? property : [property]).some(v => typeof v !== 'object' && String(v).toLocaleLowerCase() === expected.toLocaleLowerCase())
      if (typeof property !== 'number') return false
      return operator === '>=' ? property >= Number(expected) : operator === '<=' ? property <= Number(expected) : operator === '>' ? property > Number(expected) : property < Number(expected)
    }
  } else throw new QueryError('notes.queryField', field)
  return negate ? note => !fn(note) : fn
}
export function compileNoteQuery(query: string): Predicate {
  const parts = tokens(query); const groups: Predicate[][] = [[]]; let requireTerm = false; let negateNext = false
  for (const part of parts) {
    if (part === 'OR' || part === '|') { if (!groups.at(-1)!.length || requireTerm) throw new QueryError('notes.queryOperator'); groups.push([]); requireTerm = true; continue }
    if (part === 'AND') { if (!groups.at(-1)!.length || requireTerm) throw new QueryError('notes.queryOperator'); requireTerm = true; continue }
    if (part === 'NOT') { if (negateNext) throw new QueryError('notes.queryOperator'); negateNext = true; requireTerm = true; continue }
    const fn = predicate(part); groups.at(-1)!.push(negateNext ? note => !fn(note) : fn); negateNext = false; requireTerm = false
  }
  if (requireTerm || negateNext) throw new QueryError('notes.queryOperator')
  return note => groups.some(group => group.every(fn => fn(note)))
}
