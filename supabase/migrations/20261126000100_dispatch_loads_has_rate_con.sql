-- Follow-up to 20261018000700 (already applied in prod; that file is not edited).
-- Dispatch has_rate_con was true only when the load OWNER had uploaded a rate confirmation.
-- The load page lists every rate_confirmation linked to the load that the viewer may see
-- (uploader on the company, storage path in that uploader's folder). The Dispatch Rate con
-- button follows the same rule, so the flag was wrong when only a teammate had uploaded one
-- (the button stayed hidden).
--
-- ADDITIVE ONLY: create or replace public.dispatch_loads with the same signature
-- (p_load uuid default null), returns setof jsonb, language sql stable, security
-- definer, and search_path = public. The only change is has_rate_con: true when any
-- rate_confirmation linked to the load was uploaded by the load owner or a member of
-- that company, and the storage path is in that uploader's folder
-- ({user_id}/{timestamp}-{name}, same as the load page / scanUpload). An unrelated
-- company's document is ignored. Role checks are unchanged: management and
-- dispatchers only; drivers and the owner still get no rows.
--
-- No table, column, policy, or data changes. The revoke/grant is repeated below.
-- Idempotent: safe to run again. Not applied from the app: Sam reviews, Dakota applies.

begin;

create or replace function public.dispatch_loads(p_load uuid default null)
returns setof jsonb
language sql stable security definer set search_path = public as $$
  select (to_jsonb(l) - 'user_id' - 'route_geometry')
         || jsonb_build_object(
              'owner_id', l.user_id,
              'viewer_role', public.load_viewer_role(l.user_id),
              'has_rate_con', exists (
                 select 1 from public.documents d
                  where d.load_id = l.id
                    and d.doc_type = 'rate_confirmation'
                    and d.user_id is not null
                    and d.file_path is not null
                    and starts_with(d.file_path, d.user_id::text || '/')
                    and (
                      d.user_id = l.user_id
                      or exists (
                        select 1
                          from public.company_members m
                          join public.company_profiles p on p.id = m.profile_id
                         where m.user_id = d.user_id
                           and p.owner_id = l.user_id
                      )
                    )
              ),
              'stops', coalesce((select jsonb_agg(to_jsonb(s) - 'geocode_address' order by s.sequence)
                                   from public.stops s where s.load_id = l.id), '[]'::jsonb))
    from public.loads l
   where (p_load is null or l.id = p_load)
     and public.load_viewer_role(l.user_id) in ('management', 'dispatcher')
   order by l.created_at desc;
$$;
revoke execute on function public.dispatch_loads(uuid) from public, anon;
grant execute on function public.dispatch_loads(uuid) to authenticated;

commit;
