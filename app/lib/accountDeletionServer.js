// Session-checked account deletion. The signed-in user comes from auth.getUser(token).
// A user id in the request body is ignored. Database changes run as the service role through
// public.account_deletion_apply, which only the service role may execute.

import { bearer, userClient, serviceClient, isAuthRejection, isAuthUnavailable } from './packetServer.js';
import {
  DOCUMENTS_BUCKET, FORMER_MEMBER_LABEL, GRACE_DAYS, SUPPORT_EMAIL,
  cancelledMessage, confirmationMatches, cronAuthorized, deletionKind, isDemoCompany,
  memberWarnings, ownerWarnings, purgeAfter, scheduledMessage, shouldCancelOnSignIn,
} from './accountDeletion.js';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const missing = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || e.code === 'PGRST204' || /does not exist|Could not find the|schema cache/i.test(e.message || ''));
const SETUP = `Deleting an account isn’t available yet. Email ${SUPPORT_EMAIL} and we’ll delete it for you.`;

async function caller(req, deps) {
  const token = bearer(req);
  if (!token) return { error: json({ error: 'Sign in first.' }, 401) };
  const uc = (deps.mkUserClient || userClient)(token);
  let data, error;
  try { ({ data, error } = await uc.auth.getUser(token)); }
  catch (e) { return { error: json({ error: 'Couldn’t check your sign-in just now. Try again.' }, 503) }; }
  if (error && (isAuthUnavailable(error) || !isAuthRejection(error))) return { error: json({ error: 'Couldn’t check your sign-in just now. Try again.' }, 503) };
  if (error || !data?.user?.id) return { error: json({ error: 'Your sign-in expired. Please sign in again.' }, 401) };
  return { user: data.user };
}

function adminOf(deps) {
  return deps.admin || (deps.mkService ? deps.mkService() : serviceClient());
}

async function ownedProfile(admin, userId) {
  const cols = 'id, owner_id, legal_name, dba_name, is_demo';
  let res = await admin.from('company_profiles').select(cols).eq('owner_id', userId).maybeSingle();
  if (res.error && /is_demo/.test(res.error.message || '')) {
    res = await admin.from('company_profiles').select('id, owner_id, legal_name, dba_name').eq('owner_id', userId).maybeSingle();
    if (res.data) res.data.is_demo = false;
  }
  return res;
}

async function openRequest(admin, userId) {
  return admin.from('account_deletion_requests').select('*').eq('user_id', userId).is('cancelled_at', null).is('completed_at', null).maybeSingle();
}

function shapeStatus({ user, profile, pending, cancelled }) {
  const owns = !!profile?.id;
  const demo = owns && isDemoCompany(profile);
  const kind = deletionKind({ ownsCompany: owns, demo });
  return {
    email: user.email || null,
    role: owns ? 'owner' : 'member',
    company_name: profile?.legal_name || profile?.dba_name || null,
    company_profile_id: profile?.id || null,
    demo,
    grace_days: kind.graceDays,
    immediate: kind.immediate,
    former_label: FORMER_MEMBER_LABEL,
    support_email: SUPPORT_EMAIL,
    warnings: owns ? ownerWarnings({ companyName: profile?.legal_name || profile?.dba_name, graceDays: GRACE_DAYS, demo }) : memberWarnings(),
    pending: pending ? { kind: pending.kind, purge_after: pending.purge_after, company_profile_id: pending.company_profile_id || null } : null,
    cancelled: !!cancelled,
    message: cancelled ? cancelledMessage() : null,
  };
}

async function cancelOpen(admin, userId, reason) {
  return admin.from('account_deletion_requests').update({
    cancelled_at: new Date().toISOString(),
    cancel_reason: reason,
  }).eq('user_id', userId).is('cancelled_at', null).is('completed_at', null);
}

