#!/usr/bin/env python3
"""Builds the maintenance_interval_templates seed (SQL VALUES) from the research CSVs.

Usage: python3 scripts/maintenance_intervals_seed.py [CSV_DIR] > /tmp/seed.sql
CSV_DIR (default /workspace/maintenance-intervals) holds seed.csv (maker rows) and generic.csv (GENERIC rows).
The CSVs are research notes and are not kept in the repo.
Then paste the output between the SEED BEGIN / SEED END markers in
supabase/migrations/20261023000300_maintenance_schedules.sql.

Notes are rewritten in our own words (NOTES below); a CSV note with no entry stops the script.
Numbers, source titles, source URLs and as-of dates are kept as they are.
"""
import csv, os, re, sys

SEED = sys.argv[1] if len(sys.argv) > 1 else '/workspace/maintenance-intervals'

TYPE = {
    'oil_and_filter': 'oil_filter', 'fuel_filter': 'fuel_filters', 'fuel_filter_w_frame_mounted': 'fuel_filters',
    'def_filter': 'def_filter', 'valve_adjustment': 'valve_adjustment', 'air_filter': 'air_filter',
    'coolant': 'coolant', 'coolant_replace_extended_life': 'coolant', 'coolant_filter': 'coolant_filter',
    'differential_fluid': 'differential', 'transmission_fluid': 'transmission',
}
MAKER_OIL = re.compile(r"^Genuine premium oil; other approved VDS/EOS-4\.5: (\d+) mi; idle >30% -> next lower$")
NOTES = {
    '': None,
    'Replaced with oil': 'Change it together with the oil.',
    'Premium long-life coolant replace 750k mi/96 mo': "With the maker's premium long-life coolant the change can stretch to about 750,000 mi or 8 years.",
    'CK-4/FA-4 DFS-approved oil, ULSD; whichever first': 'Assumes approved CK-4 or FA-4 oil and ultra-low-sulfur diesel. Miles or time, whichever comes first.',
    'Engine fuel filter at every oil change (no frame-mounted filter)': 'No frame-mounted fuel filter: change the engine fuel filter with each oil change.',
    'Engine filter when Detroit/Davco frame-mounted filter fitted; never exceed 100k mi': 'With a frame-mounted fuel filter fitted: engine filter on this interval, never past 100,000 mi.',
    'ELC replace; standard-life coolant replace 300,000 mi': 'Extended-life coolant. Standard coolant needs changing sooner, around 300,000 mi.',
    'DEF pump filter 500k mi or 3 yrs': 'DEF pump filter: about 500,000 mi or 3 years.',
    'Inspect at oil change only; no fixed replace interval published': 'No set change interval. Check it at each oil change and replace it when the restriction gauge says so.',
    'CK-4/CJ-4 10W-30': 'Assumes CK-4 or CJ-4 10W-30 oil.',
    'Coolant filter, not coolant replacement': 'This is the coolant filter, not a coolant change.',
    'Routine 300k/9,000 h; initial 150k/6,750 h (linehaul) or 60k/1,600 h (severe) - column mapping on quick-ref is ambiguous':
        'Regular interval about 300,000 mi or 9,000 h; the first one comes earlier. The source table is hard to read, so confirm in the manual.',
    'If idle+PTO >40% use next lower interval; +5,000 mi w/ Valvoline Premium Blue': 'Heavy idling or PTO use (over 40%) means the shorter interval. Some approved oils allow a little more.',
    'Up to 100k mi with FF5971NN (Normal)': "Can go up to 100,000 mi with the maker's premium filter in normal service.",
    'Overhead adjustment': 'Overhead adjustment.',
    "'Follow OEM coolant recommendations' - no number": "No mileage given; follow the coolant maker's guidance.",
    '1,500 hr/18 mo cap; idle+PTO >40% -> next lower': 'Never past 1,500 h or 18 months. Heavy idling or PTO use means the shorter interval.',
    'Valvetrain interval': 'Valve adjustment.',
    'Up to 70k with oil sampling + International approval; brochure, dealer-hosted': "Can stretch to about 70,000 mi with oil analysis and the maker's approval.",
    'At every oil change or 1,300 h': 'With every oil change, or every 1,300 h.',
    'Replace; ELC extender at 600k': 'Change it; add coolant extender at about 600,000 mi.',
    'Table reads 12 months then every 24 months; mileage values 150k then 300k mi; column split unclear - verify in manual':
        'First at about 12 months or 150,000 mi, then every 24 months or 300,000 mi. The source table is hard to read, so confirm in the manual.',
    'DEF pump main filter; column assignment unclear': 'DEF pump main filter. The source table is hard to read, so confirm in the manual.',
    'At max restriction or 12 months': 'When the restriction gauge reads max, or every 12 months.',
    'At max restriction or 6 months': 'When the restriction gauge reads max, or every 6 months.',
    'mDRIVE oil+filter': 'Automated transmission oil and filter.',
    'Mack proprietary axle oil GO-J; GO-J PLUS 500k/36 mo': "With the maker's axle oil; its premium version goes about 500,000 mi or 36 months.",
    'GO-J; GO-J PLUS 80k': "With the maker's axle oil; its premium version allows about 80,000 mi.",
    '2020 QRG': 'From the 2020 quick reference guide.',
    'Coolant system flush': 'Coolant system flush.',
    'Use only when engine unknown': "Used only when the engine isn't known.",
    'Default = every oil change': 'Change it with every oil change.',
}

def note(n):
    m = MAKER_OIL.match(n)
    if m:
        return f"With the maker's premium oil. Other approved oils: {int(m.group(1)):,} mi. Idling over 30% means the shorter interval."
    if n not in NOTES:
        sys.exit(f'No rewritten note for: {n!r}')
    return NOTES[n]

def q(v):
    if v is None or v == '':
        return 'null'
    return "'" + str(v).replace("'", "''") + "'"

def num(v):
    return str(int(v)) if v not in ('', None) else 'null'

rows = []
for fn, generic in (('seed.csv', False), ('generic.csv', True)):
    with open(os.path.join(SEED, fn), newline='', encoding='utf-8') as f:
        for r in csv.DictReader(f):
            if r['service_type'] not in TYPE:
                sys.exit(f"Unmapped service type {r['service_type']!r}")
            follows = 'oil_filter' if generic and r['service_type'] == 'fuel_filter' and not r['interval_miles'] else None
            key = '|'.join([r['maker'], r['model'], r['duty_cycle'], r['maker_duty_label'], r['service_type'], r['fuel_rule']])
            vals = [q(key), q(r['maker']), q(r['model']), q(r['duty_cycle']), q(r['maker_duty_label']), q(r['service_type']), q(TYPE[r['service_type']]),
                    num(r['interval_miles']), num(r['interval_days']), num(r['interval_hours']), q(r['fuel_rule']), q(follows),
                    q(r['source_title']), q(r['source_url']), q(r['as_of_date']), q(r['confidence']), q(note(r['notes'])), 'true' if generic else 'false']
            rows.append('  (' + ', '.join(vals) + ')')
out = ',\n'.join(rows)
if re.search(r'[^\x00-\x7F]', out):
    sys.exit('Seed has non-ASCII text')
print(out)
print(f'-- {len(rows)} rows', file=sys.stderr)
