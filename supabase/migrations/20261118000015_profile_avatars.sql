-- =============================================================================
-- Migration: 20261118000015_profile_avatars.sql
-- Purpose: Profile photos and self-service profile edits.
--   * profiles.avatar_url, also exposed in profile_directory (visible to all
--     signed-in users, like names).
--   * Storage bucket "avatars": public read (hard-to-guess file names), images
--     only, max 2 MB. Each user writes only under "<their id>/..."; admins may
--     delete any avatar file.
--   * update_my_profile(full_name, avatar_url): a user edits their OWN name and
--     photo (roles stay admin-only). Admins keep editing other users' names
--     through the existing admin policy, but only the user can change their
--     own photo.
-- =============================================================================

alter table public.profiles
  add column if not exists avatar_url text null;

-- Append avatar_url (create or replace view may only add columns at the end).
create or replace view public.profile_directory
with (security_invoker = false)
as
  select id, full_name, role, avatar_url
  from public.profiles;

revoke all on public.profile_directory from public, anon;
grant select on public.profile_directory to authenticated;

-- Only the user themselves changes their photo (admins can still edit names/roles).
create or replace function public.enforce_own_avatar()
returns trigger
language plpgsql
as $$
begin
  if new.avatar_url is distinct from old.avatar_url
     and auth.uid() is not null
     and auth.uid() is distinct from new.id then
    raise exception 'Only the user can change their own photo' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_own_avatar on public.profiles;
create trigger trg_profiles_own_avatar
  before update of avatar_url on public.profiles
  for each row execute function public.enforce_own_avatar();

-- Self-service: name and photo only.
create or replace function public.update_my_profile(
  p_full_name text,
  p_avatar_url text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_full_name, ''));
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if v_name = '' then
    raise exception 'Name is required' using errcode = '22023';
  end if;
  if length(v_name) > 120 then
    raise exception 'Name is too long' using errcode = '22023';
  end if;
  if p_avatar_url is not null and length(p_avatar_url) > 1000 then
    raise exception 'Photo address is too long' using errcode = '22023';
  end if;

  update public.profiles
  set full_name = v_name,
      avatar_url = nullif(btrim(p_avatar_url), '')
  where id = auth.uid();
end;
$$;

revoke all on function public.update_my_profile(text, text) from public, anon;
grant execute on function public.update_my_profile(text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Storage bucket for profile photos
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "avatars_select_authenticated" on storage.objects;
create policy "avatars_select_authenticated"
  on storage.objects for select to authenticated
  using (bucket_id = 'avatars');

drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and split_part(name, '/', 1) = (select auth.uid())::text);

drop policy if exists "avatars_update_own" on storage.objects;
create policy "avatars_update_own"
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and split_part(name, '/', 1) = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and split_part(name, '/', 1) = (select auth.uid())::text);

drop policy if exists "avatars_delete_own_or_admin" on storage.objects;
create policy "avatars_delete_own_or_admin"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (split_part(name, '/', 1) = (select auth.uid())::text or public.is_admin())
  );
