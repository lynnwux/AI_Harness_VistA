# Harness — Leg B: inferred service against `^ENG(6914,*)`

Spike output for the VistA Service Enablement Workbench. Proves the pipeline:

> **menu-navigation trace → LLM infers "this touches file #6914 / `^ENG(6914,*)`" → generated `Harness.*` service → run on VADEMO.**

Navigation observed on VADEMO (`isc-vademo`, IRISHEALTH, namespace `VISTA-DIEGO`):
`EVE → Core Applications → EN (Engineering Main Menu) → EQ (Equipment Management) → 1 New Inventory Entry`, which allocated `ENTRY NUMBER 455` = `^ENG(6914,455,*)`.

All generated names are prefixed `Harness.` so nothing collides with existing production/demo code.

---

## Step 0 — Confirm the inference (read-only, no install)

Paste this at the `VISTA-DIEGO>` prompt. It just dumps the record the New Inventory Entry created:

```objectscript
ZW ^ENG(6914,455)
```

You should see nodes `^ENG(6914,455,0)`, `,1)`, `,8)`, `,9)` … If that record exists, the inference is confirmed: this workflow writes file 6914.

To confirm FileMan reads it by field number (`.01` = ENTRY NUMBER, `5` = SERIAL):

```objectscript
S DUZ=1,U="^" W $$GET1^DIQ(6914,"455,",.01),!,$$GET1^DIQ(6914,"455,",5),!
```

---

## Step 1 — Install the generated service

The service class is [Harness.Equipment6914.API.cls](Harness.Equipment6914.API.cls). Load it on VADEMO in the `VISTA-DIEGO` namespace. Save the file to the box, then:

```objectscript
D $System.OBJ.Load("C:\path\to\Harness.Equipment6914.API.cls","ck")
```

(`ck` = compile + keep source.) Or load via your usual Atelier/VS Code deploy against `VISTA-DIEGO`.

---

## Step 2 — Run it (terminal)

```objectscript
D ##class(Harness.Equipment6914.API).Test(455)
```

Expected: prints `LastIEN`, `NextIEN`, the JSON for record 455 (every field by FileMan number, with external + internal values), and a short list of records.

Individual calls:

```objectscript
W ##class(Harness.Equipment6914.API).NextIEN(),!
W ##class(Harness.Equipment6914.API).GetRecordJSON(455),!
W ##class(Harness.Equipment6914.API).List(5).%ToJSON(),!
W ##class(Harness.Equipment6914.API).FindBySerial("10001"),!
```

---

## What to relay back

Paste the output of **Step 0** and **Step 2**. That tells us:

1. Does the inferred global/record actually exist (Step 0)? → inference correct?
2. Does a DD-driven generated service read it cleanly on the real instance (Step 2)? → Leg B feasible?

## Design notes

- Reads use `GETS^DIQ` (all top-level fields, internal + external) → driven by the live data dictionary, no hard-coded piece offsets.
- Read-only. No `%Save`/`UPDATE^DIE`. It cannot change business data — safe on the TEST account.
- `FindBySerial` uses the legacy `"F"` cross-reference (`^ENG(6914,"F",SERIAL,IEN)`).
- Field→node/piece reference (from the live DD) is in the field map used to justify the inference; screen-3 financial fields (33 CONTROLLED ITEM, 34 INVESTMENT CATEGORY, 35 FCP, 38 SGL, 61 BOC, 62 FUND, 63 A/O, 64 EQUITY) all belong to file 6914.

**Status: throwaway spike artifact.** Kept only if we decide terminal-relay + inference-driven generation is the workbench's Leg-B mechanism.
