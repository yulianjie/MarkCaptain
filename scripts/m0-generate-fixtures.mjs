#!/usr/bin/env node
// Generate bounded, deterministic M0 Markdown workloads outside test/fixtures.
// Generated corpora go under ignored output/ by default and are never cleaned up.
import { cpus, totalmem } from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const LONG_DOCUMENT_CHARACTERS = 200_000
export const ONE_MIB_BYTES = 1_048_576
export const MAX_PROJECT_FILES = 10_000
export const ALLOWED_WORKLOADS = ['representative', 'long-200k', '1mib', 'project', 'all']

const representativePath = fileURLToPath(new URL('../test/fixtures/m0-representative.md', import.meta.url))

export function renderLongDocument(targetCharacters = LONG_DOCUMENT_CHARACTERS) {
  if (!Number.isSafeInteger(targetCharacters) || targetCharacters < 1) {
    throw new Error('targetCharacters must be a positive safe integer')
  }
  const prefix = '---\ntitle: M0 长文性能夹具\ntags: [m0, long-document]\n---\n\n# 中文长文性能夹具\n\n'
  const pattern = '这是一段固定的中文示例正文，包含 Markdown **强调**、`documentId`、[[相关资料|双链]] 与 Emoji 🧭。\n\n'
  const prefixPoints = Array.from(prefix)
  if (prefixPoints.length > targetCharacters) throw new Error('targetCharacters is too small for the Markdown header')
  const remaining = targetCharacters - prefixPoints.length
  const patternPoints = Array.from(pattern)
  return prefix + pattern.repeat(Math.floor(remaining / patternPoints.length)) + patternPoints.slice(0, remaining % patternPoints.length).join('')
}

export function renderOneMiBMarkdown(targetBytes = ONE_MIB_BYTES) {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 1) {
    throw new Error('targetBytes must be a positive safe integer')
  }
  const header = '---\ntitle: M0 1 MiB Markdown 性能夹具\ntags: [m0, large-file]\n---\n\n# 1 MiB Markdown 性能夹具\n\n'
  const paragraph = '混合字符段落：中文、English、**强调**、`inline code`、[[相关资料|双链]] 与 Emoji 🧭。\n\n'
  const headerBytes = Buffer.byteLength(header, 'utf8')
  const paragraphBytes = Buffer.byteLength(paragraph, 'utf8')
  if (headerBytes > targetBytes) throw new Error('targetBytes is too small for the Markdown header')
  const repeats = Math.floor((targetBytes - headerBytes) / paragraphBytes)
  const body = paragraph.repeat(repeats)
  const remainingAsciiBytes = targetBytes - headerBytes - Buffer.byteLength(body, 'utf8')
  return header + body + 'x'.repeat(remainingAsciiBytes)
}

function projectNote(index, fileCount) {
  const nextIndex = (index + 1) % fileCount
  const group = Math.floor(index / 100)
  const nextGroup = Math.floor(nextIndex / 100)
  const name = `note-${String(index + 1).padStart(5, '0')}.md`
  const nextName = `note-${String(nextIndex + 1).padStart(5, '0')}.md`
  const relativeTarget = group === nextGroup ? nextName : `../group-${String(nextGroup).padStart(3, '0')}/${nextName}`
  return `---\ntitle: M0 笔记 ${index + 1}\naliases: [M0-note-${index + 1}]\ntags: [m0/project, scale]\npriority: ${(index % 5) + 1}\n---\n\n# 笔记 ${index + 1}\n\n这是可重复生成的项目扫描夹具。它引用 [[${relativeTarget.replace(/\.md$/, '')}|下一份笔记]]，并保留一段普通文本供文件读取基线使用。\n\n- [${index % 2 ? 'x' : ' '}] 样例任务 ${index + 1}\n`
}

export async function generateProject(root, fileCount) {
  if (!Number.isSafeInteger(fileCount) || fileCount < 1 || fileCount > MAX_PROJECT_FILES) {
    throw new Error(`fileCount must be between 1 and ${MAX_PROJECT_FILES}`)
  }
  await mkdir(root, { recursive: false })
  let totalBytes = 0
  for (let offset = 0; offset < fileCount; offset += 64) {
    const end = Math.min(offset + 64, fileCount)
    const writes = []
    for (let index = offset; index < end; index += 1) {
      const group = Math.floor(index / 100)
      const directory = path.join(root, `group-${String(group).padStart(3, '0')}`)
      const name = `note-${String(index + 1).padStart(5, '0')}.md`
      const contents = projectNote(index, fileCount)
      totalBytes += Buffer.byteLength(contents, 'utf8')
      writes.push(mkdir(directory, { recursive: true }).then(() => writeFile(path.join(directory, name), contents, 'utf8')))
    }
    await Promise.all(writes)
  }
  return { fileCount, totalBytes }
}

