-- =============================================================================
-- SQL Test Suite: profile photos and self-service profile edits (migration 015)
--   1. A user edits their own name and photo via update_my_profile; their role
--      cannot change and they cannot edit other people's profiles directly.
--   2. Admins can rename other users but cannot change their photos.
--   3. Avatar files: users write only in their own folder; admins can delete.
--   4. profile_directory exposes avatar_url to signed-in users.
-- =============================================================================

begin;

do $$
declare
  v_admin uuid := '00000000-0000-0000-0000-000000000041';
  v_alice uuid := '00000000-0000-0000-0000-000000000042';
  v_bob uuid := '00000000-0000-0000-0000-000000000043';
  v_err boolean;
  v_count integer;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 'a.admin@mena.local', '{"full_name": "A Admin"}'),
    (v_alice, 'alice@mena.local', '{"full_name": "Alice"}'),
    (v_bob, 'bob@mena.local', '{"full_name": "Bob"}');
  update public.profiles set role = 'admin' where id = v_admin;
  update public.profiles set role = 'estimator' where id in (v_alice, v_bob);
  insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)
  on conflict (id) do nothing;

  execute 'set local role authenticated';

  -- 1. Alice edits her own name and photo.
  perform set_config('request.jwt.claims', json_build_object('sub', v_alice, 'role', 'authenticated')::text, true);
  perform public.update_my_profile('  Alice Tan  ', 'https://x.supabase.co/storage/v1/object/public/avatars/' || v_alice || '/a.webp');
  if (select full_name from public.profiles where id = v_alice) <> 'Alice Tan'
     or (select avatar_url from public.profiles where id = v_alice) not like '%/a.webp'
     or (select role from public.profiles where id = v_alice) <> 'estimator' then
    raise exception 'TEST FAILED: update_my_profile must set own name and photo only!';
  end if;

  v_err := false;
  begin
    perform public.update_my_profile('   ', null);
  exception when others then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: An empty name must be refused!';
  end if;

  -- Alice cannot edit Bob (or her own role) with a direct update.
  update public.profiles set full_name = 'Hacked' where id = v_bob;
  update public.profiles set role = 'admin' where id = v_alice;
  execute 'reset role';
  if (select full_name from public.profiles where id = v_bob) <> 'Bob'
     or (select role from public.profiles where id = v_alice) <> 'estimator' then
    raise exception 'TEST FAILED: Non-admins must not edit profiles directly!';
  end if;
  execute 'set local role authenticated';

  -- 4. Everyone signed in sees photos in the directory.
  if (select avatar_url from public.profile_directory where id = v_alice) is null then
    raise exception 'TEST FAILED: profile_directory must expose avatar_url!';
  end if;

  -- 3. Avatar files: own folder only.
  insert into storage.objects (bucket_id, name) values ('avatars', v_alice || '/a.webp');
  v_err := false;
  begin
    insert into storage.objects (bucket_id, name) values ('avatars', v_bob || '/fake.webp');
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Users must not upload into someone else''s avatar folder!';
  end if;

  -- 2. Admin renames Bob but cannot change Bob's photo.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  update public.profiles set full_name = 'Bob Lee' where id = v_bob;
  if (select full_name from public.profiles where id = v_bob) <> 'Bob Lee' then
    raise exception 'TEST FAILED: Admins should be able to rename users!';
  end if;
  v_err := false;
  begin
    update public.profiles set avatar_url = 'https://evil.example/x.png' where id = v_bob;
  exception when insufficient_privilege then
    v_err := true;
  end;
  if not v_err then
    raise exception 'TEST FAILED: Admins must not change other users'' photos!';
  end if;

  -- Bob cannot delete Alice's file; the admin can.
  perform set_config('request.jwt.claims', json_build_object('sub', v_bob, 'role', 'authenticated')::text, true);
  delete from storage.objects where bucket_id = 'avatars' and name = v_alice || '/a.webp';
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  select count(*) into v_count from storage.objects where bucket_id = 'avatars' and name = v_alice || '/a.webp';
  if v_count <> 1 then
    raise exception 'TEST FAILED: Users must not delete other users'' avatar files!';
  end if;
  delete from storage.objects where bucket_id = 'avatars' and name = v_alice || '/a.webp';
  select count(*) into v_count from storage.objects where bucket_id = 'avatars' and name = v_alice || '/a.webp';
  if v_count <> 0 then
    raise exception 'TEST FAILED: Admins should be able to delete avatar files!';
  end if;

  execute 'reset role';
  raise notice 'ALL PROFILE & AVATAR SQL TESTS PASSED.';
end $$;

rollback;
