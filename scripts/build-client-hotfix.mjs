/** Rebuild only the browser half; the uploaded host artifact stays byte-for-byte unchanged. */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const ts = process.env.TYPESCRIPT_PATH ? require(process.env.TYPESCRIPT_PATH) : require('typescript')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = resolve(root, 'src/client/index.tsx')
const modules = new Map()
const declarations = new Map()
const external = new Set()
function visit(path) {
  const id = relative(root, path).replaceAll('\\', '/')
  if (modules.has(id)) return id
  modules.set(id, '')
  const source = readFileSync(path, 'utf8')
  const result = ts.transpileModule(source, {
    fileName: path, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  })
  const errors = (result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error)
  if (errors.length) throw Error(ts.formatDiagnosticsWithColorAndContext(errors, {getCanonicalFileName:s=>s, getCurrentDirectory:()=>root, getNewLine:()=> '\n'}))
  const output = result.outputText.replace(/require\("([^"\n]+)"\)/g, (_, specifier) => {
    if (!specifier.startsWith('.')) {
      if (!['react', 'react/jsx-runtime'].includes(specifier)) throw Error('Unexpected client external: ' + specifier)
      external.add(specifier)
      return `external(${JSON.stringify(specifier)})`
    }
    const base = resolve(dirname(path), specifier)
    const target = [base+'.ts', base+'.tsx', base+'/index.ts', base+'/index.tsx'].find(existsSync)
    if (!target) throw Error('Unresolved import: ' + base)
    return `load(${JSON.stringify(visit(target))})`
  })
  modules.set(id, output)
  if (ts.transpileDeclaration) {
    const declaration = ts.transpileDeclaration(source, {fileName:path, compilerOptions:{target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX}})
    const dpath = resolve(root, 'lib/types', relative(resolve(root,'src'),path).replace(/\.tsx?$/, '.d.ts'))
    declarations.set(dpath, declaration.outputText)
  }
  return id
}
const entryId = visit(entry)
// Extra pure-module entry points are available only to tests, not the shipped loader exports.
const table = [...modules].map(([id,body]) => `${JSON.stringify(id)}: (module, exports, load, external) => {\n${body}\n}`).join(',\n')
const body = `const factories={${table}};const cache=Object.create(null);function load(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;factories[id](m,m.exports,load,external);return m.exports;}`
mkdirSync(resolve(root,'lib'), {recursive:true})
writeFileSync(resolve(root,'lib/client.js'), `/* dsh-cache-badge 1.7.1-clickfix.1; browser-only hotfix */\nwindow.__ModuleLoader__.load({id:"dsh-cache-badge",factory:(external)=>{${body}return load(${JSON.stringify(entryId)});}});\n`)
if (process.env.DSH_TEST_BUNDLE) writeFileSync(process.env.DSH_TEST_BUNDLE, `window.__brickModules=((external)=>{${body}return load;})(id=>window.__testExternals[id]);\n`)
for (const [path, data] of declarations) { mkdirSync(dirname(path), {recursive:true}); writeFileSync(path,data) }
console.log(`Built browser bundle: ${modules.size} local modules; externals: ${[...external].join(', ')}. Host artifact was not rebuilt.`)
