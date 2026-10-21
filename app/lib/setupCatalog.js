// Master setup checklist. Edit this file to change the list — there is no admin screen.
// Keep DRIVER equipment/binder keys in sync with checklist_item_access() in
// supabase/migrations/20261021120000_setup_checklist.sql (a test checks that).

import { GUIDANCE } from './complianceCalendar.js';

export { GUIDANCE };
export const NOT_CONFIRMED = 'Not confirmed';

export const CATEGORIES = [
  { key: 'authority', name: 'Company & Authority' },
  { key: 'insurance', name: 'Insurance' },
  { key: 'taxes', name: 'Taxes & Fuel Tax' },
  { key: 'drug_alcohol', name: 'Drug & Alcohol' },
  { key: 'driver_files', name: 'Driver Files' },
  { key: 'truck', name: 'Truck & Trailer' },
  { key: 'permits', name: 'Permits' },
  { key: 'binder', name: 'In-Cab Binder' },
  { key: 'equipment', name: 'Truck Equipment' },
  { key: 'loads', name: 'Loads & Paperwork' },
  { key: 'billing', name: 'Billing & Factoring' },
  { key: 'hazmat', name: 'Hazmat (only if hauling hazmat)' },
];
export const CATEGORY_NAME = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.name]));

export const OPERATION_QUESTIONS = [
  { key: 'interstate', label: 'Do you run interstate (across state lines)?' },
  { key: 'for_hire', label: 'Are you for-hire (hauling other people’s freight)?' },
  { key: 'cdl_drivers', label: 'Do your drivers (including you) hold a CDL?' },
  { key: 'ifta_irp', label: 'Is a truck IFTA or IRP qualified (over 26,000 lb, or 3 or more axles, in two or more states)?' },
  { key: 'hvut', label: 'Is any vehicle 55,000 lb or heavier?' },
  { key: 'hazmat', label: 'Do you haul hazardous materials?' },
  { key: 'leased_onto_carrier', label: 'Are you leased on to another carrier?' },
  { key: 'flatbed', label: 'Do you run flatbed or hotshot?' },
];

export const WIZARD_STEPS = [
  { id: 1, key: 'welcome', title: 'Welcome' },
  { id: 2, key: 'operation', title: 'Your company' },
  { id: 3, key: 'company', title: 'Authority, insurance, and taxes' },
  { id: 4, key: 'drug', title: 'Drug and alcohol' },
  { id: 5, key: 'drivers', title: 'Driver files' },
  { id: 6, key: 'trucks', title: 'Trucks, trailers, and permits' },
  { id: 7, key: 'equipment', title: 'Truck equipment' },
  { id: 8, key: 'binder', title: 'In-cab binder' },
  { id: 9, key: 'done', title: 'Done' },
];

const STEP = {
  authority: 3, insurance: 3, taxes: 3, billing: 3,
  drug_alcohol: 4, driver_files: 5, truck: 6, permits: 6,
  equipment: 7, binder: 8, loads: 8, hazmat: 8,
};

let sort = 0;
function item(partial) {
  sort += 10;
  return {
    warningDays: 30, verified: true, scope: 'company', when: null, kinds: ['audit'],
    expiry: 'none', docType: null, echoOf: null, sort, level: 'required', ...partial,
    wizardStep: partial.wizardStep || STEP[partial.category] || 3,
  };
}

