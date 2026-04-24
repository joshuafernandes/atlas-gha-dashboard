
// NextAuth's middleware which:
// - checks for a valid session cookie.
// - teh redirect to /login is baked into that NextAuth middleware. 
//
// If it sees an unauthenticated request on a matched route, it automatically redirects to whatever
// `pages.signIn` is set to in `/lib/auth.ts` config i.e `/login`

export { default } from 'next-auth/middleware'

export const config = {
  matcher: [
    '/prs',
    '/workflows',
    '/dependabot-alerts',
    '/code-scanning',
    '/secret-scanning',
    '/api/prs',
    '/api/workflows',
    '/api/dependabot-alerts',
    '/api/code-scanning',
    '/api/secret-scanning',
    '/api/repos',
  ],
}
