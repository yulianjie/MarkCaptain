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
  <el-dialog v-model="visible" :title="copy.title" width="94vw" top="3vh" append-to-body :close-on-click-modal="false"
    :show-close="!busy" :close-on-press-escape="!busy" class="project-export-dialog" @close="close">
    <div data-testid="project-export-dialog" class="project-export">
      <p v-if="!root" role="alert">{{ copy.noProject }}</p>
      <p v-if="loading" role="status">{{ copy.loading }}</p>
      <p v-if="error || state.error" class="error" role="alert">{{ error || displayError(state.error, copy.taskFailed) }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
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
      <div class="selection-layout">
        <section :aria-label="copy.candidates" class="candidates">
          <h3>{{ copy.candidates }}</h3>
          <label class="filter-label">{{ copy.filter }}<input v-model="filter" type="search" :disabled="locked" data-testid="project-export-filter"></label>
          <div class="actions"><button :disabled="locked || !root" @click="load(false)">{{ copy.refresh }}</button><button :disabled="locked" @click="selectFiltered">{{ copy.selectAll }}</button></div>
          <div class="candidate-list">
            <label v-for="candidate in filteredCandidates" :key="candidate.relative" data-testid="project-export-candidate"><input type="checkbox" :checked="selected(candidate.relative)" :disabled="locked" :aria-label="`${copy.select}: ${candidate.relative}`" @change="toggleCandidate(candidate, ($event.target as HTMLInputElement).checked, $event.target as HTMLInputElement)"><span>{{ candidate.relative }}</span></label>
            <label v-for="tab in untitledTabs" :key="tab.id" data-testid="project-export-untitled"><input type="checkbox" :checked="selected(`tab:${tab.id}`)" :disabled="locked" :aria-label="`${copy.select}: ${tab.filename}`" @change="toggleUntitled(tab, ($event.target as HTMLInputElement).checked, $event.target as HTMLInputElement)"><span>{{ tab.filename }}<small>{{ copy.untitled }}</small></span></label>
          </div>
        </section>
        <section :aria-label="copy.selected" class="chapters">
          <div class="section-heading"><h3>{{ copy.selected }} ({{ chapters.length }}/64)</h3><button :disabled="locked" @click="chapters = []">{{ copy.clear }}</button></div>
          <p v-if="!chapters.length">{{ copy.empty }}</p>
          <ol>
            <li v-for="(chapter, index) in chapters" :key="chapter.key" data-testid="project-export-chapter">
              <div><span class="chapter-path">{{ chapter.relativePath || copy.untitled }}</span><small v-if="chapter.relativePath && !candidates.some(item => item.relative === chapter.relativePath)" class="error">{{ copy.missing }}</small></div>
              <div class="chapter-controls"><label>{{ copy.chapterTitle }}<input v-model="chapter.title" :disabled="locked" maxlength="200"></label><label>{{ copy.level }}<input v-model.number="chapter.level" :disabled="locked || mode === 'batch'" type="number" min="1" max="5"></label></div>
              <div class="actions"><button :disabled="locked || index === 0" :aria-label="`${copy.up}: ${chapter.title}`" @click="move(index, -1)">↑</button><button :disabled="locked || index === chapters.length - 1" :aria-label="`${copy.down}: ${chapter.title}`" @click="move(index, 1)">↓</button><button :disabled="locked" :aria-label="`${copy.remove}: ${chapter.title}`" @click="chapters.splice(index, 1)">{{ copy.remove }}</button></div>
            </li>
          </ol>
        </section>
      </div>
      <div class="actions plan-actions"><button data-testid="project-export-save" :disabled="locked || !root || !configReady" @click="savePlan">{{ copy.save }}</button><button :disabled="locked || !root" @click="load()">{{ copy.reload }}</button><span class="hint">{{ copy.saveHelp }}</span></div>
      <p v-if="state.stage === 'stale'" role="status">{{ copy.stale }}</p>
      <section v-if="state.snapshot" class="review" :aria-label="copy.snapshots">
        <h3>{{ copy.snapshots }}</h3><p>{{ copy.reviewHelp }}</p><small>{{ state.snapshot.capturedAt }} · {{ state.snapshot.revision }}</small>
        <ul><li v-for="source in state.snapshot.sources" :key="source.sourceId">{{ source.relativePath || source.snapshot.fileName }} · {{ source.origin === 'disk' ? copy.disk : copy.buffer }} · <code>{{ source.revision.slice(0, 12) }}</code></li></ul>
        <ExportPreview v-if="state.previewHtml" :html="state.previewHtml" :stale="state.stage === 'stale'" :title="copy.title" :loading-message="copy.busy" :empty-message="copy.empty" :stale-message="copy.stale" :failed-message="copy.taskFailed" :timeout-message="copy.taskFailed" @ready="previewReady = true" @failed="error = $event" />
      </section>
      <section v-if="state.blocking.length" role="alert"><h3>{{ copy.errors }}</h3><ul><li v-for="(issue, index) in state.blocking" :key="index">{{ projectExportDiagnostic(locale, issue.code, issue.message) }} <code>{{ issue.code }}</code><small v-if="issue.resource">{{ issue.resource }}</small></li></ul></section>
      <section v-if="state.warnings.length"><h3>{{ copy.warnings }}</h3><ul><li v-for="(issue, index) in state.warnings" :key="index">{{ projectExportDiagnostic(locale, issue.code, issue.message) }} <code>{{ issue.code }}</code><small v-if="issue.resource">{{ issue.resource }}</small></li></ul><label><input v-model="acknowledged" type="checkbox" data-testid="project-export-acknowledge" :disabled="busy">{{ copy.acknowledge }}</label></section>
      <section v-if="state.items.length" data-testid="project-export-output-preview">
<h3>{{ state.stage === 'ready' ? copy.outputs : copy.results }}</h3>
        <p role="status" aria-live="polite">{{ busy ? copy.busy : copy.results }} · {{ completed }} / {{ state.items.length }}</p>
        <div class="table-scroll"><table><thead><tr><th>{{ copy.output }}</th><th>{{ copy.status }}</th><th>{{ copy.error }}</th></tr></thead><tbody><tr v-for="item in state.items" :key="item.id" data-testid="project-export-result"><td>{{ item.outputPath || item.name }}</td><td>{{ item.status === 'rendering' || item.status === 'writing' ? copy.running : copy[item.status] }}</td><td>{{ item.error ? projectExportDiagnostic(locale, item.error) : '' }}</td></tr></tbody></table></div>
      </section>
    </div>
    <template #footer>
<div class="actions footer-actions">
      <button data-testid="project-export-review" :disabled="locked || !root || !chapters.length || chapters.length > 64 || !formats.length" @click="review">{{ copy.review }}</button>
      <button data-testid="project-export-run" class="primary" :disabled="!canRun" @click="run()">{{ copy.run }}</button>
      <button v-if="canRetry" data-testid="project-export-retry" @click="run(true)">{{ copy.retry }}</button>
      <button v-if="busy" data-testid="project-export-cancel" @click="controller.cancel()">{{ copy.cancel }}</button>
      <button v-else :disabled="saving" @click="visible = false">{{ copy.close }}</button>
    </div>
</template>
  </el-dialog>
</template>

<style scoped>
.project-export { max-height: 73vh; overflow: auto; color: var(--el-text-color-primary); }
.project-export h3 { margin: 12px 0 8px; font-size: 14px; }
.settings { display: grid; grid-template-columns: repeat(3, minmax(160px, 1fr)); gap: 12px; margin: 0; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 6px; }
.settings > label, .filter-label, .chapter-controls label { display: flex; flex-direction: column; gap: 5px; }
input:not([type=checkbox]), select { box-sizing: border-box; min-width: 0; width: 100%; padding: 6px 8px; color: var(--el-text-color-primary); background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: 4px; }
button { padding: 6px 10px; color: var(--el-text-color-primary); background: var(--el-fill-color-blank); border: 1px solid var(--el-border-color); border-radius: 4px; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.primary { color: white; background: var(--el-color-primary); }
.formats { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; grid-column: 1 / -1; }
.settings > .overwrite { flex-direction: row; align-items: center; grid-column: 1 / -1; }
.hint { color: var(--el-text-color-secondary); font-size: 12px; margin: 0; grid-column: 1 / -1; }
.selection-layout { display: grid; grid-template-columns: 1fr 1.2fr; gap: 20px; margin: 12px 0; }
.candidate-list { max-height: 310px; overflow: auto; padding: 8px 0; }
.candidate-list > label { display: flex; align-items: start; gap: 6px; padding: 6px 0; overflow-wrap: anywhere; }
small { display: block; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.chapters ol { max-height: 360px; overflow: auto; padding-left: 28px; }
.chapters li { padding: 8px; border-bottom: 1px solid var(--el-border-color); }
.chapter-path { font-size: 12px; overflow-wrap: anywhere; }
.chapter-controls { display: grid; grid-template-columns: 1fr 100px; gap: 8px; margin: 6px 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; }
.plan-actions { padding: 10px 0; border-bottom: 1px solid var(--el-border-color); }
.footer-actions { justify-content: flex-end; }
.error { color: var(--el-color-danger); }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
td, th { padding: 8px; text-align: left; border-bottom: 1px solid var(--el-border-color); overflow-wrap: anywhere; }
.review { margin-top: 12px; }
@media (max-width: 850px) { .settings { grid-template-columns: 1fr 1fr; } .selection-layout { grid-template-columns: 1fr; } }
</style>
