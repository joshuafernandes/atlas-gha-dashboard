
# Atlas

To give you an overview of your GHA workflows, secret scanning, code scanning, PRs etc. CircleCI has
something like this but GHA doesn't so... this is my attempt at a dashboard of sorts.

This uses Next.js 15 for a dashboard app to monitor GitHub Actions CI across multiple repos. Shows
open PRs with live build status, workflow analytics, code scanning alerts, and Dependabot secrets.

Note:
- I've use the app router here, (hence no `pages`) owing to the nested layouts design, async/await
to fetch data and so on. `app` is the routing root, and each folder with a `page.tsx` is a route
eg `app/prs` etc.
- (dashboard) folder is a route group, used here to share the
dashboard layout (src/app/(dashboard)/layout.tsx) across those routes.
- 


## Folder layout
```
.
├── src/
│   ├── app/
│   │   ├── (dashboard)/                    # authenticated dashboard pages
│   │   │   ├── layout.tsx                  # sidebar + header shell
│   │   │   ├── prs/                        # pull requests + CI status
│   │   │   ├── workflows/                  # analytics, sparklines, metrics
│   │   │   ├── code-scanning/              # open SAST/DAST alerts
│   │   │   ├── dependabot-alerts/          # open dependency vulnerabilities
│   │   │   └── secret-scanning/            # open secret scanning alerts
│   │   ├── api/
│   │   │   ├── auth/[...nextauth]/route.ts # NextAuth handler
│   │   │   ├── prs/route.ts                # fetches PRs + workflow runs (30s cache)
│   │   │   ├── workflows/route.ts          # fetches workflow metrics (2min cache)
│   │   │   ├── code-scanning/route.ts      # fetches code scan alerts (10min cache)
│   │   │   ├── secret-scanning/route.ts    # fetches secret scanning alerts (10min cache)
│   │   │   ├── dependabot-alerts/route.ts  # fetches Dependabot alerts (10min cache)
│   │   │   ├── repos/route.ts              # returns configured repo list
│   │   │   └── healthz/route.ts            # health check endpoint
│   │   ├── login/                          # Google OAuth login page
│   │   └── providers.tsx                   # SessionProvider + ThemeProvider
│   ├── lib/
│   │   ├── github.ts                       # all GitHub REST + GraphQL API calls
│   │   ├── github-auth.ts                  # GitHub App JWT + installation token management
│   │   ├── cache.ts                        # in-process TTL cache (avoids rate limits)
│   │   ├── config.ts                       # env var parsing (repos, token, limits)
│   │   ├── auth.ts                         # NextAuth config + Google OAuth
│   │   ├── utils.ts
│   │   └── date.ts
│   ├── types/
│   │   └── index.ts                        # shared TypeScript types
│   ├── components/
│   │   ├── ui/                             # shadcn/ui primitives (button, badge, card…)
│   │   └── common/                         # custom dashboard components
│   │       ├── PrList/
│   │       ├── WorkflowStats/
│   │       ├── WorkflowBadge/
│   │       ├── CodeScanAlerts/
│   │       ├── DependabotAlerts/
│   │       ├── SecretScanAlerts/
│   │       ├── Header/
│   │       ├── Sidebar/
│   │       ├── RepoFilter/
│   │       └── ThemeToggle/
│   └── middleware.ts                       # route protection via next-auth
├── .github/workflows/
├── Dockerfile
├── renovate.json
└── .env.local.example                      # all required env vars documented here
```

## 1. GitHub App setup

The dashboard authenticates as a GitHub App, which allows it to span multiple organisations without
tying credentials to a personal user account.

The dashboard calls these GitHub API endpoints:

| Endpoint | Used for |
|---|---|
| `GET /repos/:owner/:repo/pulls` | PR list |
| `POST https://api.github.com/graphql` | Review decisions (approved / changes requested) |
| `GET /repos/:owner/:repo/actions/runs` | Workflow runs per PR commit |
| `GET /repos/:owner/:repo/actions/runs/:id/jobs` | Failed / in-progress job names |
| `GET /repos/:owner/:repo/commits/:sha/check-runs` | Test counts (dorny/test-reporter etc.) |
| `GET /repos/:owner/:repo/actions/workflows` | Workflow list for analytics page |
| `GET /repos/:owner/:repo/code-scanning/alerts` | Code scanning alerts page |
| `GET /repos/:owner/:repo/dependabot/alerts` | Dependabot vulnerability alerts page |
| `GET /repos/:owner/:repo/secret-scanning/alerts` | Secret scanning alerts page |

#### 1.1 Create the GitHub App

Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.

