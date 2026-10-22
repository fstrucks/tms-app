-- Follow-up to 20261022150000 (already applied). Fix: a rate con emailed to a Management / Dispatch member's own
-- ratecon address, on a row without inbound_emails.company_id (written by the pre-#127 webhook, which tagged only
-- owner addresses), resolved to no company, so the owner and the rest of the office team didn't see it.
-- Now the fallback also finds the receiver's company through company_members (any role). Function body only;
-- same signature, so existing grants / revokes and the policies that use it are unchanged. Idempotent.
create or replace function public.email_doc_company(p_inbound uuid, p_user uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select e.company_id from public.inbound_emails e where e.id = p_inbound and e.company_id is not null),
    (select p.id from public.company_profiles p where p.owner_id = p_user order by p.created_at limit 1),
    (select m.profile_id from public.company_members m where m.user_id = p_user
      order by (m.role in ('owner', 'management', 'dispatcher')) desc, m.created_at limit 1));
$$;
