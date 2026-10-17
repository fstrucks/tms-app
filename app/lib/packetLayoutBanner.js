// Client-safe: the mapper's remembered-layout banner (carrier packet G). Pure; no crypto, no DB.
const shortDate = (d, tz) => {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '' : new Intl.DateTimeFormat('en-US', { ...(tz ? { timeZone: tz } : {}), month: 'short', day: 'numeric' }).format(t);
};
// info: GET /api/packets/[id]/layout. placed: fields on the packet with source 'layout'.
// → null | { kind, text, action: 'dismiss'|'apply'|null, button }
export function layoutBanner(info, { canEdit = false, placed = 0, tz } = {}) {
  if (!info?.available || !info.state || info.state === 'dismissed' || !info.layout) return null;
  const broker = info.layout.broker_name || 'a saved broker';
  const used = info.layout.last_used_at ? shortDate(info.layout.last_used_at, tz) : '';
  if (info.state === 'applied') {
    const n = placed || 0;
    return { kind: 'applied', text: `Layout from ${broker}${used ? `, last used ${used}` : ''}. ${n} field${n === 1 ? '' : 's'} placed. Review them before filling.`,
      action: canEdit ? 'dismiss' : null, button: canEdit ? 'Don’t use this layout' : null };
  }
  if (info.state === 'suggested') {
    return { kind: 'suggested', text: canEdit ? `This looks like ${broker}’s packet${used ? ` (last used ${used})` : ''}. Use the saved layout?` : `This looks like ${broker}’s packet. The owner, dispatcher or management can use the saved layout.`,
      action: canEdit ? 'apply' : null, button: canEdit ? 'Use layout' : null };
  }
  if (info.state === 'changed') return { kind: 'changed', text: `${broker}’s packet looks different from last time, so fields were found fresh.`, action: null, button: null };
  return null;
}
export const placedCount = (fields = []) => fields.filter((f) => f.source === 'layout').length;
