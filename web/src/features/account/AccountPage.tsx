import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Camera, KeyRound, Trash2, UserRound } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { resizeAvatar } from '@/lib/avatar'
import { useAuth } from '@/features/auth/AuthContext'
import { UserAvatar } from '@/components/avatar/UserAvatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** Storage path of an avatar from its public URL ("<user id>/<file>"), if it is ours. */
function avatarPathFromUrl(url: string | null | undefined): string | null {
  const marker = '/storage/v1/object/public/avatars/'
  const i = url ? url.indexOf(marker) : -1
  return i >= 0 ? decodeURIComponent(url!.slice(i + marker.length).split('?')[0]) : null
}

type Status = { kind: 'ok' | 'error'; text: string } | null

/** The signed-in user's own account: photo, name and password. */
export function AccountPage() {
  const { user, profile, role, refreshProfile } = useAuth()
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement | null>(null)

  const [name, setName] = useState(profile?.full_name ?? '')
  const [nameStatus, setNameStatus] = useState<Status>(null)
  const [savingName, setSavingName] = useState(false)

  const [photoStatus, setPhotoStatus] = useState<Status>(null)
  const [savingPhoto, setSavingPhoto] = useState(false)

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [passwordStatus, setPasswordStatus] = useState<Status>(null)
  const [savingPassword, setSavingPassword] = useState(false)

  useEffect(() => {
    setName(profile?.full_name ?? '')
  }, [profile?.full_name])

  const afterProfileChange = async () => {
    await refreshProfile()
    await queryClient.invalidateQueries({ queryKey: ['profile_directory'] })
    await queryClient.invalidateQueries({ queryKey: ['profiles'] })
  }

  const saveProfile = async (fullName: string, avatarUrl: string | null) => {
    const { error } = await supabase.rpc('update_my_profile', {
      p_full_name: fullName,
      p_avatar_url: avatarUrl,
    })
    if (error) throw error
    await afterProfileChange()
  }

  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault()
    setNameStatus(null)
    const trimmed = name.trim()
    if (!trimmed) {
      setNameStatus({ kind: 'error', text: 'Name is required.' })
      return
    }
    setSavingName(true)
    try {
      await saveProfile(trimmed, profile?.avatar_url ?? null)
      setNameStatus({ kind: 'ok', text: 'Name saved.' })
    } catch (err) {
      setNameStatus({ kind: 'error', text: (err as { message?: string }).message ?? 'Could not save.' })
    } finally {
      setSavingName(false)
    }
  }

  const handlePhoto = async (file: File | undefined) => {
    if (!file || !user) return
    setPhotoStatus(null)
    setSavingPhoto(true)
    const oldPath = avatarPathFromUrl(profile?.avatar_url)
    try {
      const blob = await resizeAvatar(file)
      const ext = blob.type === 'image/webp' ? 'webp' : 'jpg'
      const path = `${user.id}/${crypto.randomUUID()}.${ext}`
      const { error: upErr } = await supabase.storage
        .from('avatars')
        .upload(path, blob, { contentType: blob.type, upsert: false })
      if (upErr) throw upErr
      const { data } = supabase.storage.from('avatars').getPublicUrl(path)
      await saveProfile(profile?.full_name || name.trim() || 'User', data.publicUrl)
      if (oldPath) await supabase.storage.from('avatars').remove([oldPath])
      setPhotoStatus({ kind: 'ok', text: 'Photo updated.' })
    } catch (err) {
      setPhotoStatus({ kind: 'error', text: (err as { message?: string }).message ?? 'Could not upload the photo.' })
    } finally {
      setSavingPhoto(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const handleRemovePhoto = async () => {
    setPhotoStatus(null)
    setSavingPhoto(true)
    const oldPath = avatarPathFromUrl(profile?.avatar_url)
    try {
      await saveProfile(profile?.full_name || name.trim() || 'User', null)
      if (oldPath) await supabase.storage.from('avatars').remove([oldPath])
      setPhotoStatus({ kind: 'ok', text: 'Photo removed.' })
    } catch (err) {
      setPhotoStatus({ kind: 'error', text: (err as { message?: string }).message ?? 'Could not remove the photo.' })
    } finally {
      setSavingPhoto(false)
    }
  }

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPasswordStatus(null)
    if (password.length < 8) {
      setPasswordStatus({ kind: 'error', text: 'Use at least 8 characters.' })
      return
    }
    if (password !== confirm) {
      setPasswordStatus({ kind: 'error', text: 'The passwords do not match.' })
      return
    }
    setSavingPassword(true)
    const { error } = await supabase.auth.updateUser({ password })
    setSavingPassword(false)
    if (error) {
      setPasswordStatus({ kind: 'error', text: error.message })
      return
    }
    setPassword('')
    setConfirm('')
    setPasswordStatus({ kind: 'ok', text: 'Password changed.' })
  }

  const statusLine = (s: Status) =>
    s && (
      <p
        role={s.kind === 'error' ? 'alert' : 'status'}
        className={`text-xs ${s.kind === 'error' ? 'font-medium text-neutral-950' : 'text-neutral-600'}`}
      >
        {s.text}
      </p>
    )

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-neutral-950">My Account</h1>
        <p className="text-xs text-neutral-600 mt-1">Your photo and name appear across the app.</p>
      </div>

      {/* Photo */}
      <section className="border border-neutral-300 bg-white rounded-md p-5 space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
          <Camera className="h-3.5 w-3.5" />
          <span>Photo</span>
        </div>
        <div className="flex items-center gap-4">
          <UserAvatar name={profile?.full_name} email={profile?.email || user?.email} url={profile?.avatar_url} size="lg" />
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                aria-label="Choose a photo"
                onChange={(e) => void handlePhoto(e.target.files?.[0])}
              />
              <Button size="sm" disabled={savingPhoto} onClick={() => fileRef.current?.click()}>
                <Camera className="h-3.5 w-3.5" />
                <span>{savingPhoto ? 'Saving...' : profile?.avatar_url ? 'Change Photo' : 'Upload Photo'}</span>
              </Button>
              {profile?.avatar_url && (
                <Button size="sm" variant="outline" disabled={savingPhoto} onClick={() => void handleRemovePhoto()}>
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Remove</span>
                </Button>
              )}
            </div>
            <p className="text-xs text-neutral-500">
              PNG, JPEG or WebP. It's cropped to a square and resized automatically.
            </p>
            {statusLine(photoStatus)}
          </div>
        </div>
      </section>

      {/* Details */}
      <section className="border border-neutral-300 bg-white rounded-md p-5 space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
          <UserRound className="h-3.5 w-3.5" />
          <span>Details</span>
        </div>
        <form onSubmit={(e) => void handleSaveName(e)} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="account-name">Full Name</Label>
            <Input id="account-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div className="space-y-0.5">
              <div className="text-xs text-neutral-600">Email</div>
              <div className="text-neutral-950">{profile?.email || user?.email || '—'}</div>
            </div>
            <div className="space-y-0.5">
              <div className="text-xs text-neutral-600">Role</div>
              <Badge variant={role === 'admin' ? 'default' : 'secondary'} className="uppercase tracking-wider text-[10px]">
                {role}
              </Badge>
            </div>
          </div>
          <p className="text-xs text-neutral-500">Email and role are managed by an admin.</p>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={savingName || name.trim() === (profile?.full_name ?? '')}>
              {savingName ? 'Saving...' : 'Save Name'}
            </Button>
            {statusLine(nameStatus)}
          </div>
        </form>
      </section>

      {/* Password */}
      <section className="border border-neutral-300 bg-white rounded-md p-5 space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
          <KeyRound className="h-3.5 w-3.5" />
          <span>Password</span>
        </div>
        <form onSubmit={(e) => void handlePassword(e)} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="account-password">New Password</Label>
              <Input id="account-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="account-password-confirm">Confirm New Password</Label>
              <Input id="account-password-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={savingPassword || !password}>
              {savingPassword ? 'Saving...' : 'Change Password'}
            </Button>
            {statusLine(passwordStatus)}
          </div>
        </form>
      </section>
    </div>
  )
}
