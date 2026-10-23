import { longEdgeDimensions, type ImageAttachmentRef, type ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import type { ResponseInputImage } from 'openai/resources/responses/responses'

export type ImageQuality = 'auto' | 'balanced' | 'original'
export interface ImagePolicy {
  readonly detail: ResponseInputImage['detail']
  readonly maxDimension: number
  readonly maxPatches: number
  readonly maxBytes: number
  /** An explicit original request cannot be fulfilled by this catalog entry. */
  readonly requiresOriginal: boolean
}

// Conservative limits shared by documented model families. The account catalog
// is the authority for original support; new model names need no allowlist.
// https://developers.openai.com/api/docs/guides/images-vision
const BALANCED = { detail: 'high' as const, maxDimension: 2048, maxPatches: 2500, maxBytes: 1024 * 1024 }
const ORIGINAL = { detail: 'original' as const, maxDimension: 6000, maxPatches: 10_000, maxBytes: 8 * 1024 * 1024 }

/** Safe to call synchronously before discovery; only image preparation rejects. */
export function resolveImagePolicy(quality: ImageQuality = 'auto', supportsOriginal = false): ImagePolicy {
  const original = quality !== 'balanced' && supportsOriginal === true
  return { ...(original ? ORIGINAL : BALANCED), requiresOriginal: quality === 'original' && !original }
}

/** Shared by wire serialization and Harness's screenshot coordinate mapping. */
export function imageTarget(ref: ImageAttachmentRef, policy = resolveImagePolicy()): ImageRequestTarget {
  // Patch budgets round both dimensions up independently. A simple total-pixel
  // limit can overflow, particularly for narrow screenshots and panoramas.
  let low = 1
  let high = Math.min(Math.max(ref.width, ref.height), policy.maxDimension)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const size = longEdgeDimensions(ref.width, ref.height, middle)
    if (Math.ceil(size.width / 32) * Math.ceil(size.height / 32) <= policy.maxPatches) low = middle
    else high = middle - 1
  }
  return { ...longEdgeDimensions(ref.width, ref.height, low), maxBytes: policy.maxBytes }
}
