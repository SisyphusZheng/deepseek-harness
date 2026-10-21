# nisse/ — Nisse fork layer (DSH distro)

This directory is the Nisse-owned part of the DSH fork. It is intentionally kept
small: product/runtime packaging decisions, patch queue, release config and tests.
No DSH core changes are allowed without user approval (ADR-0005 + v3 Route A freeze).

## Branches
- `master` — upstream mirror (kept at pinned release tag for M2 baseline).
- `nisse/main` — Nisse distro branch (starts at `dsh-v0.2.1-rc.2`).
- `upstream-sync/<tag>` — merge/rebase rehearsal branches (M2-5).

## Layout
- `nisse/patches/<id>/PATCH.md` — approved core patches only (currently empty).
- `UPSTREAM.txt` — pinned upstream record.
- `.nisse/` (created during builds) — local build logs/artifacts, gitignored.

## M2 status
- M2-0 preflight: done (see main project `m2/preflight-report.txt`).
- M2-1 fork/scaffold: this commit.
- M2-2 clean build baseline: in progress.
