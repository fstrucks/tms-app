'use client';
// Next-day facility rating reminder cards (Home, and the load page with loadId). One card per due stop, shown once:
// the first display marks it reminded; it stays on reloads for the rest of that day (stop's timezone), then never again.
import { useEffect, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import { makeApi } from '../lib/packetApi';
import { FacilityReviewPrompt } from './FacilityReview';
import { cardMapsUrl } from '../lib/facilityRatingPrompts';

const { call: api } = makeApi(() => getSupabase()?.auth);
// The facility's address under the card title, at most 2 lines (phone width), opens Maps. Nothing when unknown.
// Link colour + underline + pin, like the facility page's "📍 Open in Maps", so it reads as tappable.
const addrStyle = { display: '-webkit-box', width: 'fit-content', maxWidth: '100%', margin: '1px 0 2px',
  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere',
  fontSize: '0.8rem', lineHeight: 1.35, color: 'var(--primary)', textDecoration: 'underline', textUnderlineOffset: 2 };
export function CardAddress({ name, address }) {
  if (!address) return null;
  return <a data-testid="facility-reminder-address" href={cardMapsUrl(name, address)} target="_blank" rel="noopener noreferrer"
    aria-label={`${address}, open in Maps`} title="Open in Maps" style={addrStyle}><span aria-hidden="true">📍 </span>{address}</a>;
}

export default function FacilityRatingReminders({ loadId = null }) {
  const [cards, setCards] = useState([]);
  useEffect(() => {
    let live = true;
    api(`/api/rating-prompts${loadId ? `?loadId=${encodeURIComponent(loadId)}` : ''}`).then((j) => {
      if (!live || !Array.isArray(j?.cards)) return;
      setCards(j.cards);
      for (const c of j.cards) if (c.state === 'first') api('/api/rating-prompts', { method: 'POST', body: JSON.stringify({ stopId: c.stopId, action: 'shown' }) }).catch(() => {});
    }).catch(() => {});
    return () => { live = false; };
  }, [loadId]);
  if (!cards.length) return null;
  return (
    <section data-testid="facility-rating-reminders" aria-label="Rate a facility" style={{ margin: '12px 0' }}>
      {cards.map((c) => (
        <div key={c.id} data-testid="facility-rating-reminder" style={{ marginBottom: 10 }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{c.kind === 'pickup' ? 'Yesterday’s pickup' : 'Yesterday’s delivery'}{c.facilityName ? ` · ${c.facilityName}` : ''}</div>
          <CardAddress name={c.facilityName} address={c.facilityAddress} />
          <FacilityReviewPrompt loadId={c.loadId} stop={{ id: c.stopId, stop_type: c.kind, company_name: c.facilityName }} mode="reminder"
            onClose={() => setCards((cs) => cs.filter((x) => x.id !== c.id))} />
        </div>
      ))}
    </section>
  );
}