// when: a question key, { all: [] }, or { any: [] }. Unanswered stays visible. Explicit "no" hides the item.
export const CHECKLIST_ITEMS = [
  item({ key: 'usdot_mcs150', title: 'USDOT number / MCS-150', category: 'authority', kinds: ['upload', 'audit'], when: 'interstate', expiry: 'mcs150', docType: 'usdot_mcs150',
    description: 'Federal carrier registration and the update every 24 months. The last digit of the USDOT number sets the month (1 = January … 9 = September, 0 = October). The next-to-last digit sets odd or even years. File by the last day of that month.',
    citation: '49 CFR 390.19(b)' }),
  item({ key: 'mc_authority', title: 'MC operating authority letter', category: 'authority', kinds: ['upload', 'audit'], level: 'conditional', when: { all: ['for_hire', 'interstate'] }, docType: 'mc_authority', verified: false,
    description: 'FMCSA grant of for-hire interstate authority. It stays active while the BOC-3 and insurance filings stay on file.',
    citation: '49 USC 13902 (not confirmed against the statute text); 49 CFR 366.2 requires the BOC-3 at application' }),
  item({ key: 'boc3', title: 'BOC-3 (process agents)', category: 'authority', kinds: ['upload', 'audit'], level: 'conditional', when: 'for_hire', docType: 'boc3',
    description: 'Designation of process agents. Refile when the name, address, or docket changes.',
    citation: '49 CFR 366.2' }),
  item({ key: 'coi', title: 'Certificate of insurance (COI)', category: 'insurance', kinds: ['upload', 'audit'], expiry: 'policy', docType: 'coi',
    description: 'Proof of liability coverage. Expires with the policy, usually once a year. The date comes from the insurance policy when one is entered.',
    citation: '49 CFR 387.9' }),
  item({ key: 'mcs90', title: 'MCS-90 endorsement / Form MCS-82', category: 'insurance', kinds: ['upload', 'audit'], level: 'conditional', when: { any: ['for_hire', 'hazmat'] }, expiry: 'policy', docType: 'mcs90',
    description: 'Federal endorsement on the liability policy, or the MCS-82 surety. It stays with the policy.',
    citation: '49 CFR 387.7(d)' }),
  item({ key: 'insurance_filing', title: 'Insurance filing (BMC-91 / 91X)', category: 'insurance', kinds: ['audit'], level: 'conditional', when: 'for_hire', verified: false,
    description: 'The insurer’s filing with FMCSA. It stays active while the policy is in force. Confirm the filing is on your docket.',
    citation: '49 CFR 387.15 (the endorsement form). BMC-91 / 91X filing steps were not confirmed.' }),
  item({ key: 'w9', title: 'W-9', category: 'taxes', kinds: ['upload'], level: 'recommended', docType: 'w9', verified: false,
    description: 'IRS form that gives your taxpayer ID to brokers and shippers. Update it when the name or TIN changes.',
    citation: 'IRS Form W-9 (page not confirmed). Common broker practice, not a DOT rule.' }),
  item({ key: 'ucr', title: 'UCR receipt', category: 'authority', kinds: ['upload', 'audit'], level: 'conditional', when: 'interstate', expiry: 'ucr', docType: 'ucr',
    description: 'Proof the annual Unified Carrier Registration fee is paid. The portal for the next year opens October 1. Pay before January 1.',
    citation: 'UCR fee schedule (plan.ucr.gov); 91 FR 56063' }),
  item({ key: 'ifta_license', title: 'IFTA license', category: 'taxes', kinds: ['upload', 'audit'], level: 'conditional', when: 'ifta_irp', expiry: 'ifta_renewal', docType: 'ifta_license', verified: false,
    description: 'Fuel-tax license from your base state for a qualified vehicle that runs in two or more jurisdictions. Renewal dates are set by that state — enter yours.',
    citation: 'IFTA Articles of Agreement. The per-state renewal deadline was not confirmed.' }),
  item({ key: 'ifta_returns', title: 'IFTA quarterly returns and records', category: 'taxes', kinds: ['audit'], level: 'conditional', when: 'ifta_irp', expiry: 'quarterly',
    description: 'Filed returns plus fuel and mileage records. Due April 30, July 31, October 31, and January 31. If that day is a weekend or holiday, the next business day. Keep 4 years.',
    citation: 'IFTA Articles R960' }),
  item({ key: 'irp_account', title: 'IRP apportioned registration', category: 'truck', kinds: ['upload', 'audit'], level: 'conditional', when: 'ifta_irp', expiry: 'irp', docType: 'irp_account', scope: 'company', verified: false,
    description: 'Base-state apportioned account. The registration year is set by your base state — enter your renewal date. Keep mileage records 3 years.',
    citation: 'IRP Plan, registration year and §520. State dates were not confirmed.' }),
  item({ key: 'form_2290', title: 'IRS Form 2290 Schedule 1', category: 'taxes', kinds: ['upload', 'audit'], level: 'conditional', when: 'hvut', expiry: '2290', docType: 'form_2290',
    description: 'Stamped proof the Heavy Vehicle Use Tax was paid for the company. Due the last day of the month after first use (July first use is due August 31). If that day is a weekend or holiday, the next business day.',
    citation: 'IRS Form 2290 instructions' }),
  item({ key: 'da_consortium', title: 'Drug and alcohol consortium certificate', category: 'drug_alcohol', kinds: ['upload', 'audit'], level: 'conditional', when: 'cdl_drivers', expiry: 'yearly', docType: 'da_consortium',
    description: 'Proof of membership in a random testing pool. Owner-operators use a consortium. Usually renewed yearly.',
    citation: '49 CFR Part 382' }),
  item({ key: 'da_policy', title: 'Drug and alcohol policy and materials', category: 'drug_alcohol', kinds: ['upload', 'audit'], level: 'conditional', when: 'cdl_drivers', docType: 'da_policy',
    description: 'Written policy and educational materials given to each driver. Update when the rules change.',
    citation: '49 CFR 382.601' }),
  item({ key: 'clearinghouse', title: 'Clearinghouse registration', category: 'drug_alcohol', kinds: ['upload', 'audit'], level: 'conditional', when: 'cdl_drivers', docType: 'clearinghouse',
    description: 'Employer account in the FMCSA Drug and Alcohol Clearinghouse, including the consortium designation.',
    citation: '49 CFR 382.701 / 382.711' }),
  item({ key: 'accident_register', title: 'Accident register', category: 'authority', kinds: ['audit'],
    description: 'Log of DOT-recordable crashes. Keep each accident 3 years. Mark this done once the register exists, even if it is empty.',
    citation: '49 CFR 390.15(b)' }),
  item({ key: 'formation', title: 'Company formation documents', category: 'authority', kinds: ['audit'], level: 'recommended', docType: 'formation', verified: false,
    description: 'State entity papers and the IRS EIN letter. Follow your state’s rules.',
    citation: 'State law (not confirmed here).' }),
  item({ key: 'carrier_lease', title: 'Lease to a carrier', category: 'authority', kinds: ['upload', 'audit'], level: 'conditional', when: 'leased_onto_carrier', expiry: 'date', docType: 'carrier_lease',
    description: 'Written lease of your equipment to an authorized carrier. Track the lease end date.',
    citation: '49 CFR 376.11(a) and 376.12' }),

  item({ key: 'employment_application', title: 'Employment application', category: 'driver_files', kinds: ['audit'], scope: 'driver',
    description: 'Application with a 3-year history (10 years for CDL holders). Once per hire.',
    citation: '49 CFR 391.21; 391.51(b)(1)' }),
  item({ key: 'prehire_mvr', title: 'Pre-hire driving record', category: 'driver_files', kinds: ['audit'], scope: 'driver',
    description: 'Motor vehicle record from each licensing state, for the past 3 years, within 30 days of hire.',
    citation: '49 CFR 391.23; 391.51(b)(2)' }),
  item({ key: 'employer_inquiries', title: 'Previous-employer inquiries', category: 'driver_files', kinds: ['audit'], scope: 'driver',
    description: 'Safety history from prior DOT employers for the past 3 years. Keep 3 years.',
    citation: '49 CFR 391.23' }),
  item({ key: 'road_test', title: 'Road test or CDL equivalent', category: 'driver_files', kinds: ['audit'], scope: 'driver',
    description: 'Road test certificate, or a CDL accepted in its place. Once per hire.',
    citation: '49 CFR 391.31 / 391.33; 391.51(b)(3)' }),
  item({ key: 'annual_mvr', title: 'Annual driving record and review', category: 'driver_files', kinds: ['audit'], scope: 'driver', expiry: 'yearly',
    description: 'Yearly driving record and the carrier’s review note. Due every 12 months.',
    citation: '49 CFR 391.25; 391.51(b)(4)-(5)' }),
  item({ key: 'medical_card', title: 'Medical examiner’s certificate', category: 'driver_files', kinds: ['upload', 'audit'], scope: 'driver', expiry: 'date', docType: 'medical_card',
    description: 'DOT physical. Valid up to 2 years, or sooner if the examiner says so. Enter the expiration date.',
    citation: '49 CFR 391.43 / 391.45; 391.41(a)' }),
  item({ key: 'registry_examiner', title: 'National Registry examiner check', category: 'driver_files', kinds: ['audit'], scope: 'driver',
    description: 'Note that the medical examiner is listed on the FMCSA National Registry. Do this for each new card.',
    citation: '49 CFR 391.51(b); 391.23(m)' }),
  item({ key: 'medical_variance', title: 'Medical variance or SPE', category: 'driver_files', kinds: ['audit'], scope: 'driver', level: 'conditional', expiry: 'date',
    description: 'Exemption or skill performance evaluation, only if this driver has one.',
    citation: '49 CFR 391.51(b)(7)' }),
  item({ key: 'cdl', title: 'Copy of CDL', category: 'driver_files', kinds: ['upload', 'audit'], scope: 'driver', when: 'cdl_drivers', expiry: 'date', docType: 'cdl',
    description: 'Current commercial license. Enter the state expiration date.',
    citation: '49 CFR Part 383' }),
  item({ key: 'eldt', title: 'Entry-level driver training certificate', category: 'driver_files', kinds: ['audit'], scope: 'driver', level: 'conditional', when: 'cdl_drivers',
    description: 'Training record for a first Class A or B CDL, an upgrade, or a first passenger, school bus, or hazmat endorsement.',
    citation: '49 CFR 380.609' }),
  item({ key: 'preemployment_drug', title: 'Pre-employment drug test', category: 'drug_alcohol', kinds: ['audit'], scope: 'driver', level: 'conditional', when: 'cdl_drivers',
    description: 'Negative result before the driver drives. Keep negatives 1 year.',
    citation: '49 CFR 382.301; 382.401(b)(3)' }),
  item({ key: 'clearinghouse_queries', title: 'Clearinghouse queries', category: 'drug_alcohol', kinds: ['audit'], scope: 'driver', level: 'conditional', when: 'cdl_drivers', expiry: 'yearly',
    description: 'Full pre-employment query, then a query every year.',
    citation: '49 CFR 382.701' }),
  item({ key: 'da_violations', title: 'Drug and alcohol violation records', category: 'drug_alcohol', kinds: ['audit'], scope: 'driver', level: 'conditional', when: 'cdl_drivers',
    description: 'Positives, refusals, alcohol 0.02 or higher, and return-to-duty records. Keep 5 years. Mark not needed if there are none.',
    citation: '49 CFR 382.401(b)(1)' }),
  item({ key: 'da_collection', title: 'Drug and alcohol collection records', category: 'drug_alcohol', kinds: ['audit'], scope: 'driver', level: 'conditional', when: 'cdl_drivers',
    description: 'Chain of custody and related records. Keep 2 years.',
    citation: '49 CFR 382.401(b)(2)' }),
  item({ key: 'da_policy_receipt', title: 'Signed drug and alcohol policy receipt', category: 'drug_alcohol', kinds: ['audit'], scope: 'driver', level: 'conditional', when: 'cdl_drivers',
    description: 'The driver’s signed receipt of the policy. Again whenever the policy changes.',
    citation: '49 CFR 382.601' }),
  item({ key: 'dq_retention', title: 'Driver qualification file retention', category: 'driver_files', kinds: ['audit'], scope: 'driver',
    description: 'Keep the whole file for employment plus 3 years.',
    citation: '49 CFR 391.51(c)' }),

  item({ key: 'cab_card', title: 'Registration / IRP cab card', category: 'truck', kinds: ['upload', 'audit'], scope: 'truck', expiry: 'yearly', docType: 'cab_card', verified: false,
    description: 'Plate registration, and the apportioned cab card if the truck is on IRP. Renew yearly. An electronic cab card is not confirmed as accepted everywhere.',
    citation: 'IRP Plan §600(b) (2018): the cab card is carried in the vehicle. Electronic acceptance was not confirmed.' }),
  item({ key: 'title', title: 'Title or bill of sale', category: 'truck', kinds: ['upload', 'audit'], scope: 'truck', level: 'recommended', docType: 'title', verified: false,
    description: 'Proof of ownership, used for registration.',
    citation: 'State law (not confirmed here).' }),
  item({ key: 'annual_inspection', title: 'Annual inspection', category: 'truck', kinds: ['upload', 'audit'], scope: 'unit', expiry: 'yearly', docType: 'annual_inspection',
    description: 'Yearly inspection for the truck and each trailer. Keep the report 14 months. Enter the expiration date.',
    citation: '49 CFR 396.17; 396.21' }),
  item({ key: 'maintenance', title: 'Maintenance records', category: 'truck', kinds: ['audit'], scope: 'unit',
    description: 'Vehicle ID, inspection schedule, and repair log for a vehicle you control 30 days or more. Keep 1 year, and 6 months after it leaves.',
    citation: '49 CFR 396.3(b)-(c)' }),
  item({ key: 'dvir', title: 'DVIRs and repair certifications', category: 'truck', kinds: ['audit'], scope: 'truck', level: 'conditional',
    description: 'Post-trip defect reports and signed repairs, when a defect is found. Keep 3 months. Mark not needed if you have no defects on file.',
    citation: '49 CFR 396.11' }),
  item({ key: 'roadside', title: 'Roadside inspection reports', category: 'truck', kinds: ['audit'], scope: 'truck', level: 'conditional',
    description: 'Officer reports and the repair certification returned within 15 days. Mark not needed until you have one.',
    citation: '49 CFR 396.9(d)' }),
  item({ key: 'equipment_lease', title: 'Equipment lease', category: 'truck', kinds: ['upload', 'audit'], scope: 'truck', level: 'conditional', expiry: 'date', docType: 'equipment_lease',
    description: 'Lease for a truck or trailer you do not own. Enter the lease end date.',
    citation: '49 CFR 376.11' }),
  item({ key: 'form_2290_vin', title: 'Form 2290 Schedule 1 for this VIN', category: 'taxes', kinds: ['upload', 'audit'], scope: 'truck', level: 'conditional', when: 'hvut', expiry: 'yearly', docType: 'form_2290', wizardStep: 6,
    description: 'Stamped Schedule 1 that matches this vehicle’s VIN.',
    citation: 'IRS Form 2290 instructions' }),
  item({ key: 'vehicle_marking', title: 'Vehicle marking', category: 'truck', kinds: ['audit'], scope: 'truck',
    description: 'Carrier name and USDOT number on both sides of the power unit. Update when they change.',
    citation: '49 CFR 390.21' }),
  item({ key: 'permits', title: 'Permits (oversize, trip, fuel)', category: 'permits', kinds: ['upload'], scope: 'truck', level: 'conditional', expiry: 'date', docType: 'permit', verified: false,
    description: 'State permits for a load or route. Mark not needed if you do not use them. Enter the permit end date.',
    citation: '23 CFR 658.17(h). State permit rules were not confirmed one by one.' }),

  item({ key: 'eld_manual', title: 'ELD user manual', category: 'binder', kinds: ['binder'], scope: 'truck', level: 'recommended', verified: false,
    description: 'How to use the ELD. Recommended to keep in the cab. It is not one of the three sheets the ELD rule lists.',
    citation: '49 CFR 395.22(h) lists three items only. An ELD manual requirement was not found.' }),
  item({ key: 'eld_transfer', title: 'ELD data-transfer instructions', category: 'binder', kinds: ['binder'], scope: 'truck',
    description: 'How to send logs to an officer. Update when the device changes.',
    citation: '49 CFR 395.22(h)(1)' }),
  item({ key: 'eld_malfunction', title: 'ELD malfunction instructions', category: 'binder', kinds: ['binder'], scope: 'truck',
    description: 'What to do when the ELD malfunctions, including the records to keep.',
    citation: '49 CFR 395.22(h)(2)' }),
  item({ key: 'blank_logs', title: 'Blank paper logs (8 days)', category: 'binder', kinds: ['binder'], scope: 'truck',
    description: 'At least 8 days of blank paper logs if the ELD fails. Restock when they are used.',
    citation: '49 CFR 395.22(h)(3)' }),
  item({ key: 'accident_kit', title: 'Accident kit and procedures', category: 'binder', kinds: ['binder'], scope: 'truck', level: 'recommended',
    description: 'Steps, contacts, and post-accident testing times. Review once a year.',
    citation: '49 CFR 382.303; 390.15' }),
  item({ key: 'bol_papers', title: 'Bill of lading / shipping papers', category: 'loads', kinds: ['binder', 'audit'], scope: 'truck', level: 'recommended',
    description: 'Current load papers in the cab. Keep supporting documents 6 months.',
    citation: '49 CFR 395.8(k)' }),
  item({ key: 'hazmat_papers', title: 'Hazmat shipping papers and emergency info', category: 'hazmat', kinds: ['binder'], scope: 'truck', level: 'conditional', when: 'hazmat',
    description: 'Shipping papers and emergency response information within the driver’s reach, for each hazmat load.',
    citation: '49 CFR 177.817(e); 172.602(c)' }),

  item({ key: 'binder_medical', title: 'Medical card copy', category: 'binder', kinds: ['binder'], echoOf: 'medical_card', scope: 'driver',
    description: 'The driver carries the medical card. Same item as the driver file — upload it once.',
    citation: '49 CFR 391.41(a)' }),
  item({ key: 'binder_cab', title: 'Cab card in the truck', category: 'binder', kinds: ['binder'], echoOf: 'cab_card', scope: 'truck',
    description: 'The registration or IRP cab card stays in the vehicle. Same upload as the truck file.',
    citation: 'IRP Plan §600(b)' }),
  item({ key: 'binder_coi', title: 'Insurance card / COI in the truck', category: 'binder', kinds: ['binder'], echoOf: 'coi', scope: 'company', level: 'recommended', verified: false,
    description: 'Many states and officers ask for proof in the cab. Federal proof is kept at the principal place of business. Same COI upload.',
    citation: 'State practice (not confirmed). 49 CFR 387.7(d) keeps federal proof at the office.' }),
  item({ key: 'binder_ifta', title: 'IFTA license copy and decals', category: 'binder', kinds: ['binder'], echoOf: 'ifta_license', scope: 'company', level: 'conditional', when: 'ifta_irp',
    description: 'A copy of the IFTA license in each qualified vehicle, and decals on the truck. Same upload as the license.',
    citation: 'IFTA carrier requirements' }),
  item({ key: 'binder_annual', title: 'Annual inspection report or decal', category: 'binder', kinds: ['binder'], echoOf: 'annual_inspection', scope: 'unit',
    description: 'Proof of the yearly inspection on the vehicle. Same upload as the inspection report.',
    citation: '49 CFR 396.17(c)' }),
  item({ key: 'binder_permits', title: 'Permits in the truck', category: 'binder', kinds: ['binder'], echoOf: 'permits', scope: 'truck', level: 'conditional',
    description: 'Oversize, overweight, or trip permits for the current route. Same upload as the permit.',
    citation: 'State permit rules (not confirmed one by one).' }),
  item({ key: 'binder_lease', title: 'Lease copy in the truck', category: 'binder', kinds: ['binder'], echoOf: 'carrier_lease', scope: 'company', level: 'conditional', when: 'leased_onto_carrier', verified: false,
    description: 'A copy of the lease to the carrier. The in-cab copy itself was not confirmed. The lease upload is the same item.',
    citation: '49 CFR 376.11 / 376.12 (the written lease). An in-vehicle copy was not confirmed.' }),

  item({ key: 'fire_extinguisher', title: 'Fire extinguisher', category: 'equipment', kinds: ['equipment'], scope: 'truck',
    description: 'UL 5 B:C or more (or two at 4 B:C). 10 B:C or more for placarded hazmat. Charged, mounted, and easy to reach.',
    citation: '49 CFR 393.95(a)' }),
  item({ key: 'warning_devices', title: 'Warning triangles (3) or 6 fusees', category: 'equipment', kinds: ['equipment'], scope: 'truck',
    description: 'Three reflective triangles, or at least six fusees. No flame devices with explosives, flammable tanks, or CNG/LNG.',
    citation: '49 CFR 393.95(f)-(g)' }),
  item({ key: 'spare_fuses', title: 'Spare fuses', category: 'equipment', kinds: ['equipment'], scope: 'truck', level: 'recommended',
    description: 'No longer a federal requirement. The old rule is reserved. Carrying spares is still recommended.',
    citation: '49 CFR 393.95 (current text)' }),
  item({ key: 'pretrip_gear', title: 'Pre-trip check of emergency gear', category: 'equipment', kinds: ['equipment'], scope: 'truck',
    description: 'Confirm the emergency equipment is in place before driving. The checklist itself is reviewed yearly; still check the gear each trip.',
    citation: '49 CFR 392.8' }),
  item({ key: 'tiedowns', title: 'Tiedowns, chains, binders, edge protectors', category: 'equipment', kinds: ['equipment'], scope: 'truck',
    description: 'Enough working tiedowns for the load, and edge protection where a strap can be cut.',
    citation: '49 CFR 393.104, 393.106, 393.110' }),
  item({ key: 'tire_chains', title: 'Tire chains / traction devices', category: 'equipment', kinds: ['equipment'], scope: 'truck', level: 'conditional', verified: false,
    description: 'Required by some states on certain routes and seasons. Mark not needed if you do not run those roads.',
    citation: 'State chain laws (not confirmed here).' }),
  item({ key: 'spare_bulbs', title: 'Spare bulbs and fuses', category: 'equipment', kinds: ['equipment'], scope: 'truck', level: 'recommended',
    description: 'So a lighting defect can be fixed at the roadside.',
    citation: '49 CFR 393 Subpart B (lighting)' }),
  item({ key: 'tire_gauges', title: 'Tire pressure and tread gauges', category: 'equipment', kinds: ['equipment'], scope: 'truck', level: 'recommended',
    description: 'For the pre-trip tire check.',
    citation: '49 CFR 393.75' }),
  item({ key: 'night_gear', title: 'Flashlight, gloves, safety vest', category: 'equipment', kinds: ['equipment'], scope: 'truck', level: 'recommended',
    description: 'For night inspections and standing at the roadside.',
    citation: '' }),
  item({ key: 'first_aid', title: 'First aid kit', category: 'equipment', kinds: ['equipment'], scope: 'truck', level: 'recommended',
    description: 'A basic kit on the truck.',
    citation: '' }),
  item({ key: 'wheel_chocks', title: 'Wheel chocks', category: 'equipment', kinds: ['equipment'], scope: 'truck', level: 'recommended',
    description: 'To secure a parked truck or trailer.',
    citation: '' }),
  item({ key: 'tool_kit', title: 'Tools, tire repair kit, jump pack', category: 'equipment', kinds: ['equipment'], scope: 'truck', level: 'recommended',
    description: 'For minor roadside repairs.',
    citation: '' }),
  item({ key: 'tarps', title: 'Tarps, bungees, dunnage', category: 'equipment', kinds: ['equipment'], scope: 'truck', level: 'recommended', when: 'flatbed',
    description: 'Weather cover and load support for flatbed and hotshot.',
    citation: '' }),
  item({ key: 'phone_power', title: 'Phone mount, charger, ELD power', category: 'equipment', kinds: ['equipment'], scope: 'truck', level: 'recommended',
    description: 'Keeps the phone and the ELD powered.',
    citation: '49 CFR 395.22' }),
  item({ key: 'breakaway', title: 'Breakaway cable and safety chains', category: 'equipment', kinds: ['equipment'], scope: 'truck', level: 'conditional',
    description: 'Trailers that must have brakes need a breakaway system. Safety devices must hold the towed weight. Mark not needed if no trailer applies.',
    citation: '49 CFR 393.43(d); 393.70(d)' }),
];

