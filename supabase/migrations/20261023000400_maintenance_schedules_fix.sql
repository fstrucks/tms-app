-- Run after 20261023000300_maintenance_schedules.sql. Safe to run more than once.
-- Fixes from QA of the maintenance schedules release:
--   1. pm_today(truck): "today" in the company time zone (America/Chicago when none is stored). Replaces pm_la_today.
--   2. pm_status_for: same rules, written with whole-number math (10% of interval miles, or 14 days) and pm_today.
--   3. pm_schedules trigger: a suggested schedule always takes its intervals from its template.
--   4. pm_setup_schedules: on rerun, removes suggested schedules the new engine no longer lists, re-points the rest,
--      and keeps custom schedules.
--   5. pm_save_baseline: owner-only save of setup's "last done" visits. A rerun replaces the earlier setup entry for a
--      service instead of adding a second one. One-time cleanup of baseline duplicates already saved.

do $$
begin
  if to_regclass('public.pm_schedules') is null or to_regprocedure('public.pm_status_for(uuid,date)') is null
     or to_regprocedure('public.pm_suggest(text,text,text,numeric)') is null then
    raise exception 'Run 20261023000300_maintenance_schedules.sql first.';
  end if;
end $$;

-- 1. Today for a truck's company. Uses a time zone column on company_profiles if one exists and holds a valid name.
create or replace function public.pm_today(p_truck uuid default null)
returns date language plpgsql stable security definer set search_path = public as $$
declare v_owner uuid; v_col text; v_tz text;
begin
  if p_truck is not null then
    select t.user_id into v_owner from public.trucks t where t.id = p_truck and public.maint_can_see(t.user_id, t.id);
  end if;
  if v_owner is not null then
    select c.column_name into v_col from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'company_profiles' and c.column_name in ('time_zone', 'timezone')
     order by c.column_name limit 1;
    if v_col is not null then
      execute format('select %I::text from public.company_profiles where owner_id = $1 order by created_at limit 1', v_col)
        into v_tz using v_owner;
    end if;
  end if;
  if v_tz is null or not exists (select 1 from pg_timezone_names where name = v_tz) then v_tz := 'America/Chicago'; end if;
  return (now() at time zone v_tz)::date;
end $$;

-- 2. Status. Due soon: miles left <= 10% of the interval (ml * 10 <= interval), or 14 days or fewer left.
create or replace function public.pm_status_for(p_truck uuid, p_today date default null)
returns table (schedule_id uuid, service_type text, interval_miles integer, interval_days integer, source text, template_id uuid,
  source_title text, as_of_date date, is_generic boolean, template_notes text,
  last_done_date date, last_done_odometer integer, next_due_odometer integer, next_due_date date,
  miles_left integer, days_left integer, status text)
language sql stable security definer set search_path = public as $$
  with tr as (
    select t.id, t.user_id, t.odometer, coalesce(p_today, public.pm_today(t.id)) today
      from public.trucks t where t.id = p_truck and public.maint_can_see(t.user_id, t.id)
  ), s as (
    select ps.*, tr.odometer truck_odo, tr.today,
           (select r.service_date from public.service_record_items i join public.service_records r on r.id = i.service_record_id
             where r.truck_id = ps.truck_id and i.service_type = ps.service_type order by r.service_date desc, r.odometer desc nulls last limit 1) ld,
           (select r.odometer from public.service_record_items i join public.service_records r on r.id = i.service_record_id
             where r.truck_id = ps.truck_id and i.service_type = ps.service_type and r.odometer is not null
             order by r.service_date desc, r.odometer desc limit 1) lo
      from public.pm_schedules ps join tr on tr.id = ps.truck_id
  ), d as (
    select s.*, s.lo + s.interval_miles ndo, s.ld + s.interval_days ndd,
           s.lo + s.interval_miles - s.truck_odo ml, (s.ld + s.interval_days) - s.today dl
      from s
  )
  select d.id, d.service_type, d.interval_miles, d.interval_days, d.source, d.template_id,
         m.source_title, m.as_of_date, coalesce(m.is_generic, false), m.notes,
         d.ld, d.lo, d.ndo, d.ndd, d.ml, d.dl,
         case
           when d.ld is null then coalesce(d.start_state, 'unknown')
           when d.interval_miles is null and d.interval_days is null then 'unknown'
           when d.ml < 0 or d.dl < 0 then 'overdue'
           when d.ml::bigint * 10 <= d.interval_miles or d.dl <= 14 then 'due_soon'
           when d.ml is null and d.dl is null then 'unknown'   -- miles-only interval but no odometer reading
           else 'ok' end
    from d left join public.maintenance_interval_templates m on m.id = d.template_id
   order by d.service_type;
