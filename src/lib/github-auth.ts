// 
// GitHub authentication helpers.
//
// Resolves a Bearer token for a given org/user owner, preferring a GitHub App
// installation token when GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY are set, and
// falling back to a classic/fine-grained PAT from GITHUB_TOKEN.
//
// GITHUB APP FLOW
//   1. Sign a short-lived JWT (9 min) with the app's RS256 private key.
//   2. Use the JWT to look up the installation ID for the target org (cached).
//   3. Exchange JWT + installation ID for an installation access token (1 hour).
//   4. Cache the installation token per org; refresh automatically on expiry.
//
// PAT FALLBACK
//   If GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY are absent, GITHUB_TOKEN is
//   returned as-is for every owner. This keeps the dashboard working with a
//   classic/fine-grained PAT without any code changes.
// 

import { SignJWT, importPKCS8 } from 'jose'

const GH_API = 'https://api.github.com'

interface AppConfig {
  appId: string
  privateKey: string
  pinnedInstallationId?: number
}

interface CachedToken {
  token: string
  expiresAt: number
}

// Installation access tokens cached per org (GitHub issues them for 1 hour)
const tokenCache = new Map<string, CachedToken>()

// org login → installation ID, populated lazily on first request per owner
const installationIds = new Map<string, number>()

function getAppConfig(): AppConfig | null {
  const appId = process.env.GITHUB_APP_ID
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY
  if (!appId || !privateKey) return null
  return {
    appId,
    // Support both real newlines (.env.local multiline) and escaped \n (Docker -e / CI secrets)
    privateKey: privateKey.replace(/\\n/g, '\n'),
    pinnedInstallationId: process.env.GITHUB_APP_INSTALLATION_ID
      ? parseInt(process.env.GITHUB_APP_INSTALLATION_ID, 10)
      : undefined,
  }
}

async function generateJwt(appId: string, privateKey: string): Promise<string> {
  const key = await importPKCS8(privateKey, 'RS256')
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60)  // 60s in the past to absorb clock skew
    .setIssuer(appId)
    .setExpirationTime(now + 540)  // 9 min (GitHub max is 10)
    .sign(key)
}

async function resolveInstallationId(owner: string, jwt: string): Promise<number> {
  const key = owner.toLowerCase()
  if (installationIds.has(key)) return installationIds.get(key)!

  const res = await fetch(`${GH_API}/app/installations?per_page=100`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'gha-dashboard',
    },
  })
  if (!res.ok) throw new Error(`GitHub App: failed to list installations (${res.status})`)

  const list = (await res.json()) as Array<{ id: number; account: { login: string } }>
  for (const inst of list) {
    installationIds.set(inst.account.login.toLowerCase(), inst.id)
  }

  const id = installationIds.get(key)
  if (!id) throw new Error(`GitHub App is not installed on "${owner}"`)
  return id
}

async function fetchInstallationToken(owner: string, config: AppConfig): Promise<string> {
  const cached = tokenCache.get(owner)
  // Refresh 1 minute before expiry so in-flight requests don't race a stale token
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  const jwt = await generateJwt(config.appId, config.privateKey)
  const installationId =
    config.pinnedInstallationId ?? (await resolveInstallationId(owner, jwt))

  const res = await fetch(`${GH_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'gha-dashboard',
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `GitHub App: failed to get token for "${owner}" (${res.status}): ${body.slice(0, 200)}`,
    )
  }

  const { token, expires_at } = (await res.json()) as { token: string; expires_at: string }
  tokenCache.set(owner, { token, expiresAt: new Date(expires_at).getTime() })
  return token
}

/**
 * Return a valid GitHub Bearer token for the given org or user owner.
 * Uses GitHub App installation tokens when app credentials are configured,
 * otherwise falls back to the GITHUB_TOKEN PAT.
 */
export async function getTokenForOwner(owner: string): Promise<string> {
  const appConfig = getAppConfig()
  if (appConfig) return fetchInstallationToken(owner, appConfig)

  const pat = process.env.GITHUB_TOKEN
  if (!pat)
    throw new Error(
      'No GitHub credentials configured — set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY or GITHUB_TOKEN',
    )
  return pat
}
