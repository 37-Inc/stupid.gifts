# Content admin API — runtime edits and queued admissions

`roadmap-lbbz1.32` provides authenticated read/status, versioned draft requests
and immediate presentation/collection edits in the existing Worker/D1.
There is no dashboard, new Worker/service, scheduler, GitHub API token or second
ingestion path. Staff access uses the owner-approved path-only Access app. The existing `/admin` and
`/api/admin` routes remain retired.

## Explicit boundary

### Product-preparation simplification (not instant publication yet)

New exact-ASIN admissions and automatic care share the same saved preparation
code. Amazon collection, short-copy drafting/review and embedding preparation
run against a read-only canonical catalog view before claiming the catalog
writer. Only the prepared mutations enter the existing publication path. Saved
results resume without another supplier/model call. An exact source fingerprint
prevents a delayed preparation from overwriting a subsequently changed gift;
all catalog identities, including held products, remain part of deduplication.
Old started admissions/recoveries keep their original path and source binding.

This is the first part of `roadmap-lbbz1.32.1`, **not** a claim that the endpoint
can publish independently yet. The hosted queue, whole-catalog publication and
native-index acceptance still serialize admissions behind pending care. Finish
that integration and prove an actual endpoint admission before enabling an
immediate-dispatch credential or describing an addition as live. Do not run a
second supplier batch or take over the existing publisher to demonstrate speed.

The draft includes a **disabled** dispatch adapter for the approved repo-only
GitHub credential. `CONTENT_ADMIN_DISPATCH_ENABLED` remains `false`. Migration
0021 and `GITHUB_CATALOG_DISPATCH_TOKEN` are not provisioned by app deployment.
If later enabled, the adapter can only dispatch `catalog-manual.yml` on `main`
in `admin` mode, after authenticated, same-origin, idempotent admission storage.
It cannot send caller-chosen workflow/ref/ASIN inputs. A durable dispatch claim
prevents duplicate POSTs after retries or lost acknowledgements. Its private
status is distinct from product publication; rejected/unknown dispatch leaves
the original admission queued for the existing coordinator. Provider responses
and credentials are never stored in the request or dispatch record. Merely
enabling this adapter would still use the existing serialized publication
queue: finish that separation and its endpoint proof before changing the flag.
The current GitHub dispatch API's numeric workflow-run ID is retained when
acknowledged, so status can identify the real run rather than infer it from a
timestamp. A malformed/lost response remains unknown and is not redispatched.

`prepareCatalogProducts` is the shared preparation entry point. It restores
saved provider evidence and exact prepared phases before initializing a model
client; retrying a prepared phase does not collect or generate again. It owns
no writer, global pending pointer, or publication. The existing routine driver
calls it before writer acquisition, then applies its version-fenced mutations.
When every phase is already prepared, applying the saved result no longer
requires resolving Amazon/OpenAI credentials again; Cloudflare access remains
necessary for the actual commit and readback.

Article policy is unchanged: ordinary discovery/admission creates a product page
with factual short copy. `--long-editorial` is an explicitly requested optional
mode, not a ranking, commission or traffic threshold; generated articles still
need editorial approval. An article is not required for listing or indexing.

Admissions return HTTP202, `state: awaiting_application`,
`publication: queued_for_existing_coordinator`. Saving an admission
does **not** call Amazon/OpenAI. The existing serialized coordinator consumes
up to ten explicit staff requests after a completed morning run, or through
manual workflow mode `admin`. There is no new clock or HTTP-to-GitHub dispatch
credential. Unrelated pending care finishes first. A durable claim binds the
exact ASINs and original date across retries; late requests stay queued. Existing
identities (including held records) settle without refetching. Accepted runs
report `catalog_identity_recorded` or `not_admitted`, not a promise that every
requested gift is publicly listed. Request GET exposes that saved result.

Factual copy, editorial visibility, collection ordering, active-show selection
and restore use the shared
runtime revision service when enabled: HTTP200 and `application.state:applied`
mean the actual version/head transaction committed, visible within five seconds
without a Worker deploy. GET distinguishes `published` data from
the latest `request`. Do not describe a saved draft as an accepted catalog or
claim live job progress that this API has not observed. Copy/visibility edits
are cumulative, append-only presentation revisions over the accepted catalog;
they do not rewrite supplier observations, identities, licensed content or native
vectors. One projection feeds cards, detail, search, guides, Random, shows and
sitemaps. Unlisting preserves the product URL as a held page. Relisting cannot
override underlying stock/rights holds. Contradictory old semantic vectors are
excluded; correct keyword results remain available without a model call.

The [runtime catalog](RUNTIME_CATALOG.md) publishes data independently of app
builds. No temporary GitHub auto-dispatch bridge or direct product-table writer
is added.
Live staff authentication must be independently verified before `.32` closes.

## Authentication and rollout

Before enabling, review/apply migrations0018/0019 through the runtime bootstrap
against the intended database. Configure a path-scoped Cloudflare Access app
for `stupid.gifts/api/content-admin/*` and a small staff allow policy. Keep the
public website outside that policy. Confirm the Access app and staff identities
with the owner; do not reuse another app's audience or change account settings
merely to run local tests.

The reviewed serving package must explicitly retain these nonsecret bindings:

