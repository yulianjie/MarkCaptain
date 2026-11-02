<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { bus } from '@/bus'
import { useI18n } from '@/i18n'
import { useEditorStore } from '@/stores/editor'
import { useProjectStore } from '@/stores/project'
import { exportProjectList } from '@/services/tauri-invoke'
import { BUILTIN_PROFILES, resolveExportProfile } from '@/services/export/profiles'
import { loadProjectExportPlan, persistentProjectChapters, saveProjectExportPlan } from '@/services/export/project-config'
import { projectExportCopy, projectExportDiagnostic } from '@/services/export/project-copy'
import { createProjectExportController } from '@/services/export/project-workflow'
import type { ProjectExportCandidate, ProjectExportChapter, ProjectExportMode, ProjectExportPlan, ProjectExportState } from '@/services/export/project-types'
import type { ExportConfigSnapshot, ExportFormat, ExportProfile, ExportThemeId } from '@/services/export/types'
import { EXPORT_THEME_LABELS } from '@/export-themes'
import ExportPreview from './ExportPreview.vue'
import { Layers, ArrowUpRight, RefreshCw, Bookmark, LockKeyhole, FileText } from '@lucide/vue'

const { locale } = useI18n()
const editor = useEditorStore()
const project = useProjectStore()
const copy = computed(() => projectExportCopy(locale.value))
const root = computed(() => project.projectTree?.pathname ?? '')
const visible = ref(false)
const loading = ref(false)
const saving = ref(false)
const configReady = ref(false)
const error = ref('')
const notice = ref('')
const candidates = ref<ProjectExportCandidate[]>([])
const chapters = ref<ProjectExportChapter[]>([])
const filter = ref('')
const mode = ref<ProjectExportMode>('batch')
const formats = ref<ExportFormat[]>(['html'])
const title = ref('')
const bookFileName = ref('book')
const overwrite = ref(false)
const profile = ref<ExportProfile>(clone(BUILTIN_PROFILES['simple-reading']))
const config = ref<ExportConfigSnapshot>({ config: null, fingerprint: null })
const acknowledged = ref(false)
const previewReady = ref(false)
const state = shallowRef<ProjectExportState>({ stage: 'idle', snapshot: null, items: [], warnings: [], blocking: [], previewHtml: '', error: '' })
const controller = createProjectExportController({
  getTabs: () => editor.tabs,
  onChange: next => { state.value = { ...next, items: next.items.map(item => ({ ...item })) } },
})
let loadGeneration = 0
let unsubscribe: (() => void) | undefined
const busy = computed(() => state.value.stage === 'preparing' || state.value.stage === 'running')
const locked = computed(() => busy.value || loading.value || saving.value)
const filteredCandidates = computed(() => candidates.value.filter(item => item.relative.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase())))
const untitledTabs = computed(() => editor.tabs.filter(tab => !tab.pathname))
const profileChoices = computed(() => {
  const result = [...(config.value.config?.profiles ?? [])]
  for (const item of Object.values(BUILTIN_PROFILES)) if (!result.some(value => value.id === item.id)) result.push(item)
  return result
})
const themeChoices = computed(() => Object.entries(EXPORT_THEME_LABELS).map(([id, labels]) => ({
  id: id as ExportThemeId, label: locale.value === 'zh-CN' ? labels.zh : locale.value === 'ja' ? labels.ja : labels.en,
})))
const canRun = computed(() => state.value.stage === 'ready' && !state.value.blocking.length
  && (!state.value.warnings.length || acknowledged.value) && (!state.value.previewHtml || previewReady.value) && !locked.value)
const canRetry = computed(() => ['failed', 'completed', 'cancelled'].includes(state.value.stage)
  && state.value.items.some(item => item.status === 'failed' || item.status === 'cancelled')
  && (!state.value.warnings.length || acknowledged.value) && !locked.value)
