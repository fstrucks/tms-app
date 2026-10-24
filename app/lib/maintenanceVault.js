// Alex's truck maintenance vault is a separate page. This flag is the only switch.
// TODO(Alex): set MAINTENANCE_VAULT_ENABLED to true once /maintenance/vault and
// maintenance_vault_count() (returns an int) are shipped. Until then the Docs tile
// stays hidden and nothing calls that RPC.
export const MAINTENANCE_VAULT_ENABLED = true;
export const MAINTENANCE_VAULT_PATH = '/maintenance/vault';

// All trucks: /maintenance/vault. One truck: /maintenance/vault?truck=<id>.
export function maintenanceVaultHref(truckId) {
  if (truckId == null || truckId === '') return MAINTENANCE_VAULT_PATH;
  return `${MAINTENANCE_VAULT_PATH}?truck=${encodeURIComponent(truckId)}`;
}

// When enabled is false this returns before any RPC. Callers should also skip the call.
export async function fetchMaintenanceCount(supabase, { enabled = MAINTENANCE_VAULT_ENABLED } = {}) {
  if (!enabled || !supabase?.rpc) return { count: null, called: false };
  const { data, error } = await supabase.rpc('maintenance_vault_count');
  if (error) return { count: null, called: true, error: true };
  const n = typeof data === 'number' ? data : (typeof data === 'string' && data.trim() !== '' ? Number(data) : NaN);
  return { count: Number.isFinite(n) ? n : null, called: true };
}
