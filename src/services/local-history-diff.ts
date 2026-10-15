export function historyDiff(before: string, after: string): { kind: 'same' | 'removed' | 'added'; text: string }[] {
  const left = before.split('\n'); const right = after.split('\n')
  let start = 0; let end = 0
  while (start < left.length && start < right.length && left[start] === right[start]) start++
  while (end < left.length - start && end < right.length - start && left[left.length - end - 1] === right[right.length - end - 1]) end++
  return [...left.slice(0, start).map(text => ({ kind: 'same' as const, text })), ...left.slice(start, left.length - end).map(text => ({ kind: 'removed' as const, text })), ...right.slice(start, right.length - end).map(text => ({ kind: 'added' as const, text })), ...left.slice(left.length - end).map(text => ({ kind: 'same' as const, text }))]
}
