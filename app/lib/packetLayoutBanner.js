// Client-safe: the mapper's remembered-layout banner (carrier packet G). Pure; no crypto, no DB.
const shortDate = (d, tz) => {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '' : new Intl.DateTimeFormat('en-US', { ...(tz ? { timeZone: tz } : {}), month: 'short', day: 'numeric' }).format(t);
};
// info: GET /api/packets/[id]/layout. placed: fields on the packet with source 'layout'.
// → null | { kind, text, action: 'dismiss'|'apply'|null, button }
export function layoutBanner(info, { canEdit = false, placed = 0, total: total0 = 0, tz } = {}) {
  if (!info?.available || !info.state || info.state === 'dismissed' || !info.layout) return null;
  // The packet's Broker field (detected from the PDF or typed) first, then the name saved with the layout.
  const named = (info.broker_name && String(info.broker_name).trim()) || (info.layout.broker_name && String(info.layout.broker_name).trim()) || null;
  const broker = named || 'a saved broker';
  const used = info.layout.last_used_at ? shortDate(info.layout.last_used_at, tz) : '';
  if (info.state === 'applied') {
    const n = placed || 0, total = Math.max(Number(total0) || 0, n);
    const count = total > n ? `${n} of ${total} fields placed from the saved layout` : `${n} field${n === 1 ? '' : 's'} placed from the saved layout`;
    return { kind: 'applied', text: `Layout from ${broker}${used ? `, last used ${used}` : ''}. ${count}. Review them before filling.`,
      action: canEdit ? 'dismiss' : null, button: canEdit ? 'Don’t use this layout' : null };
  }
  if (info.state === 'suggested') {
    return { kind: 'suggested', text: canEdit ? `This looks like ${broker}’s packet${used ? ` (last used ${used})` : ''}. Use the saved layout?` : `This looks like ${broker}’s packet. The owner, dispatcher or management can use the saved layout.`,
      action: canEdit ? 'apply' : null, button: canEdit ? 'Use layout' : null };
  }
  if (info.state === 'changed') {
    const n = Number(info.names) || 0, m = Number(info.matched) || 0, total = Math.max(Number(info.total) || Number(total0) || 0, m);
    const who = named ? `${named}’s packet` : 'This broker’s packet';
    const base = `${who} looks different from last time, so fields were found fresh.`;
    // "6 of 9 fields matched last time. 5 already have the same name; 1 can use last time’s name."
    const matchTxt = m > 0 && total > 0 ? ` ${m} of ${total} field${total === 1 ? '' : 's'} matched last time.` : '';
    const same = m - n;
    const detail = m > 0 ? (n > 0 ? ` ${same > 0 ? `${same} already ha${same === 1 ? 's' : 've'} the same name; ` : ''}${n} can use last time’s name.` : ' They already have the same names.') : '';
    if (n > 0 && canEdit) return { kind: 'changed', text: `${base}${matchTxt}${detail}`, action: 'names', button: `Use ${n} name${n === 1 ? '' : 's'} from last time` };
    return { kind: 'changed', text: `${base}${matchTxt}${m > 0 && n === 0 ? detail : ''}`, action: null, button: null };
  }
  return null;
}
// Fields that came from the saved layout, including ones edited since (an edit, e.g. "Left blank", turns the row's
// source into 'user' but keeps its lay-… key), so the banner count matches the field summary (QA r2 C).
export const isLayoutPlaced = (f) => !!f && (f.source === 'layout' || /^lay-p\d+-\d+$/.test(String(f.field_key || '')));
export const placedCount = (fields = []) => fields.filter(isLayoutPlaced).length;
