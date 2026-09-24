// Produce the versionless release asset name `dsh-cache-badge.tgz` from the
// versioned `pnpm pack` output, so a download link stays stable across versions.
import { copyFileSync, rmSync, readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const src = `${pkg.name}-${pkg.version}.tgz`
const dst = `${pkg.name}.tgz`

copyFileSync(src, dst)
rmSync(src)
console.log(`packed ${dst} (v${pkg.version})`)
