# Public and Personal Editions Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task-by-task. User instructed continuous execution through the approved design.

**Goal:** Separate public artifacts from personal features while preserving the existing personal dashboard.
**Architecture:** Shared App shell accepts optional personal components from a private entry point. Public entry imports only neutral components. A clean export includes public sources and excludes private entry, owner/risk modules, personal docs/history and configuration.
**Tech Stack:** Existing React, Vite, viem and Cloudflare Worker.
**Spec:** ../specs/2026-09-19-public-private-radar-design.md

## Global constraints
Read-only; no owner defaults in public source or bundle. Do not hide stale data warnings. Personal app remains intact. Provider activation and access policy need actual external configuration. User supplied private login identity in chat; never commit it to the public repository.

## Tasks
- [ ] Write failing public component tests for blank wallet/no automatic owner lookup, retained inventory, omitted personal panels and safe partial values.
- [ ] Separate App composition and entry points; public Planner is Coming soon, personal Planner retained. Inject private defaults only from personal entry. Verify public bundle contains no owner address or private feature code.
- [ ] Improve public cockpit loading with elapsed time, cancellable requests, completed progress and safe snapshot/partial handling. Test failed/changed snapshots and cancellation.
- [ ] Fix market chart scale with token selection, gaps and precise small prices; test accessible selection and stable flat input.
- [ ] Validate all public routes, source warning states and desktop/390px layouts; run tests/lint/both builds.
- [ ] Create clean public export with MIT license for original code, notices, reproducible package lock, README and deployment config. Validate imports, tests/build and sensitive-data scan before public publication.
- [ ] Protect private production and preview access for user's supplied identity; publish separate public repository/site only after review and working builds. Verify unauthenticated private denial and public availability independently.

## Later operational milestone
Request quotas/deduplication and durable independent publisher are tracked in the overarching spec and remain required for full completion. Public/private UI completion alone does not close the goal.
