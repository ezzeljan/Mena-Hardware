import { lazy } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '@/features/auth/AuthContext'
import { AuthPage } from '@/features/auth/AuthPage'
import { AppShell } from '@/components/layout/AppShell'

// Each page is downloaded the first time it is opened, so the first load only
// fetches the shell and the page being viewed.
const DashboardPage = lazy(() =>
  import('@/features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
)
const PartsLibraryPage = lazy(() =>
  import('@/features/parts/PartsLibraryPage').then((m) => ({ default: m.PartsLibraryPage })),
)
const SuppliersPage = lazy(() =>
  import('@/features/suppliers/SuppliersPage').then((m) => ({
    default: m.SuppliersPage,
  })),
)
const SupplierProductsPage = lazy(() =>
  import('@/features/suppliers/SupplierProductsPage').then((m) => ({
    default: m.SupplierProductsPage,
  })),
)
const StandardSetsPage = lazy(() =>
  import('@/features/standard-sets/StandardSetsPage').then((m) => ({
    default: m.StandardSetsPage,
  })),
)
const GenericItemsPage = lazy(() =>
  import('@/features/standard-sets/GenericItemsPage').then((m) => ({
    default: m.GenericItemsPage,
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
const ImportQuotationPage = lazy(() =>
  import('@/features/projects/ImportQuotationPage').then((m) => ({
    default: m.ImportQuotationPage,
  })),
)
const ProjectHardwarePage = lazy(() =>
  import('@/features/projects/ProjectHardwarePage').then((m) => ({
    default: m.ProjectHardwarePage,
  })),
)
const AccountPage = lazy(() =>
  import('@/features/account/AccountPage').then((m) => ({ default: m.AccountPage })),
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
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:id" element={<ProjectDetailPage />} />
              <Route path="/projects/:id/hardware" element={<ProjectHardwarePage />} />
              <Route path="/projects/:id/import" element={<ImportQuotationPage />} />
              <Route path="/parts" element={<PartsLibraryPage />} />
              <Route path="/suppliers" element={<SuppliersPage />} />
              <Route path="/suppliers/:id" element={<SupplierProductsPage />} />
              <Route path="/manufacturers" element={<Navigate to="/suppliers" replace />} />
              <Route path="/standard-sets" element={<StandardSetsPage />} />
              <Route path="/standard-sets/generic" element={<GenericItemsPage />} />
              <Route
                path="/standard-sets/:id"
                element={<StandardSetDetailPage />}
              />
              <Route path="/users" element={<UsersPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}
