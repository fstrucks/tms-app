-- documents.user_id references public.profiles(id) in the live schema.
-- Invited users had no profiles row, which broke uploads (documents_user_id_fkey).
-- Backfill existing users and create a profile automatically for every new auth user.
-- Already applied manually in production on 2026-10-10; safe to re-run.

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
