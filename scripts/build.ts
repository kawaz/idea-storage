/**
 * idea-storage build script
 *
 * Bundles src/index.ts into dist/idea-storage with bun shebang.
 */
import { $ } from 'bun'

const SHEBANG = '#!/usr/bin/env bun\n'
const OUTFILE = 'dist/idea-storage'

await $`mkdir -p dist`

const result = await Bun.build({
  entrypoints: ['src/index.ts'],
  outdir: '.',
  naming: OUTFILE,
  target: 'bun',
})

if (!result.success) {
  console.error('Build failed:')
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// Prepend shebang
const content = await Bun.file(OUTFILE).arrayBuffer()
await Bun.write(OUTFILE, new Blob([SHEBANG, content]))

// Make executable
await $`chmod +x ${OUTFILE}`

console.log(`Done: ${OUTFILE}`)
