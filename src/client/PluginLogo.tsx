import { useId } from 'react'
import { knotPath, mouthPath, whalePath } from './logo.js'

/** Harness whale, mouth open around the ChatGPT knot; monochrome in each theme. */
export function PluginLogo() {
  const mouth = useId()
  return <svg className="cgs-logo" aria-hidden="true" width="32" height="32" viewBox="0 0 64 64" fill="none">
    <defs><mask id={mouth} maskUnits="userSpaceOnUse" x="-8" y="0" width="60" height="50">
      <rect x="-8" width="60" height="50" fill="white" />
      <path d={mouthPath} fill="black" />
      <circle cx="11.5" cy="15.5" r="1.35" fill="black" />
    </mask></defs>
    <path transform="translate(8 5) scale(1.08)" mask={`url(#${mouth})`} fill="currentColor" d={whalePath} />
    <path transform="translate(6 27) scale(.82)" fill="currentColor" d={knotPath} />
  </svg>
}
