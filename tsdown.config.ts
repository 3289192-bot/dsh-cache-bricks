import type { UserConfig } from 'tsdown'

const ID = 'dsh-cache-bricks'

/** Module-table entries left external: answered by the loader's require at
 * runtime. Only `react` is actually requested by this bundle (the value
 * import); every `@deepseek-ai/...` import in the source is type-only and is
 * erased, so the built bundle requests nothing beyond the shell's baseline
 * module table. */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-renderer/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-chat/client',
]

/** Purity gate: no @deepseek-ai value import beyond the module table. */
function purityGate(): NonNullable<UserConfig['plugins']>[number] {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      // The host half reads files; the browser half must never reach for a Node builtin.
      if (source.startsWith('node:')) {
        throw new Error(
          `client bundle purity: "${source}" is a Node builtin — the board draws bricks and nothing else`,
        )
      }
      if (!source.startsWith('@deepseek-ai/')) return null
      if (EXTERNALS.includes(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not in the module table (EXTERNALS) — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services',
      )
    },
  }
}

const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  minify: true,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: EXTERNALS,
    alwaysBundle: (id: string) => !EXTERNALS.includes(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  plugins: [purityGate()],
  outputOptions: {
    entryFileNames: 'client.js',
    codeSplitting: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

const libConfig: UserConfig = {
  name: ID,
  entry: ['src/index.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
}

export default [libConfig, clientConfig] satisfies UserConfig[]
