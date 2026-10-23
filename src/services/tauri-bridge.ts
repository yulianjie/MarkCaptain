/**
 * Centralised subscription to Rust-side events.
 *
 * One file lists every `mt://...` channel emitted from the backend, with
 * typed payloads. Adding a new event means: (1) declare the payload type
 * here, (2) wire it into the registry below, (3) consume it from a
 * component/store via `useTauriEvent('channel')`.
 */

import type { App } from 'vue'
import type { AgentEvent } from './agent'
import type { StorageStatusEvent } from './cloud-storage'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

/* ─── payload types ──────────────────────────────────────────── */

export interface SecondInstance {
  argv: string[]
  cwd: string
}

export type FileWatchEvent =
  | { kind: 'created'; path: string }
  | { kind: 'modified'; path: string }
  | { kind: 'removed'; path: string }
  | { kind: 'renamed'; from: string; to: string }

export interface PrefsChanged {
  patch: Record<string, unknown>
}

export interface MenuLineEndingChange { windowLabel: string; lineEnding: 'lf' | 'crlf' }
export interface MenuFormatChange { windowLabel: string; formats: string[] }
export interface MenuSidebarChange { windowLabel: string; visible: boolean }
export interface EditorSelectionChange { windowLabel: string; selection: unknown }
export interface UpdaterAvailable { version: string; notes?: string }

export interface EventRegistry {
  'mt://agent/event': AgentEvent
  'mt://storage/status': StorageStatusEvent
  'mt://window/backdrop': boolean
  'mt://second-instance': SecondInstance
  'mt://fs/change': FileWatchEvent
  'mt://prefs/changed': PrefsChanged
  'mt://userdata/changed': PrefsChanged
  'mt://menu/action': string
  'mt://menu/line-ending': MenuLineEndingChange
  'mt://menu/format': MenuFormatChange
  'mt://menu/sidebar': MenuSidebarChange
  'mt://editor/selection-changed': EditorSelectionChange
  'mt://palette/show': null
  'mt://view/toggle': { entry: string }
  'mt://window/open-file': null
  'mt://export/print': null
  'mt://updater/available': UpdaterAvailable
}

export type EventName = keyof EventRegistry

/* ─── bridge ─────────────────────────────────────────────────── */

const unlisteners: UnlistenFn[] = []

export async function listenTyped<K extends EventName>(
  name: K,
  handler: (payload: EventRegistry[K]) => void,
): Promise<UnlistenFn> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    // Vite-only browser dev mode: no Tauri event bus available. Return a
    // no-op unlisten so callers (e.g. listenForMain.install) can await
    // without throwing and downstream setup keeps running.
    return () => {}
  }
  const options = name === 'mt://agent/event' || name === 'mt://window/open-file'
    ? { target: { kind: 'WebviewWindow' as const, label: getCurrentWebviewWindow().label } }
    : undefined
  const fn = await listen<EventRegistry[K]>(name, e => handler(e.payload), options)
  unlisteners.push(fn)
  return fn
}

/** Called once from `main.ts` before mount. Wires global listeners. */
export function initTauriBridge(_app: App): void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    // Running outside Tauri (e.g. Vitest); skip silently.
    return
  }
  void listenTyped('mt://second-instance', payload => {
    window.dispatchEvent(new CustomEvent('mt:second-instance', { detail: payload }))
  })
}

/** Tear down all listeners. Call from HMR `dispose` hooks if needed. */
export function disposeTauriBridge(): void {
  while (unlisteners.length) {
    const fn = unlisteners.pop()
    try { fn?.() } catch { /* ignore */ }
  }
}
