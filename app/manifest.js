// Web app manifest (Oct 20 2026): the home screen icon opens Home (/), not whatever page it was added from.
// display 'browser' keeps today's behavior (no standalone mode change); only start_url / scope are new.
export default function manifest() {
  return { name: 'PowerHaul TMS', short_name: 'PowerHaul', start_url: '/', scope: '/', display: 'browser', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] };
}
