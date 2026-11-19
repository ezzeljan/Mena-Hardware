-- =============================================================================
-- Migration: 20261118000013_project_reference_no.sql
-- Purpose: Store the project Reference No. (e.g. "SV002") in its own column.
--   Until now the create form saved it inside the name ("SV002 — McLaren St").
--   Existing names in that form are split into reference_no + name.
-- =============================================================================

alter table public.projects
  add column if not exists reference_no text not null default '';

-- Split "<ref> — <name>": em dash with spaces; the ref is one word of up to
-- 40 characters containing a digit (SV002, P-1043), so names like
-- "Tower — East Wing" are left alone.
update public.projects
set reference_no = substring(name from '^(\S{0,39}\d\S{0,39}) — '),
    name = btrim(regexp_replace(name, '^\S{0,39}\d\S{0,39} — ', ''))
where reference_no = ''
  and name ~ '^\S{0,39}\d\S{0,39} — \S'
  and length(substring(name from '^(\S+) — ')) <= 40;

create index if not exists idx_projects_reference_no on public.projects (reference_no);
