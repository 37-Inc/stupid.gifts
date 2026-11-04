# Stupid Gifts — Routine release reliability

Owner authorization November4: replace internal quota stops with alerts, recover
the saved update without refetching, verify production and resume the existing job.

## Usage is observation

Routine care's existing `requestLimit: observe` opts both the durable workspace
and D1 adapter out of aggregate HTTP/SQL/read/write cutoffs. Estimates remain in
their original manifests and all known/unknown charges survive restart. Structured
`usageAlerts` report crossings; they do not change a successful publication into
a failure. Standard account-usage reporting can be unavailable without blocking
work. Identity checks, primary reads, request/response sizes, SQL shape, finite
product batches and technical timeouts remain enforced. Legacy migration and
diagnostic profiles are not silently relaxed. Static output uses the provider's
100,000-file Paid limit. Search telemetry evicts old in-memory counters and logs
an advisory rate warning; it never denies visitors because of20/min or256 clients.

## Upload and same-run recovery

The interrupted November4 transfer was reserved at17:08:30.446UTC and settled
unknown at17:09:00.236UTC, consistent with our old30-second request abort. Three
asset batches returned202; no version POST appeared. The original exception was
flattened, so the precise transport cause cannot be proven retrospectively.

The protected account-scoped uploader now permits180seconds/request and returns
retryable503 for transient content-addressed asset-transfer failures instead of
killing Wrangler. Wrangler owns its retry/backoff behavior. Scope violations,
malformed responses and uncertain version writes stay fenced. Error details are
body-free: reason and whether any version POST was dispatched. Tokens, headers,
upload bodies and raw network errors do not enter reports.

For a stopped asset-only command, routine care reconstructs proof from its exact
registered command output/logs. Foreign endpoints, any version POST, a version
acknowledgement or missing evidence prohibit a new upload. It revalidates the
immutable package, native proof, original DB claims, current prior deployment
and same owner before retrying. It appends bounded attempt/ACK pins without
deleting earlier ones. V5 is a generic automatic routine continuation; older
manually reviewed schemas remain readable historical evidence. Its fresh
execution window is at most six hours and ends before original content and
retention deadlines. It never renews supplier observations or source rights.

Activation still uses the existing atomic same-owner DB transaction, exact
uploaded version and real deployed identity/receipt readback. After acceptance,
the successor is saved before regenerable source cleanup. Cleanup failure is
reported separately rather than undoing an accepted release.

The full3388-identity inventory check is a paged job, not a single request.
Routine checks allow up to fifteen minutes rather than aborting at two minutes;
individual request timeouts and original publication/content deadlines still
apply. Historical migration checks retain their original window. Native-proof
errors retain their sanitized code instead of `publication_pending`. Interrupted
read charges remain recorded. Routine continuation uses the existing native-only
proof plus fresh complete inventory, rather than a redundant queueing proof
whose original execution cutoff has already elapsed. This does not change the
native bytes, owner, publication intent or original supplier deadlines.

The `recover` CLI is post-provider only: original config/helper/source remain
frozen, the original review SHA is required, and pre-review phases refuse.
There is no supplier/model phase, new batch, counter reset, new scheduler,
forced owner takeover, subscription change or blanket catalog rewrite.

## Verification

Regression coverage includes asset timeout503 with surviving Wrangler and
retained unknown usage, uncertain version-write refusal, all three aggregate
database estimates exceeded without stopping accounted routine work, repeat
attempt/ACK handling, unchanged product rows and observations after recovery,
expired execution-cutoff recovery, changed/foreign evidence refusal, public
shared-IP/client-map saturation, and alert-only successful completion.

Actual deployment evidence belongs in canonical Beads and the protected run
receipts. A merged implementation or this document does not claim production
acceptance.