const completed = computed(() => state.value.items.filter(item => ['completed', 'failed', 'cancelled'].includes(item.status)).length)
const formSignature = computed(() => JSON.stringify([root.value, chapters.value, mode.value, formats.value, title.value, bookFileName.value, overwrite.value, profile.value]))
const selectedBufferSignature = computed(() => {
  const key = (path: string) => {
    const normalized = path.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').replace(/\/+$/, '')
    return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
  }
  const paths = new Set(chapters.value.flatMap(chapter => chapter.relativePath ? [key(`${root.value}/${chapter.relativePath}`)] : []))
  const ids = new Set(chapters.value.flatMap(chapter => chapter.tabId ? [chapter.tabId] : []))
  return JSON.stringify(editor.tabs.filter(tab => ids.has(tab.id) || tab.pathname && paths.has(key(tab.pathname)))
    .map(tab => [tab.id, tab.pathname, tab.markdown]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))))
})

watch(formSignature, () => {
  controller.invalidate()
  acknowledged.value = false
  notice.value = ''
}, { flush: 'sync' })
watch(selectedBufferSignature, () => {
  if (visible.value && state.value.snapshot) { controller.invalidate(); acknowledged.value = false }
}, { flush: 'sync' })
watch(() => state.value.previewHtml, () => { previewReady.value = false })
watch(() => JSON.stringify([...new Set(state.value.warnings.map(issue => JSON.stringify([issue.code, issue.message, issue.resource, issue.line])))].sort()), () => {
  acknowledged.value = false
}, { flush: 'sync' })
watch(root, () => {
  loadGeneration++
  controller.invalidate()
  if (visible.value) { visible.value = false; void controller.cancel() }
})

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function displayError(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : String(value)
  const localized = projectExportDiagnostic(locale.value, message, '')
  if (localized) return localized
  if (/project-export-plan-invalid/i.test(message)) return copy.value.invalid
  if (/conflict|fingerprint|changed on disk/i.test(message)) return copy.value.configConflict
  if (/revision|source.changed|snapshot.changed/i.test(message)) return copy.value.taskChanged
  return `${fallback} ${message}`
}
function selected(key: string): boolean { return chapters.value.some(chapter => chapter.key === key) }
function canAddChapter(input?: HTMLInputElement): boolean {
  if (chapters.value.length < 64) return true
  error.value = copy.value.selectionLimit
  if (input) input.checked = false
  return false
}
function toggleCandidate(candidate: ProjectExportCandidate, checked: boolean, input?: HTMLInputElement) {
  if (checked && !selected(candidate.relative) && canAddChapter(input)) chapters.value.push({ key: candidate.relative, relativePath: candidate.relative, title: candidate.name.replace(/\.[^.]+$/, ''), level: 1 })
  else if (!checked) chapters.value = chapters.value.filter(item => item.key !== candidate.relative)
}
function toggleUntitled(tab: typeof editor.tabs[number], checked: boolean, input?: HTMLInputElement) {
  const key = `tab:${tab.id}`
  if (checked && !selected(key) && canAddChapter(input)) chapters.value.push({ key, tabId: tab.id, title: tab.filename.replace(/\.[^.]+$/, ''), level: 1 })
  else if (!checked) chapters.value = chapters.value.filter(item => item.key !== key)
}
function selectFiltered() {
  const selectedKeys = new Set(chapters.value.map(chapter => chapter.key))
  const additions = filteredCandidates.value.filter(candidate => !selectedKeys.has(candidate.relative))
  const remaining = Math.max(0, 64 - chapters.value.length)
  chapters.value = [...chapters.value, ...additions.slice(0, remaining).map(candidate => ({
    key: candidate.relative, relativePath: candidate.relative, title: candidate.name.replace(/\.[^.]+$/, ''), level: 1,
  }))]
  if (additions.length > remaining) error.value = copy.value.selectionLimit
}
function move(index: number, delta: number) {
  const reordered = [...chapters.value]
  const [chapter] = reordered.splice(index, 1)
  reordered.splice(index + delta, 0, chapter)
  chapters.value = reordered
}
function selectProfile() {
  profile.value = resolveExportProfile({ projectConfig: config.value.config, selectedProfileId: profile.value.id }).profile
  formats.value = formats.value.filter(format => profile.value.formats.includes(format))
}
function selectTheme() {
  const previous = profile.value
  profile.value = { ...clone(BUILTIN_PROFILES[previous.theme]), id: previous.id, name: previous.name, output: clone(previous.output) }
}
function applyPlan(plan: ProjectExportPlan | null) {
  if (!plan) {
    chapters.value = []
    mode.value = 'batch'; formats.value = ['html']; title.value = root.value.split(/[\\/]/).filter(Boolean).pop() || 'Project'; bookFileName.value = 'book'; overwrite.value = false
    profile.value = resolveExportProfile({ projectConfig: config.value.config }).profile
    return
  }
  mode.value = plan.mode; formats.value = [...plan.formats]; title.value = plan.title; bookFileName.value = plan.bookFileName; overwrite.value = plan.overwrite
  profile.value = resolveExportProfile({ projectConfig: config.value.config, selectedProfileId: plan.profileId }).profile
  chapters.value = plan.chapters.map(item => ({ key: item.path, relativePath: item.path, title: item.title, level: item.level }))
}
async function load(reloadPlan = true) {
  if (!root.value) { error.value = copy.value.noProject; return }
  const generation = ++loadGeneration
  const projectRoot = root.value
  loading.value = true; error.value = ''; notice.value = ''
  try {
    const [files, loaded] = await Promise.all([exportProjectList(projectRoot), loadProjectExportPlan(projectRoot)])
    if (generation !== loadGeneration || projectRoot !== root.value) return
    candidates.value = files
    config.value = loaded.snapshot
    configReady.value = true
    if (reloadPlan) applyPlan(loaded.plan)
  } catch (cause) {
    if (generation === loadGeneration) { configReady.value = false; error.value = displayError(cause, copy.value.configFailed) }
  } finally { if (generation === loadGeneration) loading.value = false }
}
async function open() {
  if (visible.value) return
  controller.invalidate(); visible.value = true; filter.value = ''; error.value = ''; notice.value = ''
  configReady.value = false; candidates.value = []; chapters.value = []; config.value = { config: null, fingerprint: null }
  await load()
}
async function review() {
  error.value = ''; notice.value = ''; previewReady.value = false; acknowledged.value = false
  try {
    await controller.prepare({ root: root.value, chapters: clone(chapters.value), mode: mode.value, title: title.value,
      bookFileName: bookFileName.value, formats: [...formats.value], profile: clone(profile.value), overwrite: overwrite.value,
      language: locale.value, muya: editor.getMuyaInstance() })
  } catch (cause) { error.value = displayError(cause, copy.value.taskFailed) }
}
async function run(retry = false) {
  if (retry ? !canRetry.value : !canRun.value) return
  error.value = ''
  try { if (retry) await controller.retryFailed(); else await controller.run() }
  catch (cause) { error.value = displayError(cause, copy.value.taskFailed) }
}
async function savePlan() {
  if (!configReady.value || locked.value || !root.value) return
  const projectRoot = root.value
  const generation = loadGeneration
  const plan: ProjectExportPlan = { schemaVersion: 1, mode: mode.value, title: title.value,
    chapters: persistentProjectChapters(chapters.value), formats: [...formats.value], profileId: profile.value.id,
    bookFileName: bookFileName.value, overwrite: overwrite.value }
  saving.value = true; error.value = ''; notice.value = ''
  try {
    const saved = await saveProjectExportPlan(projectRoot, plan, clone(profile.value), clone(config.value))
    if (projectRoot === root.value && generation === loadGeneration) { config.value = saved; notice.value = copy.value.saved }
  } catch (cause) { if (generation === loadGeneration) error.value = displayError(cause, copy.value.configFailed) }
  finally { saving.value = false }
}
function close() { loadGeneration++; loading.value = false; void controller.cancel() }
onMounted(() => { unsubscribe = bus.on('show-project-export-dialog', () => { void open() }) })
onBeforeUnmount(() => { loadGeneration++; unsubscribe?.(); controller.dispose() })
</script>

