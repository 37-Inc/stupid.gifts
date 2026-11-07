# Stupid Gifts — Hosted catalog operations

Implementation reference: [catalog automation specification](CATALOG_AUTOMATION_SPEC.md).
Current rollout is manual-only. Committing this code does not move the active
Codex timer, activate daily discovery, or authorize two production writers.

## One application, one publisher

- `catalog:care` remains the maintained local/hosted operator. `code-only` is its
  owner-invoked serving-only route; it preserves the genuine catalog receipt and
  accepted catalog pointer. See [CODE_ONLY_PUBLICATION.md](CODE_ONLY_PUBLICATION.md).
- `catalog:hosted` coordinates that operator, not another ingestion engine.
  Full care, due photos and explicit one-product canary use the same run journal.
- An immutable pending intent pins source, Pacific day, input version and run
  key. Resume it before new work. Its phases, reservations and publication state
  remain in `RunWorkspace` and the existing D1 controls.
- The private R2 bucket `stupid-gifts-catalog-private`, prefix `catalog-v1`, holds
  original journal/artifact/package bytes. A reservation is durable before an
  external request. Restore verifies hashes and does not copy local locks or
  rewrite historical source bindings. Original expiry registrations govern body
  cleanup; controls, accounting and history remain.
- Provider header/body timeouts exclude the coordinator's own durable journal
  reservation and settlement. Those writes retain their separate bounded R2
  transport and must finish before the caller releases ownership. A slow journal
  must not abort a provider request before dispatch. Real provider timeouts still
  retain the original unknown charge; uncertain writes are never replayed.
- Exact owned native proofs use a finite background window before the short
  core queue observation, rather than counting remote journal latency against
  that observation. Core still rechecks the immutable policy, owner, full source,
  projection, prior receipt, watermark and cutoff before its atomic queue write.
  Arbitrary adapters retain their existing short observation deadlines.
- Background work has a 330-minute process window within GitHub's six-hour job
  ceiling, including cold restoration and full-catalog verification. This is not
  an extra supplier/model allowance or a change to original content deadlines.
  Individual request timeouts and retries remain bounded. Track actual normal
  runtime and cold-restore overhead in the seven-cycle follow-up; slow runs need
  optimization, not a visitor cutoff or a repeated supplier batch.
- Final owned activation resolution likewise performs native proof outside its
  short deployment-observation window. Fresh deployment/identity reads remain
  on both sides of the observation, with the same final receipt/owner CAS.
- Hosted source paths are stable at `/home/runner/stupid-gifts/operators/<SHA>`;
  private state is under `/home/runner/.codex/private/goose-gifts-migration`.
  Finish existing Mac-bound runs locally. Never pretend they were hosted runs.

## Credentials and input handoff

The manual workflow runs only reviewed `main` code in GitHub's `Production`
environment. PR tests have no production secrets. Dependency installation has no
application credentials. Required encrypted secret names are:

| Secret | Purpose |
| --- | --- |
| `STUPID_GIFTS_CLOUDFLARE_API_TOKEN` | Existing Worker, D1 and native/serving Vectorize operations |
| `STUPID_GIFTS_R2_ACCESS_KEY_ID` | Private bucket object access |
| `STUPID_GIFTS_R2_SECRET_ACCESS_KEY` | Corresponding scoped S3 credential |
| `STUPID_GIFTS_AMAZON_CREDENTIAL_ID` | Existing Creators API identity |
| `STUPID_GIFTS_AMAZON_CREDENTIAL_SECRET` | Corresponding existing credential |
| `STUPID_GIFTS_OPENAI_API_KEY` | Approved Luna/editorial and embedding policy |

Provisioning persistent access requires explicit owner approval. Do not copy a
Chrome session, interactive Wrangler OAuth file or Keychain database to GitHub.
No DNS, plan purchase, automatic campaign enrollment or new public bucket is
needed. Do not silently broaden scopes to solve a denied endpoint.

`prepareHostedBootstrap` is read-only. It validates the current accepted seal,
publication settings, canonical semantic catalog hash and optional campaign
inputs. `publishHostedBootstrap` requires fresh matching acceptance evidence,
then seeds versioned metadata and the initial hosted pointer without replacing
an existing different successor. It does not migrate historical runs. The new
automation policy defaults off. Pending runs retain their original input version
when newer metadata is supplied.

## Release and single-writer cutover

1. Finish local pending publication and registered cleanup. Confirm the actual
   serving identity, genuine D1 receipt, resolved build and idle owner.
2. Provision the scoped credentials and verified private inputs. Run manual
   **shadow**: read-only input/source/provider checks, no prepare, supplier/model
   call, D1 claim or remote journal repair. Shadow is not write acceptance.
3. Disable local catalog writes before the owner-invoked hosted **canary**. Pin
   one exact existing public ASIN; reuse copy/edition, with no discovery or model.
4. Verify its actual public identity, D1 receipt, resolved build, idle owner,
   successor, loaded photos/copy and representative QA-labelled flows. Resume an
   interrupted canary under the same identity; never replace its batch.
5. Only after acceptance, activate the new policy and the same workflow's
   Pacific morning/evening wakes plus a bounded catch-up wake. Leave local writing
   off. If cutover fails, stop hosted writes, reconcile pending work, then restore
   local writing—not both. Seven unattended cycles belong to the observation Bead.

The checked-in workflow currently has **no cron**. Do not claim it runs daily.
Do not add another timer just to retry a pending publication. Usage estimates
alert; actual provider throttling, timeouts, finite payloads and integrity checks
remain. A missing usage report is unknown, not zero or a public-search cutoff.

## New policy behavior

`automation-policy.json` is explicit, versioned private input:

```json
{"schemaVersion":1,"enabled":true,"discovery":true,"homepage":true}
```

Absent/disabled policy preserves the legacy ten-product/Monday discovery path.
When activated, quiet-stock throughput scales with catalog size and the 35-day
rotation; all hot/due-photo work, current unavailable rechecks and unresolved
negative labels are additional priority work. Supplier requests use exact chunks
of ten. One hundred is not a business quota.

Daily discovery combines the finite ordinary-theme cohort, optional repeated
zero/sparse search topics, and a small saved campaign-lead observation batch.
Deduplicate all identities before visual admission. Only admitted candidates get
short-copy drafting/review and one embedding; no mandatory article. Saved model
and supplier stages are not refetched on restart. Publication membership is the
exact pinned cohort, not an enlarged arbitrary count cap. Original native and
derived serving indexes update in the same pipeline.

Homepage editing is optional: six weekly anchors plus eighteen daily discoveries
from the accepted catalog, using actual photos/canonical copy. Failure reuses the
last good edition. The separate `/h` assortment is unchanged. Campaign intake
remains optional and account-scoped; unknown/unjoined/stale/unfulfilled offers get
no monetary boost. Join and content-link obligations are manual Slack actions,
never enrollment. See [CAMPAIGN_DIGEST.md](CAMPAIGN_DIGEST.md).

## Verification

Use `test:catalog-automation`, `test:catalog-ops`, `test:catalog-availability`,
`test:homepage`, `test:search-demand`, `test:staging`, both strict typechecks and
lint. Secret-free Linux isolation tests exercise the actual pinned Wrangler
against a simulated provider; that is not a live hosted publication. Record live
canary, cutover and subsequent scheduled evidence separately in canonical Beads.
