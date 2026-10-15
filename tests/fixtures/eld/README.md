# ELD sample fixtures (test data only)

These CSVs are **approximations** of vendor IFTA / miles-by-state exports, written from public
docs and help articles. They are **not official exports**, and real column names may differ by
report, account settings, and version. All trucks, drivers, and numbers are fake.

| File | Modeled on | Notes |
|---|---|---|
| `hos247-ifta-miles-by-state.csv` | HOS247 IFTA / miles-by-state report | Per-day, per-state rows with odometers and fuel. Layout is a guess, since there's no public column spec. |
| `motive-ifta-trips.csv` | Motive IFTA trip reports (`date`, `jurisdiction`, `vehicle.number`, `start_odometer`, `end_odometer`, `distance` in the developer API) | Fractional odometers and distance. |
| `samsara-ifta-vehicle-report.csv` | Samsara IFTA vehicle report (monthly per vehicle/jurisdiction, distance in miles, tax-paid gallons) | A month column with no day, imported as the 1st of the month. Samsara's raw IFTA *detail* CSV (`distance_meters`, `start_odo_meters`, epoch ms) isn't covered: it's in meters and would need a converter. |

`tests/js/eldVendors.test.mjs` checks that each file auto-maps and parses with no errors.
