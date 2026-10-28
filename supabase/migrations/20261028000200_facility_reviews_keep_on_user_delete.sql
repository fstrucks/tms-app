-- Facility reviews and notes survive user deletion. NOT APPLIED: for review first. Idempotent; no data changes.
-- Before: facility_reviews.author_id and facility_notes.author_id were NOT NULL ... ON DELETE CASCADE, so deleting a
-- sign-in deleted that person's reviews and notes. Their reports (reporter_id) cascaded the same way.
-- After: the columns are nullable with ON DELETE SET NULL. Deleting a user keeps the review / note with author_id = null
-- (and the report with reporter_id = null). Nothing else changes:
--   * The public reads (facility_summaries, facility_public_reviews, facility_public_notes, facility_wait_stats) never
--     return author_id or company_id, so other users still never see who wrote a review.
--   * Clients still have no table grants or policies on these tables; the server filters "my review" by
--     author_id = caller, which never matches a null author, so an orphaned review belongs to nobody.
--   * unique (stop_id, author_id) allows any number of null-author rows (Postgres NULLs are distinct).
-- Overlap: draft PR #161 (account deletion) makes the same change through account_deletion_retarget_fk and uses the
-- same constraint names, so either migration can run first and the other is a no-op in effect.
begin;

do $$
declare t record; c name;
begin
  for t in select * from (values
    ('facility_reviews', 'author_id'), ('facility_notes', 'author_id'),
    ('facility_review_reports', 'reporter_id'), ('facility_note_reports', 'reporter_id')) v(tbl, col)
  loop
    if to_regclass('public.' || t.tbl) is null then continue; end if;
    execute format('alter table public.%I alter column %I drop not null', t.tbl, t.col);
    for c in
      select con.conname from pg_constraint con
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
       where con.conrelid = format('public.%I', t.tbl)::regclass and con.contype = 'f' and a.attname = t.col
    loop
      execute format('alter table public.%I drop constraint %I', t.tbl, c);
    end loop;
    execute format('alter table public.%I add constraint %I foreign key (%I) references auth.users(id) on delete set null',
      t.tbl, t.tbl || '_' || t.col || '_fkey', t.col);
  end loop;
end $$;

commit;
