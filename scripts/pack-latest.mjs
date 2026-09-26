/**
 * Pack the release tarball, and keep a copy under the name the GitHub release uses.
 *
 * Usage: pnpm run pack:latest
 */
import { copyFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const wanted = `dsh-cache-bricks-${String(pkg.version)}.tgz`

const found = readdirSync(root).filter((name) => name === wanted)
if (found.length === 0) {
  console.error(`no ${wanted} in the package root — run \`pnpm pack\` first`)
  process.exit(1)
}
const bytes = statSync(join(root, wanted)).size
copyFileSync(join(root, wanted), join(root, 'dsh-cache-bricks.tgz'))
console.log(`packed ${wanted} and dsh-cache-bricks.tgz (${String(bytes)} bytes, version ${String(pkg.version)})`)
