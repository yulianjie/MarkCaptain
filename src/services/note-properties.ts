import { isAlias, isMap, isNode, isScalar, isSeq, stringify, type Node } from 'yaml'
import { frontmatter } from './notebook'
export type PropertyType = 'text' | 'list' | 'number' | 'boolean' | 'date'
function hasSemanticYamlSyntax(node: Node): boolean {
  return isAlias(node) || Boolean(node.anchor) || Boolean(node.tag)
}
function isEditableNode(node: unknown): node is Node {
  if (!isNode(node) || hasSemanticYamlSyntax(node)) return false
  if (isScalar(node)) return true
  return isSeq(node)
    && !node.comment && !node.commentBefore
    && node.items.every(item => isScalar(item) && isEditableNode(item) && !item.comment && !item.commentBefore)
}
export function propertyType(value: unknown): PropertyType | null {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number' && Number.isFinite(value)) return 'number'
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'date' : 'text'
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) return 'list'
  return null
}
function editorCanRepresent(value: unknown, type: PropertyType): boolean {
  if (type === 'text' || type === 'date') return typeof value === 'string' && !/[\r\n]/.test(value)
  if (type === 'list') return Array.isArray(value) && value.every(item =>
    typeof item === 'string' && item.length > 0 && item.trim() === item && !/[\r\n]/.test(item),
  )
  return true
}
function samePropertyValue(first: unknown, second: unknown): boolean {
  if (Array.isArray(first) && Array.isArray(second)) {
    return first.length === second.length && first.every((value, index) => value === second[index])
  }
  return Object.is(first, second)
}
export function editableProperties(markdown: string) {
  const { document, properties } = frontmatter(markdown)
  return Object.entries(properties).map(([key,value]) => {
    const node = document.get(key, true)
    const supported = isEditableNode(node)
    const type = supported ? propertyType(value) : null
    return { key, value, type: type && editorCanRepresent(value, type) ? type : null }
  })
}
export function updateProperty(markdown: string, key: string, value: string | string[] | number | boolean): string {
  if (!key.trim() || key.includes('\n') || key.length > 128 || propertyType(value) === null) throw new Error('notes.invalidProperty')
  const metadata = frontmatter(markdown)
  if (metadata.document.errors.length || metadata.match && metadata.document.contents && !isMap(metadata.document.contents)) throw new Error('notes.invalidYaml')
  if (!metadata.match) {
    const bom = markdown.startsWith('\uFEFF') ? '\uFEFF' : ''
    return `${bom}---\n${stringify({ [key]: value })}---\n${markdown.slice(bom.length)}`
  }
  const node = metadata.document.get(key, true)
  if (node) {
    if (!isEditableNode(node) || propertyType(metadata.properties[key]) === null || !node.range) throw new Error('notes.unsupportedProperty')
    const oldValue = metadata.properties[key]
    const oldType = propertyType(oldValue)!
    if (!editorCanRepresent(oldValue, oldType)) throw new Error('notes.unsupportedProperty')
    if (samePropertyValue(oldValue, value)) return markdown
    const newType = propertyType(value)!
    if (!editorCanRepresent(value, newType)) throw new Error('notes.invalidProperty')
    const offset = metadata.match[0].indexOf('\n') + 1
    const from = offset + node.range[0]; const to = offset + node.range[1]
    const old = markdown.slice(from, to)
    const serialized = Array.isArray(value) ? JSON.stringify(value) : stringify(value).trimEnd()
    return markdown.slice(0, from) + serialized + (old.endsWith('\n') ? '\n' : '') + markdown.slice(to)
  }
  const valueType = propertyType(value)!
  if (!editorCanRepresent(value, valueType)) throw new Error('notes.invalidProperty')
  const end = metadata.match[0].search(/(?:---|\.\.\.)(?:\r?\n|$)$/)
  return markdown.slice(0, end) + stringify({ [key]: value }) + markdown.slice(end)
}
export function parsePropertyInput(type: PropertyType, input: string): string | string[] | number | boolean {
  if (type === 'number') { if (!input.trim() || !Number.isFinite(Number(input))) throw new Error('notes.invalidProperty'); return Number(input) }
  if (type === 'boolean') { if (!['true', 'false'].includes(input)) throw new Error('notes.invalidProperty'); return input === 'true' }
  if (type === 'list') return input.split('\n').map(s => s.trim()).filter(Boolean)
  if (type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(input) || Number.isNaN(Date.parse(input)) || new Date(input).toISOString().slice(0,10) !== input)) throw new Error('notes.invalidProperty')
  return input
}
