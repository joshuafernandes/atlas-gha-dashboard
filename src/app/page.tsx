import { redirect } from 'next/navigation'

// This is the entry route (/). 
// Immediately redirect to /prs, which is the main dashboard page.
export default function Home() {
  redirect('/prs')
}
