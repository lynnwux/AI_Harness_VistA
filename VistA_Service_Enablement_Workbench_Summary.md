# VistA Service Enablement Workbench

## Purpose

The **VistA Service Enablement Workbench** is an AI-assisted engineering harness for understanding legacy VistA workflows, correlating user interactions to the underlying code and data, identifying reusable capability boundaries, and generating modern service interfaces that can be tested and verified against the legacy system.

> **Step through the legacy workflow on the left; watch the modern service model emerge on the right.**

This is not primarily an “AI that writes code” system. It is a system that maintains a **living, verifiable specification of a legacy capability**, correlates it to real user behavior, and can generate and validate a modern service from that specification.

## Core Design Principles

### 1. Developer selects the modernization scope

The developer chooses a bounded VistA capability, workflow, menu, file, or service-enablement goal.

Example:

- Domain: Engineering
- Menu: Equipment Management
- Workflow: Inventory Edit
- Goal: Modernize equipment update as a service
- Target: REST/API
- Environment: VistA sandbox
- Constraint: Preserve legacy behavior and authorization

The developer defines the **root/boundary**. The harness discovers the actual dependency surface.

### 2. Observe the user workflow, not just the code

The system should understand VistA from both:

**Static discovery**
- Menus and options
- Routines and RPCs
- FileMan files and fields
- Globals and cross-references
- Security keys
- Dependencies

**Runtime workflow tracing**
- Menu selections
- Prompt/response sequence
- User inputs
- Option context
- Routines executed
- Data read/written
- State changes
- Result/error behavior

Runtime evidence shows which parts of the static dependency graph actually matter to a specific workflow.

---

## First POC Scope: Engineering Equipment Management

The first POC should be intentionally narrow and centered on the **Engineering Equipment Management menu**.

Initial workflows:

1. **New Inventory Entry**
2. **Inventory Edit**
3. **Display Equipment Record**
4. Later: **Generate PM Schedule**
5. Later: **Record Equipment PMI**

These provide a useful mix of create, update, lookup, and maintenance workflow behavior.

The objective is to show that apparently different menu workflows can **diverge at the user-interface layer but converge on shared underlying capabilities and data**.

```text
New Inventory Entry ───────┐
                           ├── Equipment Lookup
Inventory Edit ────────────┤
                           ├── Equipment Validation
Display Equipment Record ──┘
                           │
                           ▼
                    Equipment Record
```

Candidate reusable capabilities might include:

- `GetEquipment`
- `CreateEquipment`
- `UpdateEquipment`
- `UpdateEquipmentLocation`
- `GetMaintenanceHistory`
- `GenerateMaintenanceSchedule`
- `RecordMaintenanceEvent`

---

# Workbench User Experience

## Split-Screen Layout

The app should be a synchronized two-pane workbench.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ VistA Service Enablement Workbench                                         │
│ Engineering Equipment Management                         Session: ENG-001   │
├────────────────────────────────┬────────────────────────────────────────────┤
│                                │                                            │
│      VISTA SIMULATION          │        SERVICE / DATA MAPPING              │
│                                │                                            │
│ 1 New Inventory Entry          │ Current Interaction                        │
│ 2 Multiple Inventory Entry     │ Legacy execution                           │
│ 3 Inventory Edit        ◀      │ Data touched                               │
│ 4 Display Equipment Record     │ Business rule                              │
│ 5 Equipment Reports ...        │ Candidate service                          │
│ 6 PM Parameters ...            │                                            │
│ 7 Generate PM Schedule ...     │ PATCH /equipment/{id}                      │
│ 8 Record Equipment PMI ...     │                                            │
│                                │                                            │
│ Select Option: 3               │                                            │
├────────────────────────────────┴────────────────────────────────────────────┤
│ Workflow: Engineering → Inventory Edit → Select Equipment → Edit → Save    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Left pane: VistA simulation

The left side reproduces the VistA Engineering menu and guides the user through a simulated or traced workflow.

Example:

```text
Engineering
  ↓
Equipment Management
  ↓
Inventory Edit
  ↓
Select Equipment
  ↓
Display Existing Values
  ↓
Edit Location
  ↓
Validate
  ↓
Save
```

### Right pane: Service/Data Mapping

The right side updates as the user progresses.

Suggested tabs:

- **Interaction**
- **Data**
- **Service**

For each user step, show:

**Interaction**
- Menu
- Option
- Prompt
- User action
- Security context
- Workflow position

**Data**
- FileMan file
- Field
- Global
- Cross-reference
- Read/write behavior
- State transition

**Service**
- Candidate capability
- Suggested command/query
- Candidate API
- Reuse across workflows
- Confidence/provenance

---

## Example Correlation

When the user chooses an equipment record:

```text
LEFT

Select EQUIPMENT: MRI-001

RIGHT

Interaction:
Select Equipment

Legacy Context:
Engineering → Inventory Edit

Data:
Equipment record lookup

Candidate Capability:
GetEquipment

Candidate API:
GET /equipment/{id}
```