- `CONTENT_ADMIN_ENABLED=true`
- `CONTENT_ADMIN_TEAM_DOMAIN=https://<team>.cloudflareaccess.com`
- `CONTENT_ADMIN_AUD=<that application's 64-character audience>`
- `CONTENT_ADMIN_STAFF_EMAILS=<comma-separated approved staff emails>`

Missing/invalid configuration denies access. The app publisher loads the reviewed
nonsecret `scripts/catalog/content-admin-settings.mjs` and verifies every setting
on the uploaded version. It names only the owner-approved Access audience and
`cam@37.technology`; it does not provision credentials or change Access policies.
The Free Access app is `6a8715bd-84b8-4ecb-87d0-3ec807731d6a`, team
`37-technology`, six-hour sessions, HTTP-only path-scoped cookie, one email-only
allow policy. Public routes remain outside Access.

The Worker validates Access's signed RS256 JWT, fixed issuer/audience, expiry
and allowed staff email, and audits its signed subject. It never trusts the
email header or a browser-supplied admin secret. It uses `jose`, as in
[Cloudflare's JWT validation example](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
Direct JWT verification is necessary here because
[Static Assets do not forward `ctx.access`](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
Public signing keys are cached; no token is stored or logged. All responses are
private/no-store/noindex, no CORS is enabled, and writes require exact same-origin
`Origin`, JSON, and an `Idempotency-Key`. Request-body bounds are technical input
bounds, not visitor/spending cutoffs.

## Routes

All paths below are relative to `/api/content-admin`.

| Method | Path | Effect |
| --- | --- | --- |
| GET | `/status` | Compiled live identity, bounded D1 owner/build/refresh observations and recent requests |
| GET | `/requests` or `/requests/<id>` | Latest50 private requests or one exact request |
| POST | `/admissions` | Queue one exact-ASIN request on the existing coordinator, deduping all identities |
| GET / PUT | `/products/<publicId>` | Read/apply factual title/description/editorial visibility |
| GET / PUT | `/collections/homepage` | Read/apply the existing6-anchor/18-rotation homepage schema |
| GET / PUT | `/collections/<name>` | Read/apply an ordered ID-only show collection, at most24 public products |
| POST | `/collections/<name>/restore` | Append an earlier saved payload as a new revision; retain all versions |
| GET / PUT | `/active-show` | Read/apply a named saved show choice |
| GET | `/campaigns` | Hash-verified saved website campaign observations, freshness and manual join/content actions |

Every write uses this envelope (example: PUT `/products/<publicId>`):

```json
{
  "catalogRevision": "<revision returned by status>",
  "expectedRevision": 0,
  "reason": "Owner reviewed the complete factual name",
  "payload": {"title": "A complete factual product name"}
}
```

Send `Origin: https://stupid.gifts`, `Content-Type: application/json`, a stable
16–100-character `Idempotency-Key` (letters/numbers/underscore/hyphen), and the
authenticated Access token through the approved client. Do not put the token in
a URL, Git, shell history or a report. An actual CLI must obtain its own staff
Access session; no credentials are created by this implementation.

Other payloads:

- Admission: `{"asin":"B012345678"}`. Only new exact IDs; an existing held
  product is not a new admission. The normal admission path still owns family
  deduplication, factual supplier evidence, copy and saved embeddings.
- Product: any nonempty combination of `title`, `description`, and
  `visibility: "listed" | "unlisted"`. A reason is required. No price, stock,
  licensed-image expiry, identity/slug, affiliate tag or vector edits. A listed
  intent cannot override retailer stock/rights. Original fields/history stay intact.
- Show collection: `{"ids":["<publicId>","<publicId>"]}`.
- Homepage: `{"edition":{"schemaVersion":1,"day":"YYYY-MM-DD","anchors":[6 IDs],"rotation":[18 IDs]}}`.
- Active show: `{"name":"billy-ray"}`. Must be a saved or compiled collection.
- Restore: `{"revision":1}` with the current `expectedRevision` in the envelope.

Revision0 means no prior request for that resource, not an unseen empty public
catalog. GET returns published and requested values separately. A changed
catalog or stale request revision returns409; refetch/review rather than silently
overwriting. Exact idempotent retries return the original record, even after a
later catalog update. A reused key with different input/actor returns409.
Append-only rows are the small actor/reason audit and rollback history. A
conditional atomic INSERT and unique resource/revision guard races; a lost
acknowledgement is settled by exact readback, not by starting another job.

## Status and evidence

`live_awaiting_bookkeeping` means this actual serving Worker's identity matches
the pending D1 release/intent; it is not another deployment request. Otherwise
pending work is `pending_not_confirmed_live`. `lastRefresh` is a completed D1
run observation, **not** proof of hosted successor acceptance. Staff status reads
the exact saved R2 pending intent and hash-bound successor control; it labels
these observations separately from D1 and public serving state. A failed read
is `unknown`. Campaign reports read only the two named saved website feed/review
files, never the unrelated research account or an enrollment API. Stale facts
remain visible as stale, with no invented commission preference or join action.
Missing data returns `manualActions:null`, not zero. The API cannot start a publisher.

Local tests use signed synthetic Access JWTs, SQLite, and mocked public signing
keys. They cover forged/expired/wrong-audience/unauthorized tokens, CSRF,
idempotency, stale revisions, concurrent edits, lost INSERT ACK, held-ASIN dedup,
text/visibility drafts, collection save/order/activate/restore and the real
already-serving/pending-bookkeeping shape. They are not live Access, migration,
provider, job-execution or publication acceptance.
