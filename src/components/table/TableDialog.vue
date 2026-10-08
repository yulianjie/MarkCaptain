<script setup lang="ts">
/**
 * Insert-table dialog — replaces the original
 * `upstream/src/renderer/components/tableDialog/` Vue 2 dialog.
 *
 * Opens on `bus.emit('show-table-dialog')` (typically wired to the menu's
 * "Insert Table" action so the user can pick rows × cols before committing).
 * Confirming emits `bus.emit('insert-table', { rows, columns })` which the
 * Muya host handles by invoking `muya.createTable(...)` directly.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { bus } from '@/bus'
import { useI18n } from '@/i18n'

const { t } = useI18n()

const visible = ref(false)
const rows = ref(3)
const columns = ref(3)

function open() {
  rows.value = 3
  columns.value = 3
  visible.value = true
}

function commit() {
  visible.value = false
  bus.emit('insert-table', {
    rows: Math.max(1, Math.min(50, Math.floor(rows.value))),
    columns: Math.max(1, Math.min(20, Math.floor(columns.value))),
  })
}

let unsub: (() => void) | null = null
onMounted(() => { unsub = bus.on('show-table-dialog', open) })
onBeforeUnmount(() => { unsub?.() })
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="t('table.title')"
    width="320px"
    :close-on-click-modal="true"
    append-to-body
  >
    <el-form label-position="left" label-width="80px">
      <el-form-item :label="t('table.rows')">
        <el-input-number v-model="rows" :min="1" :max="50" controls-position="right" />
      </el-form-item>
      <el-form-item :label="t('table.columns')">
        <el-input-number v-model="columns" :min="1" :max="20" controls-position="right" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" @click="commit">{{ t('common.ok') }}</el-button>
    </template>
  </el-dialog>
</template>
