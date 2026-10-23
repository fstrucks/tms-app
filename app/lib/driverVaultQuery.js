// Loads driver files for the vault. Checklist uploads are stored on the company owner, so a
// teammate's read uses the service client and is filtered to that owner, then cut down by role.
import { isMissing } from './vaultServer';
import {
  DRIVER_VAULT_FETCH_CAP, DRIVER_VAULT_TYPE_IDS, countDriverVaultFiles, groupDriverVault, isDriverVaultDoc,
} from './driverVault';

const DOC_COLS = 'id,user_id,doc_type,file_path,original_filename,created_at';

export async function loadDriverVault(svc, { ownerId, role, userId, profileId } = {}) {
  const dr = await svc.from('drivers').select('id,name,auth_user_id,active,cdl_expiry,med_card_expiry').eq('user_id', ownerId);
  if (dr.error) {
    if (isMissing(dr.error)) return { groups: [], unassigned: [], count: 0, unavailable: true };
    return { error: dr.error };
  }
  const docsRes = await svc.from('documents').select(DOC_COLS).eq('user_id', ownerId).in('doc_type', DRIVER_VAULT_TYPE_IDS)
    .order('created_at', { ascending: false }).limit(DRIVER_VAULT_FETCH_CAP + 1);
  if (docsRes.error) {
    if (isMissing(docsRes.error)) return { groups: [], unassigned: [], count: 0, unavailable: true };
    return { error: docsRes.error };
  }
  let statuses = [];
  if (profileId) {
    const st = await svc.from('company_checklist_status').select('document_id,driver_id,item_key').eq('company_id', profileId).limit(500);
    if (!st.error) statuses = st.data || [];
  }
  let documents = docsRes.data || [];
  const capped = documents.length > DRIVER_VAULT_FETCH_CAP;
  if (capped) documents = documents.slice(0, DRIVER_VAULT_FETCH_CAP);
  const have = new Set(documents.map((d) => d.id));
  const extraIds = [...new Set(statuses.map((s) => s.document_id).filter((id) => id && !have.has(id)))].slice(0, 100);
  if (extraIds.length) {
    const extra = await svc.from('documents').select(DOC_COLS).eq('user_id', ownerId).in('id', extraIds);
    if (!extra.error) documents = documents.concat((extra.data || []).filter((d) => isDriverVaultDoc(d, statuses)));
  }
  const grouped = groupDriverVault({ drivers: dr.data || [], documents, statuses, role, userId });
  return { ...grouped, count: countDriverVaultFiles(grouped), capped, unavailable: false };
}
