# M2-2 build baseline — dsh-v0.2.1-rc.2

Date: 2026-10-21 (worktree `/Users/zhengzhi/Documents/projects/nisse-dsh`)
Environment: macOS 26.5.1 arm64, Node v24.18.0, pnpm 11.28.5 (corepack, isolated COREPACK_HOME)

| Step | Command | Result | Time |
|---|---|---|---|
| install | `pnpm install --frozen-lockfile` | PASS | 24.1s |
| typecheck | `pnpm run typecheck` | PASS (5/5 gates) | 97.92s |
| build | `pnpm run build` | PASS (9/9 gates) | 27.03s |
| build check | `pnpm run build:check` | PASS (2/2 gates) | 7.95s |

Notes:
- First install against registry.npmjs.org stalled on large tarballs (network-bound); retry with
  `--registry=https://registry.npmmirror.com --network-concurrency=16` completed in 24.1s.
  No mirror is committed to the repo; lockfile integrity remains enforced.
- No DSH source changes were made for the baseline; `git status` is clean.
- Artifact hashes are recorded in `UPSTREAM.txt`.
- Disk after install: node_modules 2.0G, pnpm store 1.9G; free 25 GiB.