<template>
  <el-dialog v-model="visible" :title="copy.title" width="min(1320px, 96vw)" top="2vh" append-to-body :close-on-click-modal="false"
    :show-close="!busy" :close-on-press-escape="!busy" class="project-export-dialog" @close="close">
    <div data-testid="project-export-dialog" class="project-export">
      <div class="project-messages">
      <p v-if="!root" class="project-banner" role="alert">{{ copy.noProject }}</p>
      <p v-if="loading" class="project-banner" role="status">{{ copy.loading }}</p>
      <p v-if="error || state.error" class="project-banner error" role="alert">{{ error || displayError(state.error, copy.taskFailed) }}</p>
      <p v-if="notice" class="project-banner notice" role="status">{{ notice }}</p>
      </div>
      <aside class="project-options">
      <div class="project-summary"><Layers :size="20" aria-hidden="true" /><div><strong>{{ copy.title }}</strong><small>{{ root || copy.noProject }}</small></div></div>
      <fieldset :disabled="locked || !root" class="settings">
        <label>{{ copy.mode }}<select v-model="mode" data-testid="project-export-mode"><option value="batch">{{ copy.batch }}</option><option value="book">{{ copy.book }}</option></select></label>
        <label>{{ copy.profile }}<select v-model="profile.id" data-testid="project-export-profile" @change="selectProfile"><option v-for="item in profileChoices" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
        <label>{{ copy.theme }}<select v-model="profile.theme" @change="selectTheme"><option v-for="item in themeChoices" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
        <label>{{ copy.directory }}<input v-model="profile.output.directory" data-testid="project-export-directory"></label>
        <label v-if="mode === 'batch'">{{ copy.fileName }}<input v-model="profile.output.fileName" data-testid="project-export-filename"></label>
        <label v-if="mode === 'book'">{{ copy.bookTitle }}<input v-model="title" maxlength="200" data-testid="project-export-book-title"></label>
        <label v-if="mode === 'book'">{{ copy.fileName }}<input v-model="bookFileName" maxlength="120" data-testid="project-export-book-filename"></label>
        <div class="formats" data-testid="project-export-formats"><span>{{ copy.formats }}</span><label v-for="format in (['html', 'pdf', 'docx', 'odt', 'epub'] as const)" :key="format"><input v-model="formats" type="checkbox" :value="format" :disabled="!profile.formats.includes(format)">{{ format.toUpperCase() }}</label></div>
        <label class="overwrite"><input v-model="overwrite" type="checkbox" data-testid="project-export-overwrite">{{ copy.overwrite }}</label>
        <p class="hint">{{ mode === 'batch' ? copy.fileNameHelp : copy.pdfHelp }}<span v-if="mode === 'batch' && formats.includes('pdf')"> {{ copy.pdfHelp }}</span></p>
      </fieldset>
      <div class="actions plan-actions"><button data-testid="project-export-save" :disabled="locked || !root || !configReady" @click="savePlan"><Bookmark :size="13" aria-hidden="true" />{{ copy.save }}</button><button :disabled="locked || !root" @click="load()"><RefreshCw :size="13" aria-hidden="true" />{{ copy.reload }}</button><span class="hint">{{ copy.saveHelp }}</span></div>
      </aside>
      <main class="project-content">
      <div class="selection-layout">
        <section :aria-label="copy.candidates" class="candidates">
          <h3>{{ copy.candidates }}<span class="section-count">{{ filteredCandidates.length }}</span></h3>
          <label class="filter-label">{{ copy.filter }}<input v-model="filter" type="search" :disabled="locked" data-testid="project-export-filter"></label>
          <div class="actions"><button :disabled="locked || !root" @click="load(false)">{{ copy.refresh }}</button><button :disabled="locked" @click="selectFiltered">{{ copy.selectAll }}</button></div>
          <div class="candidate-list">
            <label v-for="candidate in filteredCandidates" :key="candidate.relative" data-testid="project-export-candidate" :class="{ 'candidate-selected': selected(candidate.relative) }"><input type="checkbox" :checked="selected(candidate.relative)" :disabled="locked" :aria-label="`${copy.select}: ${candidate.relative}`" @change="toggleCandidate(candidate, ($event.target as HTMLInputElement).checked, $event.target as HTMLInputElement)"><span>{{ candidate.relative }}</span></label>
            <label v-for="tab in untitledTabs" :key="tab.id" data-testid="project-export-untitled"><input type="checkbox" :checked="selected(`tab:${tab.id}`)" :disabled="locked" :aria-label="`${copy.select}: ${tab.filename}`" @change="toggleUntitled(tab, ($event.target as HTMLInputElement).checked, $event.target as HTMLInputElement)"><span>{{ tab.filename }}<small>{{ copy.untitled }}</small></span></label>
          </div>
        </section>
        <section :aria-label="copy.selected" class="chapters">
          <div class="section-heading"><h3>{{ copy.selected }} ({{ chapters.length }}/64)</h3><button :disabled="locked" @click="chapters = []">{{ copy.clear }}</button></div>
          <div v-if="!chapters.length" class="chapter-empty"><FileText :size="28" aria-hidden="true" /><p>{{ copy.empty }}</p></div>
          <ol>
            <li v-for="(chapter, index) in chapters" :key="chapter.key" data-testid="project-export-chapter">
              <div class="chapter-identity"><span class="chapter-number">{{ String(index + 1).padStart(2, '0') }}</span><span class="chapter-path">{{ chapter.relativePath || copy.untitled }}</span><small v-if="chapter.relativePath && !candidates.some(item => item.relative === chapter.relativePath)" class="error">{{ copy.missing }}</small></div>
              <div class="chapter-controls"><label>{{ copy.chapterTitle }}<input v-model="chapter.title" :disabled="locked" maxlength="200"></label><label>{{ copy.level }}<input v-model.number="chapter.level" :disabled="locked || mode === 'batch'" type="number" min="1" max="5"></label></div>
              <div class="actions"><button :disabled="locked || index === 0" :aria-label="`${copy.up}: ${chapter.title}`" @click="move(index, -1)">↑</button><button :disabled="locked || index === chapters.length - 1" :aria-label="`${copy.down}: ${chapter.title}`" @click="move(index, 1)">↓</button><button :disabled="locked" :aria-label="`${copy.remove}: ${chapter.title}`" @click="chapters.splice(index, 1)">{{ copy.remove }}</button></div>
            </li>
          </ol>
        </section>
      </div>
      <p v-if="state.stage === 'stale'" class="stale-status" role="status">{{ copy.stale }}</p>
      <section v-if="state.snapshot" class="review" :aria-label="copy.snapshots">
        <details class="snapshot-details">
        <summary>{{ copy.snapshots }}</summary><p>{{ copy.reviewHelp }}</p><small>{{ state.snapshot.capturedAt }} · {{ state.snapshot.revision }}</small>
        <ul><li v-for="source in state.snapshot.sources" :key="source.sourceId">{{ source.relativePath || source.snapshot.fileName }} · {{ source.origin === 'disk' ? copy.disk : copy.buffer }} · <code>{{ source.revision.slice(0, 12) }}</code></li></ul>
        </details>
        <ExportPreview v-if="state.previewHtml" :html="state.previewHtml" :stale="state.stage === 'stale'" :title="copy.title" :loading-message="copy.busy" :empty-message="copy.empty" :stale-message="copy.stale" :failed-message="copy.taskFailed" :timeout-message="copy.taskFailed" @ready="previewReady = true" @failed="error = $event" />
      </section>
      <section v-if="state.blocking.length" class="diagnostic-section blocking-section" role="alert"><h3>{{ copy.errors }}</h3><ul><li v-for="(issue, index) in state.blocking" :key="index">{{ projectExportDiagnostic(locale, issue.code, issue.message) }} <code>{{ issue.code }}</code><small v-if="issue.resource">{{ issue.resource }}</small></li></ul></section>
      <section v-if="state.warnings.length" class="diagnostic-section warnings-section"><h3>{{ copy.warnings }}</h3><ul><li v-for="(issue, index) in state.warnings" :key="index">{{ projectExportDiagnostic(locale, issue.code, issue.message) }} <code>{{ issue.code }}</code><small v-if="issue.resource">{{ issue.resource }}</small></li></ul><label class="acknowledge"><input v-model="acknowledged" type="checkbox" data-testid="project-export-acknowledge" :disabled="busy">{{ copy.acknowledge }}</label></section>
      <section v-if="state.items.length" class="output-results" data-testid="project-export-output-preview">
