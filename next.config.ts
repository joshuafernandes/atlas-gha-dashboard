import type { NextConfig } from 'next'

const config: NextConfig = {
  // Standalone output bundles only the files needed to run the server.
  // The result at .next/standalone/server.js is what the Dockerfile executes —
  // no node_modules install step required in the final image layer.
  output: 'standalone',
  images: {
    domains: ['avatars.githubusercontent.com', 'lh3.googleusercontent.com'],
  },
}

export default config
