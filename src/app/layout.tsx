import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'GHA Dashboard',
  description: 'GitHub Actions PR workflow dashboard',
}

// This is the root shell. Every page in the app is rendered inside here.
// It sets the HTML skeleton, loads the fonts, global CSS, etc and wraps everything in <Providers> (which is where the NextAuth session context lives)
// See the providers.tsx file for more details 
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
