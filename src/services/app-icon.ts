import { getCurrentWindow } from '@tauri-apps/api/window'

import ios26Icon from '@/assets/app-icons/ios26.png'
import ios26AltIcon from '@/assets/app-icons/ios26-alt.png'
import defaultIcon from '@/assets/app-icons/default.png'

export type AppIconId = 'ios26' | 'ios26-alt' | 'default'

export interface AppIconOption {
  id: AppIconId
  label: string
  description: string
  src: string
}

export const appIconOptions: AppIconOption[] = [
  {
    id: 'ios26',
    label: 'iOS26',
    description: 'Liquid Glass',
    src: ios26Icon,
  },
  {
    id: 'ios26-alt',
    label: 'iOS26 Alt',
    description: 'Liquid Glass variant',
    src: ios26AltIcon,
  },
  {
    id: 'default',
    label: 'Default',
    description: 'Classic',
    src: defaultIcon,
  },
]

const iconById = new Map(appIconOptions.map(icon => [icon.id, icon]))
const iconBytes = new Map<AppIconId, Uint8Array>()

export function normalizeAppIconId(value: unknown): AppIconId {
  if (value === 'default') return 'default'
  if (value === 'ios26-alt') return 'ios26-alt'
  return 'ios26'
}

export function getAppIconOption(value: unknown): AppIconOption {
  return iconById.get(normalizeAppIconId(value)) ?? appIconOptions[0]
}

async function loadIconBytes(icon: AppIconOption): Promise<Uint8Array> {
  const cached = iconBytes.get(icon.id)
  if (cached) return cached
  const res = await fetch(icon.src)
  if (!res.ok) throw new Error(`Failed to load app icon ${icon.id}: ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  iconBytes.set(icon.id, bytes)
  return bytes
}

export async function applyWindowIcon(value: unknown): Promise<void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  const icon = getAppIconOption(value)
  try {
    await getCurrentWindow().setIcon(await loadIconBytes(icon))
  } catch (err) {
    console.warn('[app-icon] failed to apply window icon', err)
  }
}
