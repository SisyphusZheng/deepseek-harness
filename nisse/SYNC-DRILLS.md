# Upstream sync drills (M2-5)

Date: 2026-10-21. Fork: dsh-v0.2.1-rc.2 baseline, 0 core patches.

| Drill | Commits | Diff | Conflicts | Time |
|---|---|---|---|---|
| rc.1 → rc.2 | 9 | 456 files, +4921/−845 | 0 | 6 s |
| alpha.5 → rc.1 | 4 | 355 files, +355/−355 | 0 | 0 s |
| rc.2 → nisse/main | 0 | — | 0 | 0 s |

Notes:
- Rehearsal branches are local only: `upstream-sync/rc1-to-rc2`, `upstream-sync/alpha5-to-rc1`.
- Because there are no core patches, sync cost is the upstream diff only; this is the main benefit of the Route A freeze.
- ADR-0005 thresholds: 3 person-days/sync, 25 patches or 5000 delta lines, 5 P0 contract failures, non-reproducible build.
  Current drill is far below all thresholds.
- Re-measure after Nisse Host Integration/profile lands (M3+).