export async function getAccountDeletion(req, deps = {}) {
  const who = await caller(req, deps);
  if (who.error) return who.error;
  const admin = adminOf(deps);
  if (!admin) return json({ error: SETUP, setupNeeded: true }, 503);
  const owned = await ownedProfile(admin, who.user.id);
  if (owned.error && missing(owned.error)) return json({ error: SETUP, setupNeeded: true }, 503);
  if (owned.error) return json({ error: 'Couldn’t check your company. Try again.' }, 500);
  let pendingRes = await openRequest(admin, who.user.id);
  if (pendingRes.error && missing(pendingRes.error)) return json({ error: SETUP, setupNeeded: true }, 503);
  if (pendingRes.error) return json({ error: 'Couldn’t check a scheduled deletion. Try again.' }, 500);
  let pending = pendingRes.data || null;
  let cancelled = false;
  if (pending && shouldCancelOnSignIn({ baselineSignInAt: pending.baseline_sign_in_at, currentSignInAt: who.user.last_sign_in_at })) {
    const upd = await cancelOpen(admin, who.user.id, 'signed_in');
    if (upd.error) return json({ error: 'Couldn’t cancel the scheduled deletion. Try again.' }, 500);
    pending = null;
    cancelled = true;
  }
  return json(shapeStatus({ user: who.user, profile: owned.data, pending, cancelled }));
}

async function insertRequest(admin, row) {
  return admin.from('account_deletion_requests').insert(row).select('*').maybeSingle();
}

export async function postAccountDeletion(req, deps = {}) {
  const who = await caller(req, deps);
  if (who.error) return who.error;
  const admin = adminOf(deps);
  if (!admin) return json({ error: SETUP, setupNeeded: true }, 503);
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  // Never trust a user id from the client. The session user is the only id used below.
  const intent = body?.intent === 'cancel' ? 'cancel' : 'delete';
  const owned = await ownedProfile(admin, who.user.id);
  if (owned.error && missing(owned.error)) return json({ error: SETUP, setupNeeded: true }, 503);
  if (owned.error) return json({ error: 'Couldn’t check your company. Try again.' }, 500);
  const profile = owned.data || null;
  const open = await openRequest(admin, who.user.id);
  if (open.error && missing(open.error)) return json({ error: SETUP, setupNeeded: true }, 503);
  if (open.error) return json({ error: 'Couldn’t check a scheduled deletion. Try again.' }, 500);

  if (intent === 'cancel') {
    if (!open.data) return json({ ok: true, cancelled: false, message: null });
    const upd = await cancelOpen(admin, who.user.id, 'cancelled');
    if (upd.error) return json({ error: 'Couldn’t cancel the scheduled deletion. Try again.' }, 500);
    return json({ ok: true, cancelled: true, message: 'Company deletion was cancelled. The company will be kept.' });
  }

  if (!confirmationMatches(body?.confirm, who.user.email)) {
    return json({ error: 'Type DELETE or your email to confirm.' }, 400);
  }
  const demo = !!(profile && isDemoCompany(profile));
  const plan = deletionKind({ ownsCompany: !!profile, demo });
  if (!plan.immediate) {
    if (open.data) {
      return json({
        ok: true, scheduled: true, already: true,
        purge_after: open.data.purge_after,
        message: scheduledMessage({ purgeAt: open.data.purge_after, companyName: profile?.legal_name || profile?.dba_name }),
      }, 200);
    }
    const at = purgeAfter(new Date());
    const ins = await insertRequest(admin, {
      user_id: who.user.id,
      company_profile_id: profile.id,
      kind: 'company',
      purge_after: at.toISOString(),
      baseline_sign_in_at: who.user.last_sign_in_at || null,
    });
    if (ins.error && missing(ins.error)) return json({ error: SETUP, setupNeeded: true }, 503);
    if (ins.error) return json({ error: 'Couldn’t schedule the deletion. Try again.' }, 500);
    return json({
      ok: true, scheduled: true, immediate: false, grace_days: GRACE_DAYS,
      purge_after: at.toISOString(), sign_out: true,
      message: scheduledMessage({ purgeAt: at.toISOString(), companyName: profile?.legal_name || profile?.dba_name }),
    });
  }

  if (!open.data) {
    const ins = await insertRequest(admin, {
      user_id: who.user.id,
      company_profile_id: profile?.id || null,
      kind: plan.kind,
      purge_after: new Date(Date.now() - 1000).toISOString(),
      baseline_sign_in_at: who.user.last_sign_in_at || null,
    });
    if (ins.error && missing(ins.error)) return json({ error: SETUP, setupNeeded: true }, 503);
    if (ins.error && ins.error.code !== '23505') return json({ error: 'Couldn’t start the deletion. Try again.' }, 500);
  }
  const ran = await executeAccountDeletion(admin, who.user.id, deps);
  if (ran.status) return json(ran.body, ran.status);
  await admin.from('account_deletion_requests').update({ completed_at: new Date().toISOString() }).eq('user_id', who.user.id).is('completed_at', null).is('cancelled_at', null);
  return json({
    ok: true, deleted: true, immediate: true, sign_out: true,
    mode: plan.kind, demo,
    message: plan.kind === 'company'
      ? 'The company and your sign-in have been deleted.'
      : 'Your sign-in has been deleted. Company records you worked on were kept.',
  });
}

