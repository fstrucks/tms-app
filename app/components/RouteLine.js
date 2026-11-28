// Wrapping route line: every (or list-row) stop in order. Each "→ City, ST" is one inline-block
// unit, so at phone width the line breaks between stops (the arrow stays with the stop after it),
// never mid-city. A single over-long name may still wrap inside itself.
import { listRoutePlaces, routeStops } from '../lib/routeLine';

const UNIT = { display: 'inline-block', maxWidth: '100%', overflowWrap: 'anywhere' };

export default function RouteLine({
  load,
  places,
  testId,
  stopTestId,
  as: Tag = 'div',
  style,
  arrowStyle,
}) {
  const items = places ?? routeStops(load);
  return (
    <Tag data-testid={testId} style={{ minWidth: 0, ...style }}>
      {items.map((p, i) => (
        <span key={i}>{i > 0 && ' '}<span data-testid={stopTestId} style={UNIT}>{i > 0 && <span style={arrowStyle}>→{'\u00a0'}</span>}{p}</span></span>
      ))}
    </Tag>
  );
}

// Loads list, Dispatch list, "On the road" bar, and Dispatch boards: 2-stop rows keep today's
// pickup → delivery pair (dates on Loads / Dispatch / On the road); 3+ stops list every place.
export function ListRoute({ load, dated = false, testId, stopTestId, as, style, arrowStyle }) {
  return (
    <RouteLine
      places={listRoutePlaces(load, { datesOnShort: dated })}
      testId={testId}
      stopTestId={stopTestId}
      as={as}
      style={style}
      arrowStyle={arrowStyle}
    />
  );
}
