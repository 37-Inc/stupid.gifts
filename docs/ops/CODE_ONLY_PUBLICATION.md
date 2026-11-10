# Maintained code-only publication

Small code/UI fixes use the **existing GitHub Catalog care workflow, manual
mode `code`**, after merge. This uses the same `catalog-production` concurrency
and protected pending pointer as catalog care, not another publisher/scheduler.
It builds over the accepted catalog without product refresh, discovery, copy
generation or embedding calls. A pending catalog publication must finish first;
`code` never restarts its provider phases. A scheduled wake can finish an already
pending code release before starting new maintenance.

```sh
gh workflow run catalog-manual.yml --ref main -f mode=code
```

The source-bound `serving-<commit12>` intent is idempotent. Hosted records and
journals use the existing private R2 store, not a Mac's historical pointer.
The code-only child receives Cloudflare/storage credentials only, not supplier
or model keys. `code-only-serving` tracks serving configuration separately from
the unchanged genuine catalog `last-success` pointer. Lost acknowledgements use
the same saved package, owner and exact readback, never a replacement run.

Normal maintenance streams phase start/completion and elapsed time into Actions
logs. Confirmed atomic D1 writes use their acknowledged next-owner cursor;
only uncertain responses trigger the extra immutable receipt/owner readback.

For local operation/recovery, use a clean reviewed Node22 checkout and the same
scrubbed environment as catalog care. These remain owner-invoked commands:

```sh
npm run catalog:care -- code-only prepare --run descriptive-label
npm run catalog:care -- code-only start --run descriptive-label
npm run catalog:care -- code-only resume --run descriptive-label
npm run catalog:care -- code-only recover --run descriptive-label
npm run catalog:care -- code-only status --run descriptive-label
```

`prepare` is read-only remotely. `start` also prepares when needed; omitting the
verb means `start`. Resume the same label/source/config, never a replacement
label to escape an uncertain upload or activation. Root CLI wiring dispatches
the `code-only` arguments to `codeOnlyMain`.

After a reviewed controller fix, `recover` can finish an existing saved intent.
It validates the original clean checkout/helper and the clean descendant
controller, then retains the original build source, config, authority, workspace,
owner, deadlines and accounting. The controller identity is recorded separately;
it cannot prepare a new run or call suppliers/models. Explicitly abandoned
prebuild attempts are terminal, not recovery candidates.

- Existing production scope, reviewed Cloudflare credential, protected workspace and
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
- UI-only publication reads the exact accepted **public** projection, including
  articles, and verifies its snapshot/projection hashes, genuine catalog receipt,
  original native journal hashes, owner and pending/write watermarks afresh at
  build/activation boundaries. Unpublished private edits are neither promoted nor
  asserted unchanged; they belong to the next normal catalog publication. This
  avoids repeated private source/vector recapture without caching mutable truth.
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
current serving release. `status` reads saved records only. Missing credentials,
accepted-public/receipt/native barrier drift or unresolved provider state requires attention; none
authorizes another merchant batch, takeover, quota reset or blind POST retry.
