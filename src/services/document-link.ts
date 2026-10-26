import { resolveLocalImagePath } from './local-image-src'
import { splitTarget } from './note-index'

export function isExternalDocumentLink(href: string): boolean {
  return /^(?:[\w+.-]+:|\/\/)/.test(href)
    && !/^file:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)
}

/** Resolve against the source file, never the WebView's application URL. */
export function resolveDocumentLink(href: string, documentPath: string) {
  const { path, heading } = splitTarget(href, 'markdown')
  // splitTarget already unescapes Markdown and URL encoding. Protect literal
  // URL delimiters before passing through the shared filesystem resolver.
  const escapedPath = path.replace(/[%?#]/g, character => encodeURIComponent(character))
  return { path: path ? resolveLocalImagePath(escapedPath, documentPath) : documentPath || null, heading }
}
