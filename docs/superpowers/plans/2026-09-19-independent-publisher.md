# Independent activity publisher

Approved design: public-private-radar-design.md. Preserve the Node collector and
serve complete validated snapshots from shared Cloudflare KV, without data
commits or frontend rebuilds.

1. Add a backend-only KV publisher with fixed Cloudflare API destination,
   validated account/namespace configuration, secret authorization and safe errors.
   Reject incomplete, stale, wrong-chain and out-of-order reports before writing.
   Publish the report in one key replacement and retain its coverage/hash/time.
2. Add regression tests for validation, non-overwrite on failure, monotonic
   coverage, authentication and exact payload preservation.
3. Replace scheduled Git commits with a storage publish step after successful
   collection. Keep checkpoint save on failure. Validation jobs remain read-only
   to production storage. Remove the obsolete edge-refresh HTTP request.
4. Provision a narrowly scoped Cloudflare KV edit token in GitHub only after
   browser credential/access confirmation. Do not put the token in files or logs.
5. Run all checks and review; deploy only after storage credentials are configured.
   Verify live KV updates reach the private/public readers without a deployment.
   Retain the asset seed for truthful fallback; it must not replace newer KV data.
