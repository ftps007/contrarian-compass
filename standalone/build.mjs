/**
 * Bundles standalone/app.js (and the shared lib/ code it imports) into a single
 * self-contained HTML file that runs by double-clicking it — no server, no
 * network, no dependencies at runtime.
 *
 *   npm run build:standalone
 */

import { build } from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outFile = join(here, 'Metadaten-Editor.html')

const result = await build({
  entryPoints: [join(here, 'app.js')],
  bundle: true,
  format: 'iife',
  target: 'safari16',
  minify: false,
  write: false,
  legalComments: 'none',
})

const script = result.outputFiles[0].text
const template = await readFile(join(here, 'template.html'), 'utf8')
const marker = '      /* BUNDLE */\n'
if (!template.includes(marker)) throw new Error('Marker /* BUNDLE */ fehlt in template.html')

await mkdir(dirname(outFile), { recursive: true })
// A replacer function is required: the bundle contains "$&" and friends,
// which String.replace would otherwise expand as substitution patterns.
await writeFile(outFile, template.replace(marker, () => script))

console.log(`Geschrieben: ${outFile}`)