for (const it of CHECKLIST_ITEMS) {
  if (it.echoOf) it.driverAccess = 'binder';
  else if (it.kinds.includes('equipment')) it.driverAccess = 'equipment';
  else if (it.kinds.includes('binder') && !it.kinds.includes('upload')) it.driverAccess = 'binder';
  else it.driverAccess = 'office';
}

export const DRIVER_EQUIPMENT_KEYS = CHECKLIST_ITEMS.filter((i) => !i.echoOf && i.driverAccess === 'equipment').map((i) => i.key);
export const DRIVER_BINDER_KEYS = CHECKLIST_ITEMS.filter((i) => !i.echoOf && i.driverAccess === 'binder').map((i) => i.key);
export const UNVERIFIED_KEYS = CHECKLIST_ITEMS.filter((i) => !i.verified).map((i) => i.key);
export const itemByKey = (key) => CHECKLIST_ITEMS.find((i) => i.key === key) || null;
export const categoryByKey = (key) => CATEGORIES.find((c) => c.key === key) || null;

// Drug and alcohol files stay out of the one-PDF driver file.
export const DRIVER_FILE_DOC_TYPES = ['medical_card', 'cdl'];
export const ROADSIDE_CATEGORY_KEYS = new Set(['binder', 'truck', 'insurance', 'permits']);

export function answerApplies(when, answers = {}) {
  if (!when) return true;
  const spec = typeof when === 'string' ? { all: [when] } : when;
  const val = (k) => answers?.[k];
  if (spec.all?.some((k) => val(k) === false)) return false;
  if (spec.any) {
    if (spec.any.some((k) => val(k) === true)) return true;
    if (spec.any.every((k) => val(k) === false)) return false;
  }
  return true;
}
