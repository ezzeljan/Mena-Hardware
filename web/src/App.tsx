import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '@/features/auth/AuthContext'
import { AuthPage } from '@/features/auth/AuthPage'
import { AppShell } from '@/components/layout/AppShell'
import { PartsLibraryPage } from '@/features/parts/PartsLibraryPage'
import { ManufacturersPage } from '@/features/manufacturers/ManufacturersPage'
import { StandardSetsPage } from '@/features/standard-sets/StandardSetsPage'
import { StandardSetDetailPage } from '@/features/standard-sets/StandardSetDetailPage'
import { UsersPage } from '@/features/users/UsersPage'

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
