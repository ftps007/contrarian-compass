/** Bundles the CLI into a single file that plain Node can run. */
import { build } from 'esbuild'
import { chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outFile = join(here, 'metadaten-clean.mjs')

await build({
  entryPoints: [join(here, 'index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['@xmldom/xmldom'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
})
await chmod(outFile, 0o755)
console.log(`Geschrieben: ${outFile}`)
