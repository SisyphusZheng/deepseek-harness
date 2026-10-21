// M2 placeholder for Nisse Host Integration (Route A: no DSH core changes).
// The real implementation (turn/event/approval/cancel mapping + Bot orchestration
// services) lands in M3. This placeholder only proves the profile composition and
// that a first-party bundle can load inside an isolated DSH host.
export const name = 'nisse-host-integration-placeholder'
export const inject = []

export function apply(ctx, config = {}) {
  try {
    ctx.logger?.info?.('nisse.host_integration_placeholder_loaded', {
      mode: 'm2-placeholder',
      note: 'real Host Integration lands in M3',
    })
  } catch {}
  // Unique marker for the M2-3 smoke test (also visible on stdout of the host).
  console.log('[nisse-host-integration-placeholder] loaded (M2-3 smoke)')
}