When the user changes location:

```text
LEFT

Enter LOCATION: RADIOLOGY

RIGHT

Interaction:
Change Equipment Location

Data:
Equipment.location

Validation:
Valid location required

Candidate Capability:
UpdateEquipmentLocation

Candidate API:
PATCH /equipment/{id}
```

When the user saves:

```text
LEFT

Save changes? YES

RIGHT

State Transition:
Equipment Updated

Writes:
Relevant equipment fields
Cross-references updated

Candidate Command:
UpdateEquipment
```

---

# Interaction-to-Capability Mapping

The central artifact should be an **Interaction-to-Capability Map**.

```text
USER ACTION
     │
     ├── reached through → MENU / OPTION
     │
     ├── implemented by → ROUTINE / ENTRY POINT
     │
     ├── accesses → FILE / FIELD / GLOBAL
     │
     ├── validates → BUSINESS RULE
     │
     ├── changes → STATE
     │
     └── maps to → MODERN CAPABILITY
```

Example:

| User Interaction | VistA Option | Code | Data | Candidate Service |
|---|---|---|---|---|
| Search equipment | Inventory Edit | Routine A/B | Equipment file | `GetEquipment` |
| Display equipment | Display Equipment Record | Routine B/C | Equipment file | `GetEquipment` |
| Update equipment | Inventory Edit | Routine D/E | Equipment file | `UpdateEquipment` |
| Generate PM schedule | Generate PM Schedule | Routine F/G | PM data | `GenerateMaintenanceSchedule` |

This allows the workbench to identify where workflows **diverge and converge**.

---

# Shared Evidence Model

Agents should not communicate only through prose or chat history. They should write into a structured **Capability Graph / Evidence Store**.

```text
Capability
 ├── Menu
 ├── Option
 ├── User Action
 ├── Security Policy
 ├── Routine
 ├── Entry Point
 ├── RPC
 ├── File
 ├── Field
 ├── Global
 ├── Cross-reference
 ├── Business Rule
 ├── Validation
 └── Side Effect
```

Every inferred rule should retain provenance.

```text
Business Rule: BR-017

Rule:
Equipment location must reference a valid location.

Evidence:
Routine XYZ + offset

Observed In:
Inventory Edit workflow

Affects:
Equipment location field

Confidence:
High
```

The **capability graph and executable specification are the durable state**, not the agents' conversation history.

---

# Executable Specification

Once discovery reaches sufficient coverage, the workbench creates an **executable specification**.

The spec should capture:

- Capability name
- Legacy workflow
- Commands and queries
- Inputs and outputs
- Business rules
- Validation
- Security requirements
- State transitions
- Side effects
- Error behavior
- SLOs
- Acceptance tests
- Legacy verification oracle
- Provenance

Example:

```text
CAPABILITY
Update Equipment

COMMAND
UpdateEquipment

INPUTS
Equipment ID
Location
Status
Vendor
...

BUSINESS RULES
BR-001
BR-002
...

SECURITY
Required option / role / policy

STATE TRANSITIONS
Existing state → Updated state

SIDE EFFECTS
FileMan writes
Cross-reference updates

ACCEPTANCE TESTS
...

LEGACY ORACLE
VistA sandbox
```

Implementation is generated from the executable spec. The spec, not the generated code, is the primary modernization artifact.

---

# Harness Workflow

The outer workflow should remain deterministic for the first implementation.

```text
Developer Selects Scope
          ↓
Workflow Trace / Simulation
          ↓
Static + Runtime Discovery
          ↓
Interaction / Execution / Data Correlation
          ↓
Capability Graph
          ↓
Executable Specification
          ↓
Generate Modern Service
          ↓
Deploy to Reproducible Sandbox
          ↓
Differential Verification
          ↓
User Evaluation
          ↓
Feedback / Telemetry
          ↓
Specification Delta
          ↓
Regenerate
```

Short form:

> **Goal → Discover → Specify → Build → Evaluate → Deploy → Observe → Improve**

---

# Multi-Agent Architecture

The system can use multiple specialized agents inside deterministic phases.

## Discovery Agents

**Navigation Agent**
- Menu trees
- Options
- Prompt sequences
- Security keys
- Entry/exit behavior

**Code Archaeology Agent**
- M routines
- Entry points
- Call chains
- RPCs
- Legacy implementation

**Data Agent**
- FileMan files
- Fields
- Globals
- Cross-references
- Data relationships

**Behavior Agent**
- Validation
- Defaults
- State transitions
- Business rules
- Error conditions
- Side effects

**Dependency Agent**
- Recursively follows newly discovered dependencies

## Build Agents

**API Architect**
- Generates the modern service contract

**Service Agent**
- Generates the implementation

**Security Agent**
- Preserves identity and authorization policy

