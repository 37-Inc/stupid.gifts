# Independent application and catalog publication

The site Worker renders accepted catalog data from private R2 and D1. Product
text, images, homepage IDs and search descriptors are **not compiled into the
application**. Existing React cards, search, Random and analytics are reused.

## Three small responsibilities

- **App deployment:** manual `Application deploy` workflow, mode `deploy`.
  Builds the shared client/CSS/font/brand assets and Worker only. It uses
  `app-production`, not the catalog queue, and receives no Amazon/model keys.
  It does not claim a catalog owner or change catalog rows/receipts/pointers.
- **Catalog care:** the existing morning/evening coordinator is still the only
  catalog writer. Supplier work, factual copy review, embeddings and both search
  indexes keep the existing pipeline. Publication uploads approved public data,
  then advances one D1 head with its genuine receipt/build resolution/idle owner.
  It does **not** build Next pages, upload application assets or activate a Worker.
- **Collections:** authenticated staff and the daily homepage editor share
  `applyRuntimeCollection`. ID-only save/order/activate/restore is one small D1
  transaction, without suppliers, models, vectors or an app deployment. A newer
  manual edition wins over an already-prepared daily edition.

```sh
gh workflow run app-deploy.yml --ref main -f mode=deploy
```

The once-only `bootstrap` mode holds the existing catalog queue while settling
any exact already-live code intent, installing additive migrations0018/0019,
authenticating the accepted public projection, preserving its original receipt
and copying only already-cleared assets. It deploys the runtime app before
enabling data-only routine publication. It never refreshes a product or invokes
a model. Existing show/homepage editions are seeded as versioned ID-only data,
not re-curated during cutover. A saved original bootstrap plan survives retries;
another owner's pending work is not taken over.

## Acceptance and recovery

- `/.well-known/catalog-release.json` retains the five-field serving identity:
  app source/manifest plus current original catalog revision/snapshot hash.
- `/.well-known/runtime-catalog.json` separately reports the accepted data
  release/content hash/version. Do not mistake an app release for a new catalog
  receipt, or a data publication for a new Worker activation.
- Runtime publications retain the genuine original-schema `publication_receipts`
  row. Companion `catalog_runtime_publications` records the data contract;
  historical receipt schemas and native proofs are not rewritten.
- The final catalog transaction checks original owner/source/native barriers,
  expected predecessor and queued request; it records receipt/head/build/idle
  together. `version_reference=NULL` and `runtime:<hash>` truthfully resolve a
  data build request: no fake application version is invented.
- A retained body-free handoff settles a crash after commit. Exact readback
  recovers unknown acknowledgements, without another upload, owner takeover,
  supplier fetch or model phase. Existing hosted successor acceptance remains
  required before clearing the coordinator's pending pointer.
- App uploads/activations have separately retained dispatch records and exact
  provider tags/package hashes. An uncertain write is read back, not blindly
  repeated. Stale workflow sources cannot overwrite a newer main deployment.

Legacy static-publication code remains only for original frozen run recovery
and pre-cutover compatibility. Starting a new legacy `code` publication after
runtime activation is refused; use `Application deploy`. Historical cleanup runs
in its existing separate cleanup job, never the app/catalog critical queue.

## Rights, freshness and availability

Permanent base DTOs contain only cleared canonical title/short description,
images and optional approved articles. Finite supplier overlays/assets are
separate content-addressed objects, registered **before** upload with their
original deadlines. Expired bodies are not copied into fresh objects. The
existing cleanup job removes only due registered derived bodies; controls,
receipts, identities and native history remain.

The reader hash-checks accepted data, caches its small head observation for up to
five seconds, and reuses immutable bodies until a version/deadline changes.
Actual provider failures fall back to the last accepted cleared view. Missing
finite photos affect only those photos; no internal visitor/budget cutoff is
introduced. HTML is server-rendered, with canonical/OG/JSON-LD, full product
names and indexable public product pages regardless of optional-article flags.
Held products stay held/noindex; /h remains noindex.

The shared app build is locally measured in hundreds of milliseconds with seven
assets, not a promise of end-to-end GitHub/provider latency. Measure the first
actual scheduled data publication separately; local tests are not billing or
unattended-cycle acceptance.

## Admin boundary

See [CONTENT_ADMIN.md](CONTENT_ADMIN.md). The verified path-only staff Access
policy protects writes. Collection, copy and visibility revisions apply at
runtime without a build. Exact-ASIN requests wake the existing coordinator on
demand, sharing preparation and publication with daily care. An active catalog
job can still queue an addition; HTTP202 or dispatch acknowledgement is not
publication. The private campaign feed reports manual actions and freshness;
no campaign is joined automatically.
