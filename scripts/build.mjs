import { build } from 'esbuild'
import { mkdir, rm, writeFile } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })
await build({ entryPoints: ['src/host/index.ts'], outdir: 'dist/host', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', sourcemap: true })
const client = await build({ entryPoints: ['src/client/index.tsx'], bundle: true, packages: 'external', platform: 'browser', format: 'cjs', target: 'es2022', write: false })
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:"dsh-chatgpt-sub",factory(require){const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`)
