import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'

type Metadata = { versions: Record<string, { dist?: { integrity?: string } }>; 'dist-tags': Record<string, string> }

export async function metadata(name: string, fetcher: typeof fetch = fetch): Promise<Metadata> {
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(15_000), headers: { 'Cache-Control': 'no-cache' } })
  if (response.status === 404) return { versions: {}, 'dist-tags': {} }
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`)
  const data = await response.json() as Metadata
  assert(data && data.versions && typeof data.versions === 'object' && !Array.isArray(data.versions) && data['dist-tags'] && typeof data['dist-tags'] === 'object' && !Array.isArray(data['dist-tags']), 'Invalid npm metadata')
  return data
}

export function releasePlan(version: string, registry: Metadata) {
  const core = '(0|[1-9][0-9]*)'
  const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
  assert(new RegExp(`^${core}\\.${core}\\.${core}(?:-${identifier}(?:\\.${identifier})*)?$`).test(version), 'Use a semantic version without build metadata')
  const tag = version.includes('-') ? 'next' : 'latest'
  if (Object.hasOwn(registry.versions, version)) return { publish: false, tag }
  const latest = registry['dist-tags'].latest
  if (tag === 'latest' && latest) {
    const current = version.split('.').map(BigInt)
    assert(/^\d+\.\d+\.\d+$/.test(latest), 'Unexpected latest version; inspect npm before publishing')
    const prior = latest.split('.').map(BigInt)
    const difference = current.map((part, index) => part - prior[index]!).find(part => part !== 0n)
    assert(difference !== undefined && difference > 0n, 'Refusing to move latest backwards')
  }
  return { publish: true, tag }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { name, version } = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string }
  if (process.argv[2] === 'plan') {
    const plan = releasePlan(version, await metadata(name))
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `publish=${plan.publish}\ntag=${plan.tag}\n`)
    console.log(`${name}@${version}: ${plan.publish ? `publish to ${plan.tag}` : 'already published; skipping'}`)
  } else if (process.argv[2] === 'verify') {
    assert(process.env.EXPECTED_INTEGRITY && process.env.DIST_TAG, 'Missing expected release metadata')
    let verified = false
    for (let attempt = 0; attempt < 12; attempt++) {
      const data = await metadata(name)
      if (data.versions[version]) {
        assert.equal(data.versions[version]?.dist?.integrity, process.env.EXPECTED_INTEGRITY, 'Published archive differs from checked artifact')
        if (data['dist-tags'][process.env.DIST_TAG] === version) { verified = true; break }
      }
      await setTimeout(5000)
    }
    assert(verified, 'Could not verify published version and dist-tag')
    console.log(`Verified ${name}@${version}: version, dist-tag and integrity match`)
  } else throw new Error('Usage: node scripts/release.ts plan|verify')
}