$$;
drop function if exists public.pm_la_today();

-- 3. Trigger: suggested schedules mirror their template (via pm_suggest, so "follows another service" rules apply).
create or replace function public.pm_schedules_before()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_truck record; v_mi integer; v_days integer; v_found boolean := false;
begin
  select * into v_truck from public.trucks where id = new.truck_id;
  if v_truck.id is null then raise exception 'truck_not_found' using errcode = '23503'; end if;
  if tg_op = 'UPDATE' and new.truck_id is distinct from old.truck_id then raise exception 'truck_locked' using errcode = '42501'; end if;
  new.owner_id := v_truck.user_id;
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by; new.created_at := old.created_at; new.updated_at := now();
    -- A client edit of the numbers turns a suggestion into a custom schedule.
    if (new.interval_miles is distinct from old.interval_miles or new.interval_days is distinct from old.interval_days)
       and new.source = 'suggested' and new.template_id is not distinct from old.template_id and current_setting('pm.refresh', true) is distinct from 'on' then
      new.source := 'custom';
    end if;
  end if;
  if new.source = 'suggested' and new.template_id is not null then
    select s.interval_miles, s.interval_days, true into v_mi, v_days, v_found
      from public.pm_suggest(v_truck.engine_make, v_truck.engine_model, v_truck.duty_cycle, v_truck.mpg) s
     where s.template_id = new.template_id and s.service_type = new.service_type limit 1;
    if not coalesce(v_found, false) then
      select m.interval_miles, m.interval_days, true into v_mi, v_days, v_found
        from public.maintenance_interval_templates m where m.id = new.template_id and m.service_type = new.service_type;
    end if;
    if not coalesce(v_found, false) then raise exception 'template_mismatch' using errcode = '22023'; end if;
    new.interval_miles := v_mi; new.interval_days := v_days;
  end if;
  return new;
end $$;