<h3>{{ state.stage === 'ready' ? copy.outputs : copy.results }}</h3>
        <p role="status" aria-live="polite">{{ busy ? copy.busy : copy.results }} · {{ completed }} / {{ state.items.length }}</p>
        <div class="table-scroll"><table><thead><tr><th>{{ copy.output }}</th><th>{{ copy.status }}</th><th>{{ copy.error }}</th></tr></thead><tbody><tr v-for="item in state.items" :key="item.id" data-testid="project-export-result"><td>{{ item.outputPath || item.name }}</td><td>{{ item.status === 'rendering' || item.status === 'writing' ? copy.running : copy[item.status] }}</td><td>{{ item.error ? projectExportDiagnostic(locale, item.error) : '' }}</td></tr></tbody></table></div>
      </section>
      </main>
    </div>
    <template #footer>
<div class="project-export-footer">
      <span v-if="state.items.length" class="footer-status" role="status">{{ copy.results }} · {{ completed }} / {{ state.items.length }}</span>
      <span v-else class="footer-status">{{ copy.selected }} · {{ chapters.length }} / 64</span>
<div class="actions footer-actions">
      <button data-testid="project-export-review" :disabled="locked || !root || !chapters.length || chapters.length > 64 || !formats.length" @click="review"><LockKeyhole :size="14" aria-hidden="true" />{{ copy.review }}</button>
      <button data-testid="project-export-run" class="primary" :disabled="!canRun" @click="run()">{{ copy.run }}<ArrowUpRight :size="14" aria-hidden="true" /></button>
      <button v-if="canRetry" data-testid="project-export-retry" @click="run(true)">{{ copy.retry }}</button>
      <button v-if="busy" data-testid="project-export-cancel" @click="controller.cancel()">{{ copy.cancel }}</button>
      <button v-else :disabled="saving" @click="visible = false">{{ copy.close }}</button>
    </div>
    </div>
