# Changelog

Notable changes to the TMS app, newest first. One line per merged PR: `- YYYY-MM-DD #PR: summary`.

- 2026-10-11 #PR_ADDR: Hardened stop address parsing (`parse_us_address`: newlines, trailing country, last valid state + ZIP) so stop time zones resolve; home page shows signed-in state, sign out and app links.
- 2026-10-11 #11: Weekly dashboard (`/dashboard`): booked revenue (excludes cancelled/canceled/TONU/void), load-mile and logged-mile RPM, expenses by category, net; 4/8-week toggle; inline SVG charts.