export async function executeAccountDeletion(admin, userId, deps = {}) {
  let rpc;
  try { rpc = await admin.rpc('account_deletion_apply', { p_user: userId }); }
  catch (e) { return { status: 500, body: { error: 'Couldn’t delete the account. Try again.' } }; }
  if (rpc?.error) {
    if (missing(rpc.error)) return { status: 503, body: { error: SETUP, setupNeeded: true } };
    if (/grace_period|grace_required/.test(rpc.error.message || '')) return { status: 409, body: { error: 'This company is still in the waiting period.' } };
    console.error('[account-deletion] apply', rpc.error.code || '', String(rpc.error.message || '').slice(0, 200));
    return { status: 500, body: { error: 'Couldn’t delete the account. Try again.' } };
  }
  const plan = rpc?.data || {};
  const storage = await (deps.applyStorage || applyStoragePlan)(admin, plan);
  if (storage?.error) return { status: 500, body: { error: 'Account data was updated, but file cleanup did not finish. It will be tried again.', partial: true } };
  const ids = Array.isArray(plan.auth_user_ids) && plan.auth_user_ids.length ? plan.auth_user_ids : [userId];
  const gone = await (deps.deleteAuthUsers || deleteAuthUsers)(admin, ids);
  if (gone?.error) return { status: 500, body: { error: 'Account data was updated, but the sign-in could not be removed yet. It will be tried again.', partial: true } };
  return { ok: true, plan };
}

export async function listStoragePrefix(bucket, prefix) {
  const paths = [];
  async function walk(dir) {
    for (let offset = 0; offset < 20000; offset += 1000) {
      const { data, error } = await bucket.list(dir, { limit: 1000, offset });
      if (error) return { error };
      const rows = data || [];
      for (const item of rows) {
        if (!item?.name) continue;
        const path = dir ? `${dir}/${item.name}` : item.name;
        const folder = item.id == null && item.metadata == null;
        if (folder) {
          const sub = await walk(path);
          if (sub?.error) return sub;
        } else paths.push(path);
      }
      if (rows.length < 1000) break;
    }
    return { ok: true };
  }
  const root = String(prefix || '').replace(/^\/+|\/+$/g, '');
  const walked = await walk(root);
  if (walked?.error) return { error: walked.error, paths };
  return { paths };
}

async function markJob(admin, id) {
  if (!id || !admin?.from) return;
  try { await admin.from('account_deletion_storage_jobs').update({ done_at: new Date().toISOString() }).eq('id', id); } catch { /* retry will run it again */ }
}

