import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Check the actual archive that CI will publish; build before running this script.
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts'], { encoding: 'utf8' }))
const read = path => execFileSync('tar', ['-xOf', packed.filename, `package/${path}`], { encoding: 'utf8' })
const pkg = JSON.parse(read('package.json'))
const source = JSON.parse(readFileSync('package.json', 'utf8'))
assert.equal(pkg.name, source.name)
assert.equal(pkg.version, source.version)
assert.equal(pkg.publishConfig.access, 'public')
assert.equal(pkg.publishConfig.registry, 'https://registry.npmjs.org/')

const files = new Set(packed.files.map(file => file.path))
const requireFile = path => assert(files.has(path.replace(/^\.\//, '')), `Missing packed file: ${path}`)
for (const path of [pkg.exports['.'].types, pkg.exports['.'].default, pkg.exports['./client'], pkg.exports['./package.json'], pkg.dsh.bundle.patch, 'assets/logo.svg', 'README.md']) requireFile(path)
for (const path of files) {
  assert(/^(dist\/|docs\/|assets\/|package\.json$|README\.md$|cordis\.patch\.yml$|LICENSE(?:\..*)?$)/.test(path), `Unexpected packed file: ${path}`)
  assert(!/(^|\/)(?:\.env(?:\..*)?|node_modules|test-results|\.npmrc)(\/|$)/.test(path), `Private or generated file: ${path}`)
}

const patch = read(pkg.dsh.bundle.patch.replace(/^\.\//, ''))
assert(patch.includes(`name: '${pkg.name}'`), 'Composition patch must load the published package')
let clientModule
runInNewContext(read(pkg.exports['./client'].replace(/^\.\//, '')), {
  window: { __ModuleLoader__: { load(module) { clientModule = module } } },
}, { timeout: 1000 })
assert.equal(clientModule?.id, pkg.name, 'Client ModuleLoader ID must match the package name')
assert.equal(typeof clientModule.factory, 'function')
assert(read(pkg.exports['.'].default.replace(/^\.\//, '')).includes(pkg.name), 'Host RPC must use the published package name')
assert(clientModule.factory.toString().includes(pkg.name), 'Client RPC must use the published package name')
for (const path of files) {
  if (!path.endsWith('.md')) continue
  for (const [, target] of read(path).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/i.test(target)) continue
    const resolved = new URL(target, `https://package.local/${path}`).pathname.slice(1)
    requireFile(resolved)
  }
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${packed.filename}\nintegrity=${packed.integrity}\n`)
console.log(`Verified ${packed.filename}: ${files.size} files, ${packed.integrity}`)
