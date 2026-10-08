/** Per-document trailing-newline behavior inherited from the legacy editor. */
export type TrailingNewlinePolicy = 0 | 1 | 2 | 3

const TRAILING_NEWLINES = /(?:\r\n|\r|\n)+$/

/** Markdown is always LF internally; the Rust writer restores the file EOL. */
export function normalizeMarkdownLineEndings(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n')
}

/**
 * Resolve the global "preserve each file" preference to a stable policy for
 * one document. Two or more final line breaks use policy 2 (leave as-is), an
 * empty document uses policy 3, and all other files use policy 0 or 1.
 */
export function detectTrailingNewlinePolicy(markdown: string): TrailingNewlinePolicy {
  if (!markdown) return 3
  const match = markdown.match(TRAILING_NEWLINES)
  if (!match) return 0
  const count = match[0].match(/\r\n|\r|\n/g)?.length ?? 0
  return count === 1 ? 1 : 2
}

export function resolveTrailingNewlinePolicy(
  preference: TrailingNewlinePolicy,
  markdown: string,
): TrailingNewlinePolicy {
  return preference === 2 ? detectTrailingNewlinePolicy(markdown) : preference
}

/** Apply a previously resolved per-document policy. Policies 2 and 3 preserve. */
export function adjustTrailingNewlines(
  markdown: string,
  policy: TrailingNewlinePolicy,
): string {
  if (!markdown) return ''
  if (policy === 0) return markdown.replace(TRAILING_NEWLINES, '')
  if (policy !== 1) return markdown

  const body = markdown.replace(TRAILING_NEWLINES, '')
  return body ? `${body}\n` : ''
}

/** Normalize editor line endings and then apply the tab's final-newline rule. */
export function normalizeMarkdown(
  markdown: string,
  policy: TrailingNewlinePolicy,
): string {
  return adjustTrailingNewlines(normalizeMarkdownLineEndings(markdown), policy)
}