-- 4. Setup (and rerun after an engine change).
create or replace function public.pm_setup_schedules(p_truck uuid, p_start jsonb default '{}'::jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare t record; n integer;
begin
  select * into t from public.trucks where id = p_truck;
  if t.id is null or coalesce(public.maint_role(t.user_id) in ('owner', 'management'), false) is false then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  perform set_config('pm.refresh', 'on', true);
  -- Suggested schedules for services the current engine (or the generic list) no longer has.
  delete from public.pm_schedules ps
   where ps.truck_id = p_truck and ps.source = 'suggested'
     and not exists (select 1 from public.pm_suggest(t.engine_make, t.engine_model, t.duty_cycle, t.mpg) s where s.service_type = ps.service_type);
  insert into public.pm_schedules (truck_id, owner_id, service_type, interval_miles, interval_days, source, template_id, start_state)
  select p_truck, t.user_id, s.service_type, s.interval_miles, s.interval_days, 'suggested', s.template_id,
         case when p_start ? s.service_type and p_start->>s.service_type in ('due', 'unknown') then p_start->>s.service_type end
    from public.pm_suggest(t.engine_make, t.engine_model, t.duty_cycle, t.mpg) s
  on conflict (truck_id, service_type) do update
     set interval_miles = excluded.interval_miles, interval_days = excluded.interval_days, template_id = excluded.template_id,
         start_state = coalesce(excluded.start_state, public.pm_schedules.start_state)
   where public.pm_schedules.source = 'suggested';
  get diagnostics n = row_count;
  perform set_config('pm.refresh', 'off', true);
  return n;
end $$;

-- 5. Baseline visits from setup. p_groups: [{ "service_date": "YYYY-MM-DD", "odometer": 123 | null, "items": ["oil_filter", ...] }]
-- For each listed service, earlier baseline entries on this truck are removed first, then one entry is saved.
-- A baseline visit left with no services is removed unless it has receipts. Logged visits are never touched.
create or replace function public.pm_save_baseline(p_truck uuid, p_groups jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare t record; g jsonb; v_types text[]; v_date date; v_odo integer; v_rec uuid; v_touched uuid[] := '{}'; v_today date; n integer := 0;
begin
  select * into t from public.trucks where id = p_truck;
  if t.id is null or public.maint_role(t.user_id) is distinct from 'owner' then raise exception 'not_allowed' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_groups, '[]'::jsonb)) <> 'array' then raise exception 'bad_input' using errcode = '22023'; end if;
  v_today := public.pm_today(p_truck);
  for g in select * from jsonb_array_elements(coalesce(p_groups, '[]'::jsonb)) loop
    select coalesce(array_agg(distinct x), '{}') into v_types from jsonb_array_elements_text(coalesce(g->'items', '[]'::jsonb)) x;
    continue when cardinality(v_types) = 0;
    v_date := (g->>'service_date')::date;
    v_odo := nullif(g->>'odometer', '')::integer;
    if v_date is null or v_date > v_today then raise exception 'bad_date' using errcode = '22023'; end if;
    if v_odo is not null and (v_odo < 0 or (t.odometer is not null and v_odo > t.odometer)) then raise exception 'bad_odometer' using errcode = '22023'; end if;
    with del as (
      delete from public.service_record_items i using public.service_records r
       where r.id = i.service_record_id and r.truck_id = p_truck and r.entry_source = 'baseline' and i.service_type = any(v_types)
      returning r.id)
    select v_touched || coalesce(array_agg(distinct id), '{}') into v_touched from del;
    select r.id into v_rec from public.service_records r
     where r.truck_id = p_truck and r.entry_source = 'baseline' and r.service_date = v_date and r.odometer is not distinct from v_odo
     order by r.created_at limit 1;
    if v_rec is null then
      insert into public.service_records (truck_id, owner_id, service_date, odometer, entry_source, add_to_expenses, total_cost, notes)
      values (p_truck, t.user_id, v_date, v_odo, 'baseline', false, 0, 'Recorded during truck setup') returning id into v_rec;
    end if;
    insert into public.service_record_items (service_record_id, service_type) select v_rec, x from unnest(v_types) x;
    n := n + 1;
  end loop;
  delete from public.service_records r
   where r.id = any(v_touched) and r.entry_source = 'baseline'
     and not exists (select 1 from public.service_record_items i where i.service_record_id = r.id)
     and not exists (select 1 from public.documents d where d.service_record_id = r.id);
  return n;
end $$;

-- One-time cleanup: keep only the newest baseline entry per truck and service (by date, then miles, then save time).
with ranked as (
  select i.id, row_number() over (partition by r.truck_id, i.service_type
           order by r.service_date desc, r.odometer desc nulls last, r.created_at desc, i.id desc) rn
    from public.service_record_items i join public.service_records r on r.id = i.service_record_id
   where r.entry_source = 'baseline'
), gone as (
  delete from public.service_record_items i using ranked where ranked.id = i.id and ranked.rn > 1 returning i.service_record_id
)
delete from public.service_records r
 where r.id in (select service_record_id from gone) and r.entry_source = 'baseline'
   and not exists (select 1 from public.service_record_items i where i.service_record_id = r.id and i.id not in (select id from ranked where rn > 1))
   and not exists (select 1 from public.documents d where d.service_record_id = r.id);

do $$
declare f text;
begin
  foreach f in array array['pm_today(uuid)', 'pm_status_for(uuid,date)', 'pm_setup_schedules(uuid,jsonb)', 'pm_save_baseline(uuid,jsonb)'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function public.%s to authenticated', f); end if;
  end loop;
  execute 'revoke all on function public.pm_schedules_before() from public';
end $$;
