# Content admin API — private requests, not another publisher

This first slice of `roadmap-lbbz1.32` provides authenticated read/status and
versioned **draft requests** in the existing site Worker and D1 database.
There is no dashboard, new Worker/service, scheduler, GitHub API token or second
ingestion path. Nothing is enabled by default. The existing `/admin` and
`/api/admin` routes remain retired.

## Explicit boundary

Every successful write returns HTTP202, `state: awaiting_application`,
`publication: not_requested` and `applicationEnabled: false`. Saving an admission
does **not** start a job or call Amazon/OpenAI. Editing text/visibility, ordering
a collection, selecting an active show, and restoring a version save a request;
they do **not** change the public site. GET distinguishes `published` data from
the latest `request`. Do not describe a saved draft as an accepted catalog or
claim live job progress that this API has not observed.

Runtime publication is still coupled to static HTML. The next part of `.16.2`
must expose a shared product/collection publication service before these requests
can be safely applied by the single coordinator without a full site build.
This PR deliberately does not add a temporary auto-dispatch bridge, fake
completion state or direct product-table writer that would need replacement.
`.32` remains in progress until application/status reconciliation, private
campaign actions, live authentication and runtime collection acceptance work.

## Authentication and rollout — not performed by this PR

Before enabling, review/apply `migrations/d1/0018_content_admin_requests.sql`
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

Missing/invalid configuration denies access. The current publisher does not yet
carry these new settings, so deployment alone cannot activate this feature.
Activation is a separate reviewed rollout, not a reason to edit a saved release.

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
| POST | `/admissions` | Save one exact-ASIN admission request, deduping all existing identities including holds |
| GET / PUT | `/products/<publicId>` | Read published identity and draft factual title/description/listing intent |
| GET / PUT | `/collections/homepage` | Read/draft the existing6-anchor/18-rotation homepage schema |
| GET / PUT | `/collections/<name>` | Read/draft an ordered ID-only show collection, at most24 public products |
| POST | `/collections/<name>/restore` | Append an earlier saved payload as a new revision; retain all versions |
| GET / PUT | `/active-show` | Read/draft a named show choice, without changing the live active show |
| GET | `/campaigns` | Current compiled commission preference only; private manual actions remain explicitly unknown |

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
  intent cannot override retailer stock/rights during later application.
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
run observation, **not** proof of hosted successor acceptance. R2 successor is
`not_observed` until the original coordinator observer is connected. Failed
build codes and missing/private campaign actions are never replaced with zero
or guessed success. The API cannot start a publisher.

Local tests use signed synthetic Access JWTs, SQLite, and mocked public signing
keys. They cover forged/expired/wrong-audience/unauthorized tokens, CSRF,
idempotency, stale revisions, concurrent edits, lost INSERT ACK, held-ASIN dedup,
text/visibility drafts, collection save/order/activate/restore and the real
already-serving/pending-bookkeeping shape. They are not live Access, migration,
provider, job-execution or publication acceptance.
