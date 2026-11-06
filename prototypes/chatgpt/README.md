# Stupid Gifts — ChatGPT app

Read-only conversational discovery of unusual physical gifts. ChatGPT supplies
recipient context and curates returned candidates; the app supplies catalog data
and a compact carousel. The app calls no additional generative model. It provides
no account access, purchase flow, current-price claim or budget filter.

## Development

Use Node 22. Dependencies are isolated from the website runtime:

```sh
npm --prefix prototypes/chatgpt ci
npm run test:chatgpt
STUPID_CHATGPT_CATALOG_MODE=fixture npm run chatgpt:dev
```

Fixture mode uses clearly labeled imaginary products. The existing owner-private
connection remains separate from this release candidate; its installation IDs,
private conversation history and operator paths are not part of public source.

For an authorized local catalog preview:

```sh
STUPID_CHATGPT_CATALOG_MODE=site-catalog STUPID_CHATGPT_PORT=8788 npm run chatgpt:dev
```

Use a free local port. Do not replace an existing private preview process.
`GOOSE_CHATGPT_*` environment names remain compatibility fallbacks; use
`STUPID_CHATGPT_*` for new launchers. Historical database-adapter code remains
for regression coverage and is not an enabled server mode.

## Contract

- `search_gifts({ query })` returns at most twelve public candidates, without UI.
- `render_gifts({ ids })` revalidates up to six chosen public UUIDs and returns
  one carousel at `ui://stupid-gifts/carousel-v5.html`.
- Cards have one whole-card link to their canonical Stupid Gifts product page,
  an original product image, concise factual text and a quiet **View Gift →** cue.
- Follow-ups, exclusions and avoiding previous selections use the conversation.
  Empty results, unavailable services and missing IDs produce explicit outcomes.

The website adapter uses the existing search API and the bounded read-only
`GET /api/catalog-gifts?ids=<UUIDs>` lookup. It checks the immutable release and
canonical page availability. Rendering does not depend on a prior search or
in-memory session. The lookup API change must be deployed before this candidate
can replace the current private adapter; local contract tests do not prove that
it exists on the public site.

## Production and submission

The edge entry is `worker.mjs`; `wrangler.chatgpt.jsonc` has no public route or
workers.dev URL enabled. Public access is fail-closed until an operator supplies
an explicitly approved, content-hash-bound catalog cohort and the required
rate-limiting binding. Existing website clearance is not assumed to grant public
ChatGPT/mobile photo rights. Changed content must be reviewed again.

See [readiness](READINESS.md), [public distribution](docs/PUBLIC-DISTRIBUTION.md),
[data flow](docs/POLICY-AND-DATA-FLOW.md), and the
[submission draft](submission/README.md). No production endpoint, public review,
recorded demo, legal approval or physical mobile acceptance is claimed by these
source files. The draft has no private App bindings and deliberately cannot
pass final submission validation while factual release prerequisites are missing.

## Verification

```sh
npm --prefix prototypes/chatgpt test
node --experimental-strip-types --test tests/chatgpt-catalog-gifts.test.mjs tests/site-worker.test.mjs tests/site-worker-feed.test.mjs tests/site-worker-search.test.mjs
node prototypes/chatgpt/submission/validate-draft.mjs
```

GitHub CI runs the isolated app checks and the upstream lookup/website boundary
regressions without provider credentials or live catalog mutations. Protocol
checks, simulated failures and DOM unit checks are distinct from actual ChatGPT,
mobile, screen-reader and enforced-host CSP acceptance.
