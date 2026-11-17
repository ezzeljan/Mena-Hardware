import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Navigate, useNavigate } from 'react-router-dom'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import {
  loginSchema,
  signUpSchema,
  type LoginFormValues,
  type SignUpFormValues,
} from '@/lib/schemas'
import { useAuth } from './AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function AuthPage() {
  const { session, loading } = useAuth()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [serverError, setServerError] = useState<string | null>(null)
  const [infoMessage, setInfoMessage] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const loginForm = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  })

  const signUpForm = useForm<SignUpFormValues>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { full_name: '', email: '', password: '' },
  })

  if (!loading && session) {
    return <Navigate to="/parts" replace />
  }

  async function onLoginSubmit(values: LoginFormValues) {
    setServerError(null)
    setInfoMessage(null)
    setSubmitting(true)
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: values.email,
        password: values.password,
      })
      if (error) {
        setServerError(error.message)
        return
      }
      navigate('/parts', { replace: true })
    } finally {
      setSubmitting(false)
    }
  }

  async function onSignUpSubmit(values: SignUpFormValues) {
    setServerError(null)
    setInfoMessage(null)
    setSubmitting(true)
    try {
      const { data, error } = await supabase.auth.signUp({
        email: values.email,
        password: values.password,
        options: {
          data: { full_name: values.full_name },
        },
      })
      if (error) {
        setServerError(error.message)
        return
      }
      if (data.session) {
        navigate('/parts', { replace: true })
      } else {
        setInfoMessage(
          'Account created with default role "viewer". If email confirmation is enabled, check your inbox before signing in.',
        )
        setMode('login')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-neutral-50 flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-md border border-neutral-300 bg-white p-8 shadow-2xs">
        <div className="flex items-center gap-3 border-b border-neutral-200 pb-5 mb-6">
          <div className="flex h-9 w-9 items-center justify-center border border-neutral-950 bg-neutral-950 text-white">
            <KeyRound className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-neutral-950">
              MENA HARDWARE
            </h1>
            <p className="text-xs text-neutral-600">
              Door Hardware Library &amp; Standard Sets
            </p>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="Authentication mode"
          className="grid grid-cols-2 border border-neutral-300 p-0.5 mb-6 bg-neutral-100"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            onClick={() => {
              setMode('login')
              setServerError(null)
              setInfoMessage(null)
            }}
            className={`py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors cursor-pointer ${
              mode === 'login'
                ? 'bg-neutral-950 text-white'
                : 'text-neutral-700 hover:text-neutral-950'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signup'}
            onClick={() => {
              setMode('signup')
              setServerError(null)
              setInfoMessage(null)
            }}
            className={`py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors cursor-pointer ${
              mode === 'signup'
                ? 'bg-neutral-950 text-white'
                : 'text-neutral-700 hover:text-neutral-950'
            }`}
          >
            Create Account
          </button>
        </div>

        {serverError && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 border border-neutral-950 bg-neutral-100 p-3 text-xs text-neutral-950"
          >
            <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{serverError}</span>
          </div>
        )}

        {infoMessage && (
          <div
            role="status"
            className="mb-4 border border-neutral-400 bg-neutral-50 p-3 text-xs text-neutral-900"
          >
            {infoMessage}
          </div>
        )}

        {mode === 'login' ? (
          <form
            onSubmit={loginForm.handleSubmit(onLoginSubmit)}
            className="space-y-4"
            noValidate
          >
            <div className="space-y-1.5">
              <Label htmlFor="login-email">Email</Label>
              <Input
                id="login-email"
                type="email"
                autoComplete="email"
                placeholder="name@menacontractors.com"
                {...loginForm.register('email')}
              />
              {loginForm.formState.errors.email && (
                <p className="text-xs font-medium text-neutral-900">
                  {loginForm.formState.errors.email.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                {...loginForm.register('password')}
              />
              {loginForm.formState.errors.password && (
                <p className="text-xs font-medium text-neutral-900">
                  {loginForm.formState.errors.password.message}
                </p>
              )}
            </div>

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Signing in...' : 'Sign In'}
            </Button>
          </form>
        ) : (
          <form
            onSubmit={signUpForm.handleSubmit(onSignUpSubmit)}
            className="space-y-4"
            noValidate
          >
            <div className="space-y-1.5">
              <Label htmlFor="signup-name">Full Name</Label>
              <Input
                id="signup-name"
                type="text"
                autoComplete="name"
                placeholder="Alex Taylor"
                {...signUpForm.register('full_name')}
              />
              {signUpForm.formState.errors.full_name && (
                <p className="text-xs font-medium text-neutral-900">
                  {signUpForm.formState.errors.full_name.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="signup-email">Email</Label>
              <Input
                id="signup-email"
                type="email"
                autoComplete="email"
                placeholder="name@menacontractors.com"
                {...signUpForm.register('email')}
              />
              {signUpForm.formState.errors.email && (
                <p className="text-xs font-medium text-neutral-900">
                  {signUpForm.formState.errors.email.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="signup-password">Password</Label>
              <Input
                id="signup-password"
                type="password"
                autoComplete="new-password"
                placeholder="Minimum 6 characters"
                {...signUpForm.register('password')}
              />
              {signUpForm.formState.errors.password && (
                <p className="text-xs font-medium text-neutral-900">
                  {signUpForm.formState.errors.password.message}
                </p>
              )}
            </div>

            <p className="text-xs text-neutral-600">
              New accounts default to the{' '}
              <span className="font-semibold text-neutral-950">viewer</span>{' '}
              role. An administrator can update roles from the Users screen.
            </p>

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Creating account...' : 'Create Account'}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
