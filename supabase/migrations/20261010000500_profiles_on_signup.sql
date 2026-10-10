-- documents.user_id references public.profiles(id) in the live schema.
-- Invited users had no profiles row, which broke uploads (documents_user_id_fkey).
-- Backfill existing users and create a profile automatically for every new auth user.
-- Already applied manually in production on 2026-10-10; safe to re-run.
--
-- Schema drift (intentional, documented): public.profiles and its RLS were created in prod
-- outside this repo, and prod's documents_user_id_fkey points at public.profiles(id), while
-- 20261010000050 (create table if not exists, a no-op in prod) references auth.users.
-- Requires profiles.id to be the primary key, and no other NOT NULL columns without defaults
-- (otherwise this trigger would make invites fail).

insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

revoke execute on function public.handle_new_user() from public, anon, authenticated;