export async function applyStoragePlan(admin, plan) {
  const bucket = admin?.storage?.from?.(DOCUMENTS_BUCKET);
  if (!bucket) return { error: { message: 'storage_unavailable' } };
  const jobs = Array.isArray(plan?.jobs) ? plan.jobs : [];
  const order = { move: 0, delete_path: 1, delete_prefix: 2 };
  const sorted = [...jobs].sort((a, b) => (order[a.op] ?? 9) - (order[b.op] ?? 9));
  let moved = 0;
  let removed = 0;
  for (const job of sorted) {
    if (job.done_at) continue;
    if (job.op === 'move' && job.from_path && job.to_path && job.from_path !== job.to_path) {
      let err = null;
      if (typeof bucket.copy === 'function') {
        const c = await bucket.copy(job.from_path, job.to_path);
        err = c?.error || null;
        if (err && /already exists|duplicate/i.test(err.message || '')) err = null;
      } else {
        const dl = await bucket.download(job.from_path);
        if (dl?.error || !dl?.data) err = dl?.error || { message: 'download_failed' };
        else {
          const up = await bucket.upload(job.to_path, dl.data, { upsert: true });
          err = up?.error || null;
        }
      }
      if (err) return { error: err };
      moved += 1;
      await markJob(admin, job.id);
      continue;
    }
    if (job.op === 'delete_path' && job.from_path) {
      const rm = await bucket.remove([job.from_path]);
      if (rm?.error) return { error: rm.error };
      removed += 1;
      await markJob(admin, job.id);
      continue;
    }
    if (job.op === 'delete_prefix' && job.from_path) {
      const listed = await listStoragePrefix(bucket, job.from_path);
      if (listed.error) return { error: listed.error };
      const paths = listed.paths || [];
      for (let i = 0; i < paths.length; i += 100) {
        const chunk = paths.slice(i, i + 100);
        if (!chunk.length) continue;
        const rm = await bucket.remove(chunk);
        if (rm?.error) return { error: rm.error };
        removed += chunk.length;
      }
      await markJob(admin, job.id);
    }
  }
  return { ok: true, moved, removed };
}

export async function deleteAuthUsers(admin, ids) {
  const deleted = [];
  for (const id of ids || []) {
    if (!id) continue;
    let error = null;
    try {
      const res = await admin.auth.admin.deleteUser(id);
      error = res?.error || null;
    } catch (e) { error = e; }
    if (error && !/not found|user_not_found/i.test(error.message || '')) return { error, deleted };
    deleted.push(id);
  }
  return { ok: true, deleted };
}

export async function runDueDeletions(admin, deps = {}, now = new Date()) {
  const due = await admin.from('account_deletion_requests').select('*').is('cancelled_at', null).is('completed_at', null).lte('purge_after', now.toISOString());
  if (due.error) return { error: due.error, results: [] };
  const results = [];
  for (const row of due.data || []) {
    const ran = await executeAccountDeletion(admin, row.user_id, deps);
    if (ran.ok) {
      await admin.from('account_deletion_requests').update({ completed_at: new Date().toISOString() }).eq('id', row.id);
      results.push({ user_id: row.user_id, ok: true });
    } else results.push({ user_id: row.user_id, ok: false, status: ran.status });
  }
  return { ok: true, results };
}

export async function cronAccountDeletion(req, deps = {}) {
  const env = deps.env || process.env;
  const ok = cronAuthorized(req.headers.get('authorization'), req.headers.get('x-account-deletion-secret'), env);
  if (!String(env.CRON_SECRET || env.ACCOUNT_DELETION_CRON_SECRET || '')) return json({ error: 'Account deletion cleanup is not configured.' }, 503);
  if (!ok) return json({ error: 'Not allowed.' }, 401);
  const admin = adminOf(deps);
  if (!admin) return json({ error: SETUP, setupNeeded: true }, 503);
  const ran = await runDueDeletions(admin, deps, deps.now || new Date());
  if (ran.error) {
    if (missing(ran.error)) return json({ error: SETUP, setupNeeded: true }, 503);
    return json({ error: 'Couldn’t finish scheduled deletions.' }, 500);
  }
  return json({ ok: true, finished: (ran.results || []).filter((r) => r.ok).length, results: ran.results });
}