function parseArgs(args) {
  const options = { workload: 'all', files: 1200, out: undefined }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--workload') options.workload = args[++index]
    else if (arg === '--files') options.files = Number(args[++index])
    else if (arg === '--out') options.out = args[++index]
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!ALLOWED_WORKLOADS.includes(options.workload)) {
    throw new Error(`--workload must be one of: ${ALLOWED_WORKLOADS.join(', ')}`)
  }
  if (!Number.isSafeInteger(options.files) || options.files < 1 || options.files > MAX_PROJECT_FILES) {
    throw new Error(`--files must be between 1 and ${MAX_PROJECT_FILES}`)
  }
  return options
}

function usage() {
  return [
    'Usage: node scripts/m0-generate-fixtures.mjs [options]',
    '  --workload representative|long-200k|1mib|project|all  (default: all)',
    '  --files N                                           (project only; 1..10000, default: 1200)',
    '  --out DIR                                           (new output directory; default under output/m0-fixtures)',
    '',
    'The script never deletes an existing directory. Generated content is deterministic.',
  ].join('\n')
}

export async function generateWorkloads({ workload = 'all', files = 1200, out } = {}) {
  if (!ALLOWED_WORKLOADS.includes(workload)) throw new Error(`Unsupported workload: ${workload}`)
  if (!Number.isSafeInteger(files) || files < 1 || files > MAX_PROJECT_FILES) throw new Error(`files must be between 1 and ${MAX_PROJECT_FILES}`)
  const safeTimestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z')
  const outputRoot = path.resolve(out ?? path.join('output', 'm0-fixtures', `run-${safeTimestamp}`))
  await mkdir(path.dirname(outputRoot), { recursive: true })
  await mkdir(outputRoot, { recursive: false })
  const selected = workload === 'all' ? ['representative', 'long-200k', '1mib', 'project'] : [workload]
  const records = []

  for (const name of selected) {
    const target = path.join(outputRoot, name)
    const started = performance.now()
    if (name === 'representative') {
      await mkdir(target, { recursive: false })
      await writeFile(path.join(target, 'm0-representative.md'), await readFile(representativePath))
      await mkdir(path.join(target, 'm0-assets'), { recursive: true })
      await writeFile(path.join(target, 'm0-assets', 'diagram.svg'), await readFile(new URL('../test/fixtures/m0-assets/diagram.svg', import.meta.url)))
      records.push({ workload: name, fileCount: 1, elapsedMs: Math.round(performance.now() - started) })
    } else if (name === 'long-200k') {
      await mkdir(target, { recursive: false })
      const contents = renderLongDocument()
      await writeFile(path.join(target, 'long-200k.md'), contents, 'utf8')
      records.push({ workload: name, fileCount: 1, characters: Array.from(contents).length, bytes: Buffer.byteLength(contents, 'utf8'), elapsedMs: Math.round(performance.now() - started) })
    } else if (name === '1mib') {
      await mkdir(target, { recursive: false })
      const contents = renderOneMiBMarkdown()
      await writeFile(path.join(target, 'markdown-1mib.md'), contents, 'utf8')
      records.push({ workload: name, fileCount: 1, bytes: Buffer.byteLength(contents, 'utf8'), elapsedMs: Math.round(performance.now() - started) })
    } else {
      const result = await generateProject(target, files)
      records.push({ workload: name, ...result, elapsedMs: Math.round(performance.now() - started) })
    }
  }

  const cpu = cpus()[0]
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    outputRoot,
    workloadOptions: { workload, projectFiles: files },
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      osRelease: (await import('node:os')).release(),
      cpuModel: cpu?.model ?? null,
      logicalProcessors: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    records,
    measurementNotes: [
      'elapsedMs measures fixture creation and file writes on this run only',
      'it does not measure MarkCaptain indexing, rendering, editing latency, or export performance',
      'generation does not remove existing paths; the selected output root must be new',
    ],
  }
  await writeFile(path.join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) process.stdout.write(`${usage()}\n`)
    else {
      const manifest = await generateWorkloads(options)
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
    }
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n${usage()}\n`)
    process.exitCode = 1
  }
}
