<script setup lang="ts">
import { computed, ref } from 'vue'
import { agentM1Copy } from '@/services/agent-m1-copy'
import { buildReviewDiff, type InlineDiffPart } from '@/services/agent-review-diff'
import type { AgentChange } from '@/services/agent'

const props = defineProps<{ change: AgentChange; locale: string }>()
const mode = ref<'readable' | 'structured' | 'raw'>('readable')
const diff = computed(() => buildReviewDiff(props.change, props.locale))
const hasStructured = computed(() => Boolean(diff.value.links.length || diff.value.table || diff.value.code || diff.value.frontmatter))
const text = (key: Parameters<typeof agentM1Copy>[1]) => agentM1Copy(props.locale, key)
const partClass = (part: InlineDiffPart) => part.kind === 'removed' ? 'agent-diff-inline-removed' : part.kind === 'added' ? 'agent-diff-inline-added' : ''
</script>

<template>
  <section class="agent-diff-view">
    <nav class="agent-diff-modes" :aria-label="text('readableDiff')">
      <button type="button" :aria-pressed="mode === 'readable'" @click="mode = 'readable'">{{ text('readableDiff') }}</button>
      <button v-if="hasStructured" type="button" :aria-pressed="mode === 'structured'" @click="mode = 'structured'">{{ text('structuredDiff') }}</button>
      <button type="button" :aria-pressed="mode === 'raw'" @click="mode = 'raw'">{{ text('rawDiff') }}</button>
    </nav>

    <div v-if="mode === 'readable'" class="agent-readable-diff">
      <div v-for="(line, index) in diff.readable" :key="index" class="agent-readable-line" :class="`agent-readable-${line.kind}`">
        <template v-if="line.kind === 'change'">
          <div class="agent-readable-before"><span class="agent-diff-sign" aria-hidden="true">−</span><span class="agent-visually-hidden">{{ text('before') }} </span><span v-for="(part, partIndex) in line.before" :key="partIndex" :class="partClass(part)">{{ part.text || '\u00a0' }}</span></div>
          <div class="agent-readable-after"><span class="agent-diff-sign" aria-hidden="true">+</span><span class="agent-visually-hidden">{{ text('after') }} </span><span v-for="(part, partIndex) in line.after" :key="partIndex" :class="partClass(part)">{{ part.text || '\u00a0' }}</span></div>
        </template>
        <div v-else><span class="agent-diff-sign" aria-hidden="true">{{ line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' ' }}</span>{{ line.afterText ?? line.beforeText ?? '\u00a0' }}</div>
      </div>
      <section v-if="diff.links.length" class="agent-link-diff">
        <strong>{{ text('linkDestination') }}</strong>
        <div v-for="(link, index) in diff.links" :key="index">
          <code>{{ link.labelBefore || link.targetBefore }}</code>
          <span class="agent-link-arrow">→</span>
          <code>{{ link.labelAfter || link.targetAfter }}</code>
          <small>{{ link.targetBefore }} → {{ link.targetAfter }}</small>
        </div>
      </section>
    </div>

    <div v-else-if="mode === 'structured'" class="agent-structured-diff">
      <section v-if="diff.table">
        <strong>{{ text('table') }}</strong>
        <table>
<tbody>
<tr v-for="(row, rowIndex) in diff.table.rows" :key="rowIndex">
<td v-for="(cell, columnIndex) in row" :key="columnIndex">
          <template v-if="cell.changed"><del v-if="cell.before">{{ cell.before }}</del><ins v-if="cell.after">{{ cell.after }}</ins></template>
          <span v-else>{{ cell.after }}</span>
        </td>
</tr>
</tbody>
</table>
      </section>
      <section v-if="diff.code">
        <strong>{{ text('code') }} <small>{{ diff.code.languageBefore || diff.code.languageAfter }}</small></strong>
        <div class="agent-structured-columns"><div><label>{{ text('before') }}</label><pre>{{ diff.code.before.join('\n') }}</pre></div><div><label>{{ text('after') }}</label><pre>{{ diff.code.after.join('\n') }}</pre></div></div>
      </section>
      <section v-if="diff.frontmatter?.length">
        <strong>{{ text('frontmatter') }}</strong>
        <table>
<thead><tr><th>Key</th><th>{{ text('before') }}</th><th>{{ text('after') }}</th></tr></thead><tbody>
          <tr v-for="field in diff.frontmatter" :key="field.key" :class="{ 'agent-structured-changed': field.changed }"><th>{{ field.key }}</th><td>{{ field.before }}</td><td>{{ field.after }}</td></tr>
        </tbody>
</table>
      </section>
      <section v-if="diff.links.length">
        <strong>{{ text('linkDestination') }}</strong>
        <div v-for="(link, index) in diff.links" :key="index" class="agent-structured-link"><span>{{ link.labelBefore }} → {{ link.labelAfter }}</span><code>{{ link.targetBefore }} → {{ link.targetAfter }}</code></div>
      </section>
    </div>

    <pre v-else class="agent-raw-diff"><code><span v-for="(line, index) in diff.raw" :key="index" class="agent-diff-line" :class="`agent-line-${line.kind}`"><span class="agent-diff-sign" aria-hidden="true">{{ line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' ' }}</span><span class="agent-visually-hidden">{{ line.kind === 'added' ? text('after') : line.kind === 'removed' ? text('before') : '' }} </span>{{ line.text || '\u00a0' }}</span></code></pre>
  </section>
</template>
