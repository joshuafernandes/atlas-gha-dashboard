import { getServerSession } from 'next-auth'
import { redirect } from 'next/navigation'
import { authOptions } from '@/lib/auth'
import { LoginButton } from './login-button'

export default async function LoginPage() {
  const session = await getServerSession(authOptions)
  if (session) redirect('/prs')

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-8 px-6">
        <div className="text-center space-y-2">
          <div className="flex justify-center mb-6">
            <div className="h-12 w-12 rounded-xl bg-blue-600 flex items-center justify-center">
              <svg className="h-7 w-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" />
              </svg>
            </div>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">GHA Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Sign in to view GitHub Actions PR workflows
          </p>
        </div>
        <LoginButton />
      </div>
    </div>
  )
}
