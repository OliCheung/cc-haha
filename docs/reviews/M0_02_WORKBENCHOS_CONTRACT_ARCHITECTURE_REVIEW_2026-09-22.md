# M0-02 --- WorkbenchOS M1 Contract Architecture Review

Project: WorkbenchOS\
Review ID: M0-02-R1\
Review Type: Contract & State Model Review\
Review Date: 2026-09-22

## Review Decision

**ACCEPT WITH MINOR REVISIONS**

The M0-02 design successfully converts the WorkbenchOS concept into an
implementable boundary model.

Accepted principles:

-   WorkbenchOS owns Task / Run / Approval / Recovery / Audit control
    state.
-   cc-haha remains runtime foundation, not WorkbenchOS source of truth.
-   Workbench Task is independent from cc-haha Session.
-   Contracts must be versioned.
-   Idempotency and recovery are first-class requirements.
-   Native execution details remain behind adapters.

## Accepted Freeze Items

FREEZE_V0.1:

-   Identity model
-   Task / Run separation
-   TaskEnvelope concept
-   ResultEnvelope concept
-   EventEnvelope concept
-   Idempotency rules
-   Approval boundary
-   Source-of-truth ownership
-   AgentPort abstraction
-   SQLite durable journal direction

## Required Revisions

### 1. Keep M1 implementation small

The SQLite event journal direction is accepted.

M1 should implement:

    SQLite events
    +
    current projections
    +
    recovery checks

Avoid building a complete event-sourcing framework.

### 2. Delay browser integration

BrowserAutomationPort remains a contract only.

Do not implement:

-   ChatGPT DOM handling
-   selectors
-   Electron IPC changes
-   browser automation

until the deterministic core works.

### 3. Freeze responsibility, not every field

V0.1 means ownership and boundaries are stable.

It does not mean every schema field is permanently fixed.

## Recommended First Implementation Slice

    contracts
    +
    task/run reducers
    +
    SQLite journal
    +
    idempotency primitives
    +
    fake AgentPort
    +
    contract tests

Excluded:

-   real ChatGPT integration
-   real cc-haha runtime adapter
-   multi-agent routing
-   automatic commit/push

## Architecture Direction

    WorkbenchOS Core

        |
        +-- Contracts
        +-- State Machine
        +-- Durable Journal
        +-- Fake AgentPort
        +-- Deterministic Tests

            later

        +-- CcHahaRuntimeAdapter

            later

        +-- ChatGPTWebAdapter

## Decision

Proceed to:

**M0-03 --- Implementation Architecture Plan**

M0-03 should define:

-   module layout
-   file boundaries
-   first coding slice
-   testing strategy
-   implementation order

No production implementation should begin before M0-03 review approval.