**Test Agent**
- Generates acceptance and regression tests

**Deployment Agent**
- Builds the reproducible sandbox deployment

---

# Evaluation Framework

Evaluation should be a first-class layer of the workbench.

## 1. Behavioral Fidelity

Does the modern service behave like VistA?

```text
                  Test Scenario
                 /                             ▼               ▼
         Legacy VistA      Modern Service
                \               /
                 \             /
                  ▼           ▼
                    Compare
```

Compare:

- Business result
- State change
- Error behavior
- Validation
- Security behavior
- Side effects

The comparison should be based on **semantic equivalence**, not necessarily byte-for-byte output.

## 2. Contract Correctness

Does the generated service satisfy the executable specification?

Evaluate:

- API schema
- Required fields
- Validation
- Business rules
- Error conditions
- State transitions

## 3. Non-Functional Evaluation

Evaluate:

- Latency
- Throughput
- Availability
- SLOs
- Reliability

## 4. Security and Governance

Evaluate:

- Identity continuity
- Role/policy continuity
- Authorization
- Auditability
- User attribution

Key principle:

> The agent/service layer should reuse the same user identity and policy context as the upstream operational environment wherever possible.

## 5. Harness Evaluation

Potential metrics:

- Time from scope to testable service
- Requirements correctly discovered
- Behavioral equivalence
- Test coverage
- Defects escaping evaluation
- Human interventions
- Agent retries
- Token/compute cost
- Time to incorporate feedback
- Regression rate

---

# Product Improvement Loop

Feedback should become **tests**, not simply another coding prompt.

```text
User Feedback
        ↓
Measurable Evaluation Failure
        ↓
Investigation
        ↓
Spec Delta
        ↓
New Regression Test
        ↓
Regenerate
        ↓
Evaluate Again
```

Pattern:

> **Feedback → measurable evaluation → spec delta → regenerate → verify**

---

# Three Service Enablement Modes

The long-term workbench can support three primary paths.

## 1. Transaction Modernization

Use when the goal is to modernize an operational VistA transaction.

Examples:

- Create equipment
- Update equipment
- Record maintenance

Output:

- Modern command/API
- Generated UI/workflow
- Differential verification against VistA

## 2. Knowledge Enablement

Use when the goal is to make VistA information searchable and understandable.

Output:

- Catalog
- Search
- Semantic relationships
- Data lineage
- Provenance
- Agent-consumable knowledge layer

## 3. Analytics Enablement

Use when the goal is to extract a defined dataset for analysis.

Output:

- Extracted analytical dataset
- Reconciliation
- Data-quality metrics
- High-level validation graphs

The graphs are primarily **evidence that data transfer and transformation are correct**, not the final analytics product.

---

# Development Sequence

## Phase 1 — UI Prototype

Build the split-screen workbench with scripted Engineering workflows.

No live VistA tracing required yet.

**Goal:** validate the interaction model.

## Phase 2 — Runtime Tracing

Capture:

- Menu/option
- Prompt/response
- Routine execution
- FileMan writes
- Resulting state

**Goal:** produce a deterministic workflow trace.

## Phase 3 — Static + Runtime Correlation

Combine:

- Static menu/code/data dependencies
- Runtime workflow evidence

**Goal:** build the Interaction-to-Capability Map.

## Phase 4 — AI Capability Inference

Allow AI to identify:

- Workflow convergence
- Workflow divergence
- Shared business capabilities
- Candidate service boundaries

**Goal:** generate evidence-backed service candidates.

## Phase 5 — Executable Spec + Service Generation

Generate:

- Executable specification
- API contract
- Modern implementation
- Sandbox deployment
- Test corpus

**Goal:** produce a usable modern service.

## Phase 6 — Differential Verification

Replay captured scenarios against:

- Legacy VistA
- Modern service

**Goal:** prove semantic behavioral equivalence.

## Phase 7 — Product Improvement Loop

Use:

- User feedback
- Telemetry
- Failed SLOs
- Regression tests

to update the specification and regenerate the service.

---

# Recommended First Milestone

The first milestone should be intentionally small:

> **Start Trace → navigate through Engineering Equipment Management → Stop Trace → see Menu → Option → Routine → File → State Change → Candidate Service**

Start with:

1. New Inventory Entry
2. Inventory Edit
3. Display Equipment Record

First success criterion:

> **Can the workbench show that multiple user journeys touch overlapping VistA capabilities and identify where they diverge and converge?**

If that works, add:

- PM Schedule
- PMI recording
- Service generation
- Differential verification
- Feedback-driven regeneration

---

# Core Positioning

The workbench is not simply a code generator.

> **A system that observes how users interact with VistA, correlates those interactions with the underlying code and data, maintains a living executable specification of the capability, and generates a verifiable modern service from it.**

Concise tagline:

> **Step through the legacy workflow on the left; watch the modern service model emerge on the right.**