- **Homepage URL**: your dashboard URL (or `http://localhost:3000` for dev)
- **Webhooks**: uncheck "Active" — not needed
- **Where can this app be installed**: "Any account"

Set these permissions:

| Permission | Level | Required for |
|---|---|---|
| **Metadata** | Read | Mandatory baseline |
| **Pull requests** | Read | PR list + review decisions |
| **Actions** | Read | Workflow runs, jobs, workflow list |
| **Checks** | Read | Test counts from check runs |
| **Code scanning alerts** | Read | Code scanning page (optional — omit if not needed) |
| **Dependabot alerts** | Read | Dependabot vulnerability alerts page (optional) |
| **Secret scanning alerts** | Read | Secret scanning alerts page (optional — requires GitHub Advanced Security) |

After creating the app, generate a private key from the app's settings page — this downloads a `.pem` file.

#### 1.2 Install the app

In the app's **Install App** tab, install it into your personal account and each organisation that
owns repos in `GITHUB_REPOS`. The dashboard auto-discovers the installation ID for each org at
startup.

#### 1.3 Collect credentials

| Value | Where to find it |
|---|---|
| App ID | App settings page, top section |
| Private key | Downloaded `.pem` file after generating a key |

| ⚠️ **Note**: The app uses a private key in pkcs8 fromat, but GitHub generates them in pkcs1. To convert: `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem`
| ---  


> **PAT fallback**: set `GITHUB_TOKEN` instead of the app vars if you prefer a classic PAT.
The dashboard uses app credentials when `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` are present,
and falls back to `GITHUB_TOKEN` otherwise.

| ⚠️ **Note**: If you are using a classic PAT please note that the scope is ALL repos (private & public). So use this with caution
| ---                                                                                                                                                                              |

## 2. Setup

Copy the example env file and fill in your values:
```bash
cp .env.local.example .env.local
```

| Variable | Required | Description |
|---|---|---|
| `GITHUB_APP_ID` | yes* | Numeric app ID from the GitHub App settings page |
| `GITHUB_APP_PRIVATE_KEY` | yes* | PEM private key in pkcs8 format — use real newlines in `.env.local`, or `\n`-escaped for Docker/CI |
| `GITHUB_APP_INSTALLATION_ID` | no | Pin to a specific installation (skips auto-discovery; useful if app is installed on one account only) |
| `GITHUB_TOKEN` | yes* | Classic or fine-grained PAT — used as fallback when app vars are absent |
| `GITHUB_REPOS` | yes | Comma-separated `owner/repo` pairs e.g. `myOrgA/repo1,myOrgB/repo2` |
| `GOOGLE_CLIENT_ID` | yes | From [Google Cloud Console](https://console.cloud.google.com/apis/credentials) |
| `GOOGLE_CLIENT_SECRET` | yes | Same credential |
| `NEXTAUTH_SECRET` | yes | Run `openssl rand -base64 32` |
| `NEXTAUTH_URL` | yes | `http://localhost:3000` for dev, full URL in prod |
| `ALLOWED_EMAIL_DOMAIN` | no | Restrict login to e.g. `myOrg.net` |
| `WORKFLOW_RUNS_LIMIT` | no | Runs fetched per workflow for sparklines (default `20`, max `100`) |

*Either `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` **or** `GITHUB_TOKEN` is required.

> **Optional security scanning pages**: The code scanning, Dependabot, and secret scanning pages
require the corresponding GitHub App permissions (or PAT scopes) to be set. If a repo is missing a
required permission, the dashboard shows an info note for that repo rather than failing — the rest
of the data still loads.

Install dependencies:
```bash
npm install
```

## 3. Run

```bash
npm run dev
```

Opens at [http://localhost:3000](http://localhost:3000). Hot-reload is on via Turbopack.

## 4. Docker

#### 4.1 Build
```bash
docker build -t gha-dashboard .
```

#### 4.2 Run
```bash
docker run -p 3000:3000 \
  -e GITHUB_APP_ID=123456 \
  -e GITHUB_APP_PRIVATE_KEY="$(cat /path/to/private-key.pem | tr '\n' '\\n')" \
  -e GITHUB_REPOS=myOrgA/repo1,myOrgB/repo2 \
  -e GOOGLE_CLIENT_ID=xxx \
  -e GOOGLE_CLIENT_SECRET=xxx \
  -e NEXTAUTH_SECRET=xxx \
  -e NEXTAUTH_URL=http://localhost:3000 \
  gha-dashboard
```

#### 4.3 Docker Hub (CI)

Pushing to `main` or tagging `v*` triggers the GitHub Actions workflow which builds a multi-platform
image (`linux/amd64` + `linux/arm64`) and pushes to Docker Hub.

Requires two repo secrets: `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.
