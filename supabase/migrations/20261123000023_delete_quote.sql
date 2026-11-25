-- =============================================================================
-- Migration: 20261123000023_delete_quote.sql
--
-- delete_quote(p_quote_id): an estimator assigned to the project (or an admin)
-- deletes a builder's quote with all its versions, supplier sheets, door
-- groups, lines and comments, e.g. when the builder drops out of the tender.
--
-- Not allowed:
--   - once the project is awarded (the decision is final; the winning quote
--     and the read-only others stay as the record),
--   - while one of the quote's versions is waiting for PM review.
--
-- The deletion is logged in the project's activity (the uploaded quotation
-- files stay in storage).
-- =============================================================================

create or replace function public.delete_quote(p_quote_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.hardware_quotes;
  v_stage text;
  v_versions integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select * into v_quote from public.hardware_quotes where id = p_quote_id for update;
  if not found then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;

  if not public.can_edit_project_content(v_quote.project_id) then
    raise exception 'Only an estimator assigned to this project (or an admin) can delete its quotes'
      using errcode = '42501';
  end if;

  select stage into v_stage from public.projects where id = v_quote.project_id;
  if v_stage = 'awarded' then
    raise exception 'The project has been awarded, so its quotes can no longer be deleted'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.project_versions
    where quote_id = p_quote_id and status = 'submitted'
  ) then
    raise exception 'A version of this quote is waiting for PM review. Delete it after the PM approves or requests changes.'
      using errcode = '22023';
  end if;

  select count(*) into v_versions from public.project_versions where quote_id = p_quote_id;

  perform public.log_project_activity(
    v_quote.project_id, null, 'quotation', 'quote_deleted',
    'deleted ' || v_quote.builder_name || '''s quote'
      || case when v_versions > 0 then ' (' || v_versions || ' version' || case when v_versions = 1 then '' else 's' end || ')' else '' end,
    jsonb_build_object('builder', v_quote.builder_name, 'versions', v_versions, 'quote_id', p_quote_id)
  );

  -- Versions, sheets, door groups, lines, comments and notifications cascade.
  delete from public.hardware_quotes where id = p_quote_id;
end;
$$;

revoke all on function public.delete_quote(uuid) from public, anon;
grant execute on function public.delete_quote(uuid) to authenticated;
