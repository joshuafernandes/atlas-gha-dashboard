import { Sidebar } from '@/components/common/Sidebar'
import { Header } from '@/components/common/Header'
import { RepoFilterProvider } from '@/components/common/RepoFilter/context'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <RepoFilterProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex flex-col flex-1 overflow-hidden">
          <Header />
          <main className="flex-1 overflow-y-auto bg-background">
            {children}
          </main>
        </div>
      </div>
    </RepoFilterProvider>
  )
}
