
// ... is the catch-all for any number of path segments after /api/auth/.
// NextAuth needs this because it handles many sub-paths dynamically: /api/auth/signin, /api/auth/signout,

import NextAuth from 'next-auth'
import { authOptions } from '@/lib/auth'

const handler = NextAuth(authOptions)

export { handler as GET, handler as POST }
