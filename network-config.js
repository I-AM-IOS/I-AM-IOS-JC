// ════════════════════════════════════════════════════════════════════════════
//  network-config.js  —  Browser-readable network configuration
//
//  This file bridges your .env settings to ES-module surfaces and to
//  sovereign-log-inline.js (which can't read process.env directly).
//
//  Update VALIDATOR_ENDPOINT to match your deployed Railway URL.
//  All other values mirror your .env defaults.
// ════════════════════════════════════════════════════════════════════════════

export const VALIDATOR_ENDPOINT = 'https://sovereign-validator-production-xxxx.up.railway.app';
export const VALIDATOR_BACKUPS  = [];           // optional fallback URLs
export const VALIDATOR_PUBKEY   = '';           // reserved for future sig verify
export const FALLBACK_TIMEOUT   = 2000;         // ms before falling back to P2P
export const CHECK_INTERVAL     = 5000;         // ms between background probes
export const QUORUM             = 0.67;
export const NODE_ID            = 'auto';

// ── Inline-script shim ───────────────────────────────────────────────────────
// sovereign-log-inline.js is a plain <script> (non-module) so it reads this
// value from window.SOVEREIGN_CONFIG, which server.js injects via a tiny
// <script> tag rendered before sovereign-log-inline.js loads.
// See server.js for how this is injected, or set it manually in your HTML:
//
//   <script>
//     window.SOVEREIGN_CONFIG = {
//       validatorEndpoint: 'https://sovereign-validator-production-xxxx.up.railway.app',
//       fallbackTimeout: 2000,
//       checkInterval: 5000,
//     };
//   </script>
//   <script src="../sovereign-log-inline.js"></script>
