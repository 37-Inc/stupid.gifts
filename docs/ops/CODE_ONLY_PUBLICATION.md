# Maintained code-only publication

Use the clean reviewed Node22 checkout and the same scrubbed environment as
catalog care. This is an owner-invoked command, not another scheduler.

```sh
npm run catalog:care -- code-only prepare --run descriptive-label
npm run catalog:care -- code-only start --run descriptive-label
npm run catalog:care -- code-only resume --run descriptive-label
npm run catalog:care -- code-only status --run descriptive-label
```

`prepare` is read-only remotely. `start` also prepares when needed; omitting the
verb means `start`. Resume the same label/source/config, never a replacement
label to escape an uncertain upload or activation. Root CLI wiring dispatches
the `code-only` arguments to `codeOnlyMain`.

- Existing production scope, Wrangler OAuth, protected local workspace and
  accounted uploader are reused. No merchant or model credentials/calls exist.
- Preparation pins the genuine accepted persistent catalog seal, exact catalog
  pointer bytes, current D1 barriers and actual serving deployment. The serving
  deployment can be newer than the catalog receipt.
- Existing presentation/analytics settings come from the accepted run's saved
  publication config, or the latest matching maintained serving config. The
  protected current semantic policy is preserved. No unpublished homepage
  edition is silently selected.
- The normal publisher builds and verifies once, uploads, activates, reads back
  uncertain writes and resolves ownership. Existing native delivery proof is
  reused behind unchanged D1 watermarks; no vectors or products are rewritten.
- Acceptance checks the actual public identity, resolved build, idle owner and
  original genuine catalog receipt. The separate private serving-only receipt
  lives in `daily-catalog-care/code-only/<label>/success.json`. Catalog
  `last-success.json` and product/supplier timestamps stay unchanged.
- A committed final-resolve response lost in transit resumes from body-free
  controls. It does not reacquire ownership or reconstruct expired bodies.
- Accepted generated-output cleanup uses the source-only cleanup capability
  after deployment locks are released. Cleanup attention is advisory; retained
  packages, original manifests, accounting and receipts are preserved.

An existing successful label is a historical no-op, not proof it is still the
current serving release. `status` reads local records only. Missing credentials,
source/catalog drift or unresolved provider state requires attention; none
authorizes another merchant batch, takeover, quota reset or blind POST retry.
