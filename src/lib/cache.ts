// 
// Simple in-process server-side cache.
//
// WHY: GitHub's API rate limit is 5 000 requests/hour for authenticated users.
// With several repos and multiple pages polling, we could exhaust that without
// caching. This module stores the last successful fetch in memory with a TTL
// so all client requests within that window share one GitHub response.
//
// HOW IT WORKS:
//   - A single `store` Map lives at module scope (persists across requests in
//     the same Node.js process — i.e. the same `next dev` or `next start` run).
//   - Each entry has an `expiresAt` timestamp; stale entries are evicted on
//     the next read.
//   - The API routes call getCached() first; if there's a hit they return it
//     immediately without touching GitHub. On a miss they fetch, then call
//     setCached() to store the result.
//
// LIMITS:
//   - Memory only — cache is lost on server restart.
//   - Single-process only — won't share across multiple Node workers (fine for
//     a small internal dashboard; use Redis if you ever need to scale out).
//
// TTLs used across the app:
//   PRs            30 s  — want near-real-time build status
//   Secrets         5 min — change rarely
//   Workflows       2 min — analytics don't need to be live
//   Code scanning  10 min — alerts change slowly
// 

interface CacheEntry<T> {
  data: T
  updatedAt: string  // ISO timestamp surfaced to the client as "last updated"
  expiresAt: number  // Date.now() + TTL in ms
}

// Module-level store — survives across requests in the same server process.
const store = new Map<string, CacheEntry<unknown>>()

/**
 * Return a cached entry if it exists and hasn't expired, otherwise null.
 * Expired entries are deleted eagerly on read to avoid stale data accumulating.
 */
export function getCached<T>(key: string): CacheEntry<T> | null {
  const entry = store.get(key) as CacheEntry<T> | undefined
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    store.delete(key)
    return null
  }
  return entry
}

/**
 * Store a value in the cache under `key` for `ttlMs` milliseconds.
 * Returns the created entry so the caller can read `updatedAt` for the response.
 */
export function setCached<T>(key: string, data: T, ttlMs: number): CacheEntry<T> {
  const entry: CacheEntry<T> = {
    data,
    updatedAt: new Date().toISOString(),
    expiresAt: Date.now() + ttlMs,
  }
  store.set(key, entry as CacheEntry<unknown>)
  return entry
}
