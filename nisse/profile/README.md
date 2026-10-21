# Nisse distribution profile (M2-3 placeholder)

This is a **template**, not a live profile. `nisse/scripts/install-profile.sh`
copies it into an isolated `DSH_HOME/profiles/<name>` and symlinks the placeholder
Host Integration bundle so the composition can be smoke-tested.

Contents:
- `package.json`: bundles = `dsh-base` + `dsh-web-app` + `nisse-host-integration-placeholder`.
- `cordis.patch.yml`: read-only tool-fs placeholder policy (product policy lands M3).
- Placeholder bundle: `nisse/packages/host-integration-placeholder` (no product behavior).

Rules:
- No DSH core modifications (Route A/M2 freeze).
- The real Host Integration must be a first-party bundle shipped with Nisse (M3),
  not a user-installed plugin.
- Branding/account/telemetry decisions are tracked in `nisse/branding/BRANDING-DECISIONS.md`.
