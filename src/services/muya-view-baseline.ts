/** A delayed Muya change is valid only for the Markdown snapshot it loaded. */
export function acceptsMuyaViewChange(
  currentMarkdown: string,
  viewMarkdown: string | null,
  changeMarkdown: string,
): boolean {
  return viewMarkdown !== null
    && (currentMarkdown === viewMarkdown || changeMarkdown === currentMarkdown)
}

/** Keep a real first keystroke dirty when it races Muya's scheduled load event. */
export function isMuyaEditBeforeLoadBaseline(
  pendingBaselineUpdate: boolean,
  renderedBaseline: string | null,
  changeMarkdown: string,
): boolean {
  return pendingBaselineUpdate && renderedBaseline !== null && changeMarkdown !== renderedBaseline
}
