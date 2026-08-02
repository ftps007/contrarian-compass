/**
 * Test runner. Bundles every tests/*.test.ts through esbuild — so the suite
 * exercises the same TypeScript the app ships — and runs it in Node with a DOM
 * shim installed.
 *
 *   npm test
 *   npm test -- image           # only files whose name contains "image"
 */

import { build } from 'esbuild'
import { readdir, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '.build')
const filter = process.argv[2]

const files = (await readdir(here))
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => !filter || f.includes(filter))
  .sort()

if (files.length === 0) {
  console.error(filter ? `Kein Test passt auf "${filter}".` : 'Keine Tests gefunden.')
  process.exit(1)
}

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await build({
  entryPoints: files.map((f) => join(here, f)),
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['@xmldom/xmldom'],
  logLevel: 'warning',
})

await import('./dom-shim.mjs')

let passed = 0
let failed = 0
const failures = []

globalThis.__test = async (name, fn) => {
  try {
    await fn()
    passed++
    process.stdout.write('.')
  } catch (err) {
    failed++
    failures.push({ name, err })
    process.stdout.write('F')
  }
}

for (const file of files) {
  const bundled = join(outDir, file.replace(/\.ts$/, '.js'))
  process.stdout.write(`\n${file.replace('.test.ts', '')} `)
  await import(pathToFileURL(bundled).href)
}

console.log('\n')
for (const { name, err } of failures) {
  console.log(`FEHLGESCHLAGEN: ${name}`)
  console.log(`  ${err?.message ?? err}`)
  if (err?.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'))
  console.log()
}

console.log(`${passed} bestanden, ${failed} fehlgeschlagen`)
process.exit(failed > 0 ? 1 : 0)
