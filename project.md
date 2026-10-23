# VistA SE Harness

A structured test harness for VistA supply-chain workflows, driving legacy MUMPS routines through bounded, verifiable service interactions. The first milestone is a read-only **Glove Inventory Review** workflow; the second adds a supply-movement transaction.

---

## Milestone 1 — Glove Inventory Review

### Goal

Identify exact glove catalog items, inspect their inventory-point records, and surface discrepancies between GIP quantities and the linked supply-station's last-reported quantities. No inventory records are mutated.

### VistA Elements

| File | Name | Role |
|------|------|------|
| #441 | Item Master | Catalog item identity — distinguishes medium from large nitrile gloves |
| #445 | Generic Inventory | Inventory-point context: quantities, units, relationships |
| #445.2 | Inventory Transaction | Stock movements — used in Milestone 2, not Milestone 1 |

Field definitions and exact globals come from the installed data dictionaries, not assumed values.

### Key Routine

**PRCPRDIS** — documented VA routine that compares GIP quantities against quantities last reported by a linked supply station. Applies specifically to secondary inventory points with that station linkage.

Discovery starting point: the **PRCP SS QTY DISCREPANCIES** menu option. The menu routine is a discovery entry point; it may require an adapter rather than being directly callable as an API.

### Synthetic Fixture

One secondary inventory point with two catalog items:

- Medium nitrile examination gloves
- Large nitrile examination gloves

Discrepancy scenario: **GIP = 12 boxes, supply-station last report = 9 boxes.**

### User Workflow

1. **Select inventory point** — establish the user's authorized inventory context.
2. **Search** — find "nitrile gloves"; present matching items.
3. **Select item** — require explicit selection of size/identifier (medium vs. large must remain distinct).
4. **Review record** — display inventory point, unit of issue, GIP quantity, last reported supply-station quantity, and reporting time if available.
5. **Inspect discrepancy** — show the difference without assuming which count is authoritative.
6. **Return traceable result** — link the answer back to the selected VistA records and the legacy comparison output.

A chat interface may initiate the search; a small table is preferred for item selection and quantity review.

### Harness Assignment

> Discover the PRCP SS QTY DISCREPANCIES option and PRCPRDIS dependencies. Build a structured discrepancy inquiry for one authorized secondary inventory point. Add item selection for medium and large nitrile gloves. Preserve legacy discrepancy semantics and units. Evaluate the service against the existing report using identical sandbox data.

Inspect: menu setup, user context, called routines, FileMan definitions, output formatting.

### Acceptance Criteria

| Case | Expected behavior |
|------|------------------|
| Medium and large gloves both exist | Results preserve separate item identities |
| GIP 12 boxes; station 9 boxes | Same discrepancy as the legacy PRCPRDIS report |
| Quantities match | Same inclusion/exclusion behavior as the legacy report |
| Supply-station data is missing | Preserve legacy behavior — do not substitute zero |
| User lacks inventory-point access | Access denied |
| Inquiry completes | No business inventory records are changed |

---

## Milestone 2 — Supply-Movement Transaction (planned)

Investigate the internal glove replenishment workflow: distribution-order lifecycle, **PRCPOPL** for processing, **PRCPOPP** for posting. Requires tracing complete order lifecycle and side effects before writing any specification.

**Note:** PRCPESTO maintains storage locations but has not been verified to directly reassign an individual item to a bin. Do not use that as a write-back specification without confirmation.

---

## Development Notes

- Field and global definitions must come from the installed data dictionaries.
- Exact item identifiers for the synthetic fixture should be resolved from File #441, not hardcoded.
- The harness evaluates services against legacy output on identical sandbox data — not unit tests in isolation.
- **Every new HTML page gets its own favicon, created with the page.** Embed it as an inline SVG data URI in the `<head>` (`<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,…">`), so no extra file has to be served. Match the existing icons (`capability-graph/decide.html`, `workbench-demo.html`): a 32×32 viewBox, a dark rounded tile (`#141b24`, `rx='7'`) and the page palette — blue `#3d9cf5`, green `#7ee787`, light `#e6edf3` — with one simple motif for what the page is. URL-encode `#` as `%23`, `<` as `%3C`, `>` as `%3E` and use single quotes inside the SVG. For a generated page, put the icon in its template (`*.template.html`). Check it reads at 16 px.
