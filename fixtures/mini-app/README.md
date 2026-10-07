# mini-app fixture

A deliberately small legacy PHP app used to exercise the whole pipeline end-to-end:

- `src/Config.php` — T0 constants/config (shared leaf)
- `src/Money.php` — T0 pure helper, duplicated logic to dedupe (`round2` vs `Pricing::r2`)
- `src/Pricing.php` — T1 domain logic with real branching (discounts, tax, edge values)
- `src/InvoiceRepo.php` — T1 data access (raw SQL strings, no DTOs)
- `src/controllers/InvoiceController.php` — T2 route handlers + template
- `templates/invoice.php` — view
- `legacy/old_export.php` — dead code (no static or literal references)
- `routes.php` — route table consumed by the inventory

The simulation levels run against this app; nothing here is production code.
