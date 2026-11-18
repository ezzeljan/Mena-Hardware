import { lazy } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '@/features/auth/AuthContext'
import { AuthPage } from '@/features/auth/AuthPage'
import { AppShell } from '@/components/layout/AppShell'

// Each page is downloaded the first time it is opened, so the first load only
// fetches the shell and the page being viewed.
const PartsLibraryPage = lazy(() =>
  import('@/features/parts/PartsLibraryPage').then((m) => ({ default: m.PartsLibraryPage })),
)
const ManufacturersPage = lazy(() =>
  import('@/features/manufacturers/ManufacturersPage').then((m) => ({
    default: m.ManufacturersPage,
  })),
)
const StandardSetsPage = lazy(() =>
  import('@/features/standard-sets/StandardSetsPage').then((m) => ({
    default: m.StandardSetsPage,
  })),
)
const StandardSetDetailPage = lazy(() =>
  import('@/features/standard-sets/StandardSetDetailPage').then((m) => ({
    default: m.StandardSetDetailPage,
  })),
)
const ProjectsPage = lazy(() =>
  import('@/features/projects/ProjectsPage').then((m) => ({ default: m.ProjectsPage })),
)
const ProjectDetailPage = lazy(() =>
  import('@/features/projects/ProjectDetailPage').then((m) => ({
    default: m.ProjectDetailPage,
  })),
)
const ProjectHardwarePage = lazy(() =>
  import('@/features/projects/ProjectHardwarePage').then((m) => ({
    default: m.ProjectHardwarePage,
  })),
)
const UsersPage = lazy(() =>
  import('@/features/users/UsersPage').then((m) => ({ default: m.UsersPage })),
)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
    },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<AuthPage />} />
            <Route element={<AppShell />}>
              <Route index element={<Navigate to="/parts" replace />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:id" element={<ProjectDetailPage />} />
              <Route path="/projects/:id/hardware" element={<ProjectHardwarePage />} />
              <Route path="/parts" element={<PartsLibraryPage />} />
              <Route path="/manufacturers" element={<ManufacturersPage />} />
              <Route path="/standard-sets" element={<StandardSetsPage />} />
              <Route
                path="/standard-sets/:id"
                element={<StandardSetDetailPage />}
              />
              <Route path="/users" element={<UsersPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/parts" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}
