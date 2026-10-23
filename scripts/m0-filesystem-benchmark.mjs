#!/usr/bin/env node
// Measure deterministic recursive Markdown enumeration and sequential reads.
// This is a filesystem baseline, not a measurement of the app's own indexer.
import { createHash } from 'node:crypto'
import { cpus, release, totalmem } from 'node:os'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

async function listMarkdown(root, current = root, result = []) {
  const entries = await readdir(current, { withFileTypes: true })
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name)
    if (entry.isDirectory()) await listMarkdown(root, fullPath, result)
    else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') result.push(fullPath)
  }
  return result
}

async function measure(root) {
  const enumerateStart = performance.now()
  const files = await listMarkdown(root)
  const enumerateMs = performance.now() - enumerateStart
  const digest = createHash('sha256')
  let bytes = 0
  const readStart = performance.now()
  for (const file of files) {
    const contents = await readFile(file)
    bytes += contents.byteLength
    digest.update(path.relative(root, file).replaceAll(path.sep, '/'))
    digest.update('\0')
    digest.update(contents)
  }
  const readMs = performance.now() - readStart
  return {
    markdownFiles: files.length,
    bytesRead: bytes,
    enumerateMs: Number(enumerateMs.toFixed(3)),
    sequentialReadAndHashMs: Number(readMs.toFixed(3)),
    totalMs: Number((enumerateMs + readMs).toFixed(3)),
    sha256: digest.digest('hex'),
  }
}

function parseArgs(args) {
  const options = { root: undefined, runs: 3, out: undefined }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--runs') options.runs = Number(args[++index])
    else if (arg === '--out') options.out = args[++index]
    else if (!arg.startsWith('-') && !options.root) options.root = arg
    else throw new Error(`Unexpected argument: ${arg}`)
  }
  if (!options.root) throw new Error('Pass a workload directory to scan')
  if (!Number.isSafeInteger(options.runs) || options.runs < 1 || options.runs > 10) throw new Error('--runs must be between 1 and 10')
  return options
}

function usage() {
  return [
    'Usage: node scripts/m0-filesystem-benchmark.mjs <workload-dir> [--runs N] [--out FILE]',
    '  --runs N  complete recursive enumerate + sequential read + SHA-256 pass count (1..10, default: 3)',
    '  --out     JSON receipt path (default: <workload-dir>/m0-filesystem-benchmark.json)',
    '',
    'OS file cache state is uncontrolled. The first pass is not guaranteed to be cold.',
    'Results cover Node filesystem enumeration/read/hash only, not MarkCaptain behavior.',
  ].join('\n')
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(`${usage()}\n`)
    } else {
      const root = path.resolve(options.root)
      if (!(await stat(root)).isDirectory()) throw new Error(`Workload path is not a directory: ${root}`)
      const results = []
      for (let run = 1; run <= options.runs; run += 1) results.push({ run, ...(await measure(root)) })
      const cpu = cpus()[0]
      const receipt = {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        root,
        runtime: {
          node: process.version,
          v8: process.versions.v8,
          platform: process.platform,
          arch: process.arch,
          osRelease: release(),
          cpuModel: cpu?.model ?? null,
          logicalProcessors: cpus().length,
          totalMemoryBytes: totalmem(),
        },
        methodology: 'Recursive directory enumeration followed by sequential readFile and SHA-256 over relative path plus bytes; no OS-cache control; no MarkCaptain parser/indexer is called.',
        results,
      }
      const outputPath = path.resolve(options.out ?? path.join(root, 'm0-filesystem-benchmark.json'))
      await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
    }
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n${usage()}\n`)
    process.exitCode = 1
  }
}