</template>
  </el-dialog>
</template>

<style scoped>
:global(.project-export-dialog.el-dialog) { height: min(96dvh, 1000px); max-height: 96dvh; padding: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--mt-border); border-radius: 12px; background: var(--mt-bg); }
:global(.project-export-dialog .el-dialog__header) { flex-shrink: 0; margin: 0; padding: 19px 24px 16px; border-bottom: 1px solid var(--mt-border); }
:global(.project-export-dialog .el-dialog__title) { color: var(--mt-fg); font-size: 16px; font-weight: 600; }
:global(.project-export-dialog .el-dialog__headerbtn) { top: 11px; right: 10px; }
:global(.project-export-dialog .el-dialog__body) { flex: 1; min-height: 0; padding: 0; overflow: hidden; }
:global(.project-export-dialog .el-dialog__footer) { flex-shrink: 0; padding: 14px 22px; border-top: 1px solid var(--mt-border); background: var(--mt-bg); }
.project-export { height: 100%; min-height: 0; display: grid; grid-template-columns: 275px minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); overflow: hidden; color: var(--mt-fg); font: 12px/1.6 var(--mt-ui-font); }
.project-messages { grid-column: 1 / -1; max-height: min(20dvh, 140px); overflow: auto; }
.project-export h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 15px; font-size: 12px; font-weight: 500; }
.project-banner { grid-column: 1 / -1; margin: 0; padding: 10px 22px; background: var(--mt-surface); color: var(--mt-fg-muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.project-banner.error { background: var(--mt-error-soft); }
.project-banner.notice { background: var(--mt-accent-soft); color: var(--mt-accent); }
.project-options { grid-row: 2; min-height: 0; padding: 23px 20px; border-right: 1px solid var(--mt-border); overflow: auto; scrollbar-width: thin; }
.project-content { grid-row: 2; min-height: 0; padding: 22px; background: var(--mt-surface); overflow: auto; scrollbar-width: thin; }
.project-summary { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 24px; }
.project-summary > svg { flex-shrink: 0; margin-top: 2px; color: var(--mt-accent); }
.project-summary > div { min-width: 0; }
.project-summary strong { display: block; font-weight: 500; font-size: 13px; margin-bottom: 5px; }
.project-summary small { font-size: 11px; line-height: 1.6; }
.settings { display: grid; grid-template-columns: minmax(0, 1fr); gap: 17px; margin: 0; padding: 0; border: 0; min-width: 0; }
.settings > label, .filter-label, .chapter-controls label { display: flex; flex-direction: column; gap: 7px; color: var(--mt-fg-muted); font-size: 11px; }
input:not([type=checkbox]), select { box-sizing: border-box; min-width: 0; width: 100%; padding: 8px 10px; color: var(--mt-fg); font: inherit; background: var(--mt-surface-raised); border: 1px solid var(--mt-border); border-radius: 6px; }
input[type=checkbox] { accent-color: var(--mt-accent); width: 14px; height: 14px; margin: 2px 0 0; flex-shrink: 0; }
button { display: inline-flex; justify-content: center; align-items: center; gap: 6px; padding: 7px 10px; color: var(--mt-fg); font: inherit; background: var(--mt-surface-raised); border: 1px solid var(--mt-border); border-radius: 6px; cursor: pointer; }
button:hover:not(:disabled) { background: var(--mt-row-hover); }
button:disabled, fieldset:disabled { opacity: .5; cursor: default; }
fieldset:disabled input, fieldset:disabled select { cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 2px; }
.primary { color: var(--mt-text-on-accent); background: var(--mt-accent); border-color: var(--mt-accent); }
.primary:hover:not(:disabled) { background: var(--mt-accent); filter: brightness(1.08); }
.formats { display: flex; flex-wrap: wrap; gap: 9px 12px; align-items: center; }
.formats > span { flex-basis: 100%; color: var(--mt-fg-muted); font-size: 11px; }
.formats label { display: flex; gap: 5px; align-items: center; }
.settings > .overwrite { flex-direction: row; gap: 7px; align-items: center; color: var(--mt-fg); }
.hint { color: var(--mt-fg-muted); font-size: 11px; line-height: 1.7; margin: 0; }
.selection-layout { display: grid; grid-template-columns: minmax(190px, .8fr) minmax(0, 1.2fr); gap: 20px; }
.candidates, .chapters { min-width: 0; }
.section-count { margin-left: auto; color: var(--mt-fg-muted); font-size: 11px; }
.candidate-list { max-height: 440px; overflow: auto; padding: 9px 0; margin-top: 7px; scrollbar-width: thin; }
.candidate-list > label { display: flex; align-items: flex-start; gap: 8px; padding: 10px 8px; overflow-wrap: anywhere; border-radius: 6px; cursor: pointer; margin-bottom: 3px; }
.candidate-list > label:hover { background: var(--mt-row-hover); }
.candidate-list .candidate-selected { background: var(--mt-accent-soft); color: var(--mt-accent); }
small { display: block; color: var(--mt-fg-muted); overflow-wrap: anywhere; }
.chapters ol { max-height: 540px; overflow: auto; padding: 0; margin: 0; list-style: none; scrollbar-width: thin; }
.chapters li { padding: 14px; border: 1px solid var(--mt-border); border-radius: 8px; background: var(--mt-bg); margin-bottom: 10px; }
.chapter-identity { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.chapter-number { flex-shrink: 0; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--mt-accent); }
.chapter-path { min-width: 0; flex: 1; font-size: 11px; color: var(--mt-fg-muted); overflow-wrap: anywhere; }
.chapter-controls { display: grid; grid-template-columns: minmax(0, 1fr) 78px; gap: 10px; margin: 12px 0; }
.chapter-empty { min-height: 245px; padding: 25px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: var(--mt-fg-muted); border: 1px dashed var(--mt-border); border-radius: 8px; }
.chapter-empty svg { color: var(--mt-accent); opacity: .5; stroke-width: 1.3; }
.actions { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; margin-top: 8px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 15px; }
.section-heading h3 { margin: 0; }
.section-heading > button { border: 0; background: transparent; color: var(--mt-fg-muted); padding: 0 3px; font-size: 11px; }
.plan-actions { margin-top: 22px; padding-top: 17px; border-top: 1px solid var(--mt-border); }
.plan-actions .hint { flex-basis: 100%; margin-top: 7px; }
.plan-actions button { font-size: 11px; }
.project-export-footer { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.footer-status { color: var(--mt-fg-muted); font-size: 11px; text-align: left; }
.footer-actions { justify-content: flex-end; margin-top: 0; }
.footer-actions button { font-size: 12px; }
.error { color: var(--mt-error); }
.stale-status { padding: 11px 13px; color: var(--mt-warning); background: var(--mt-warning-soft); border-radius: 7px; }
.table-scroll { overflow-x: auto; border: 1px solid var(--mt-border); border-radius: 7px; background: var(--mt-bg); }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 11px; }
td, th { padding: 11px 12px; text-align: left; border-bottom: 1px solid var(--mt-border); overflow-wrap: anywhere; }
th { background: var(--mt-surface); color: var(--mt-fg-muted); font-weight: 500; }
th:first-child { width: 48%; }
th:nth-child(2) { width: 18%; }
tbody tr:last-child td { border-bottom: 0; }
.review, .output-results { margin-top: 22px; }
.snapshot-details { padding: 12px 14px; border: 1px solid var(--mt-border); border-radius: 7px; background: var(--mt-bg); margin-bottom: 16px; font-size: 11px; }
.snapshot-details summary { font-size: 12px; cursor: pointer; color: var(--mt-accent); }
.snapshot-details li, .snapshot-details small { overflow-wrap: anywhere; line-height: 1.8; }
.snapshot-details p { color: var(--mt-fg-muted); }
.review :deep(.preview-shell) { height: 440px; }
.diagnostic-section { padding: 14px 16px; margin-top: 15px; border-radius: 8px; line-height: 1.7; font-size: 12px; }
.diagnostic-section h3 { margin-bottom: 8px; }
.diagnostic-section ul { padding-left: 18px; margin: 0 0 10px; }
.diagnostic-section li { overflow-wrap: anywhere; margin-bottom: 6px; }
.blocking-section { background: var(--mt-error-soft); color: var(--mt-error); }
.warnings-section { background: var(--mt-warning-soft); color: var(--mt-warning); }
.acknowledge { display: flex; gap: 8px; align-items: flex-start; }
.output-results > p { color: var(--mt-fg-muted); font-size: 11px; }
@media (max-width: 1080px) { .project-export { grid-template-columns: 250px minmax(0, 1fr); } .selection-layout { grid-template-columns: minmax(0, 1fr); } .candidate-list { max-height: 220px; } .chapters ol { max-height: 430px; } }
@media (max-width: 720px) { .project-export { display: block; overflow: auto; } .project-options { border-right: 0; border-bottom: 1px solid var(--mt-border); padding: 20px; overflow: visible; } .settings { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 15px; } .formats, .settings .overwrite, .settings .hint { grid-column: 1 / -1; } .project-content { overflow: visible; padding: 20px; } .project-export-footer { flex-wrap: wrap; gap: 9px; } .footer-actions { margin-left: auto; } .project-summary { margin-bottom: 20px; } }
@media (max-width: 440px) { .settings { grid-template-columns: minmax(0, 1fr); } .chapter-controls { grid-template-columns: minmax(0, 1fr) 70px; } :global(.project-export-dialog .el-dialog__footer) { padding: 12px 15px; } .footer-actions { gap: 6px; } .footer-actions button { padding: 6px 8px; } }
</style>
