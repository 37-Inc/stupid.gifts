# Stupid Gifts catalog automation specification

Status: implementation specification for owner review, November 6, 2026.

Run discovery, product maintenance and homepage editing as three modules of one
scheduled Node application, followed by one publisher. Host the existing
application before attempting a frontend rewrite or building another workflow
platform. Keep Cloudflare serving the accepted website throughout.

The objective is a fresh, funny, purchasable catalog that earns useful outbound
clicks and commissions, not maximum product count or generated text. Cameron
continues to join campaigns manually. This specification consolidates the final
architecture review; committing it does not activate a new schedule, change
model policy, provision credentials or alter production.

## Baseline and scope

The November 6 accepted baseline contains 3,390 identities, 3,347 public gifts,
43 holds, 37 optional public articles and approximately 7,008 static assets.
These are observations, not limits on future growth. The 17,000-file cleanup and
full catalog migration are complete; do not reopen either as a prerequisite.

Current care runs locally at 08:30 Pacific, with an evening due-photo pass at
20:30. Morning care checks up to ten existing gifts. Monday discovery uses six
themes and admits up to twenty candidates; Tuesday–Sunday maintenance is
model-free. One canonical short description and automatic native/serving vector
delivery already exist. The existing Cloudflare Workers Standard/D1 allocation
and affiliate configuration remain unchanged.

Ten checks daily cannot maintain roughly 3,350 public gifts on a reasonable
rotation. The measured November 3 run took 25 minutes 52 seconds overall, with
supplier work under a minute. Publication checks, building and cleanup are the
first efficiency targets. Total elapsed time is not the build duration and does
not, by itself, disqualify Cloudflare Workers Builds.

Operating details remain in [RUNBOOK.md](RUNBOOK.md). Product presentation,
campaign and privacy contracts remain in [CATALOG_QUALITY_AND_MERCHANDISING.md](CATALOG_QUALITY_AND_MERCHANDISING.md),
[CAMPAIGN_DIGEST.md](CAMPAIGN_DIGEST.md) and [SEARCH_DEMAND.md](SEARCH_DEMAND.md).
This specification governs the proposed transition, not historical recovery.

## Target operating model

Use one coordinator, one catalog and one publisher. Morning execution performs
due maintenance, finite discovery and optional homepage selection, then publishes
the ready public changes together. The evening invocation uses the same
maintenance module for genuinely due photos, without discovery or new copy.

Each module saves progress under the existing run identity. The coordinator
resumes pending work before starting new work. A failed candidate can be deferred
without blocking unrelated valid updates. Publication integrity failures preserve
the previous live release rather than exposing a partially applied catalog.

| Module | Responsibility | Saved result |
| --- | --- | --- |
| Discovery | Collect leads, deduplicate, judge, then enrich admitted gifts | Candidates, decisions and approved product changes |
| Maintenance | Check due availability/photos and reconcile real changes | Observations and product changes with original evidence |
| Homepage | Choose six weekly highlights and eighteen daily discoveries | Existing date-bound, ID-only edition |
| Publisher | Validate, deliver index changes, build, activate and verify | Existing release, catalog receipt and accepted successor |

Homepage selection continues to use the last accepted public catalog. New gifts
become searchable and get product pages when published, and enter the next
homepage candidate pool. Do not add unpublished-catalog selection just to save
one editorial cycle. Before building, remove unavailable picks and refill through
the existing fallback. An optional editor failure reuses the last good edition.

## Discovery and product content

Daily discovery combines complete raw Creator Connections leads, ordinary Amazon
themes and aggregate unmet search topics. No fixed source/category quota or
guaranteed campaign slot is required. Campaign collection can be stale or absent
without stopping ordinary discovery.

Process in this order:

1. Normalize exact marketplace/ASIN and retain the original supplier observation.
2. Deduplicate against all identities, including holds and previous decisions.
   Exact identities and verified duplicate relationships are authoritative;
   similar titles or vectors only suggest a review, not automatic exclusion.
3. Inspect real photos and facts, and save admit/reject/defer with a specific
   reason. Remove title-keyword taste gates and crude keyword scores, while
   retaining image, destination, identity and factual-integrity validation.
4. Generate short copy only for admitted gifts, validate it against the facts,
   then generate one embedding. Save each completed stage immediately.
5. Publish every ready worthwhile admission from the finite collected cohort.
   Do not fill a quota with ordinary products or truncate approved work merely
   to satisfy an arbitrary admission count.

Begin with a modest finite collection comparable to today's six search calls;
expand based on novelty, useful admissions and measured cost. Two to five good
additions daily is an initial expectation, not a minimum, ceiling or promise.
Successful saved collection is never refetched merely to resume enrichment.

Cache editorial judgments by relevant product evidence and policy version. Reuse
the same assessment for admission, homepage selection and search merchandising.
Do not repeatedly score the whole catalog. Supplier/product text is untrusted
data, never instructions to tools or the publisher.

Every admitted gift gets a stable product page with a working image, factual
title, one shared short description and correct affiliate destination. A mandatory
article adds cost and padding without guaranteeing usefulness. Preserve good
existing articles; add original explanation or a guide only when it helps.
Do not claim hands-on testing or fabricate specifications, price or availability.

New or materially corrected canonical text gets one saved embedding and the
existing native plus serving deliveries. Photo, stock, commission and order-only
changes do not regenerate text or embeddings. Keep hybrid search and keyword
fallback; no third discovery index or blanket vector rebuild.

## Freshness and availability

Choose work from existing observation dates and due deadlines, not a new general
queue service or a fixed daily quota. Prioritize due/broken finite photos, exposed
or clicked/promoted products, unresolved legacy observations, then fair rotation.
Keep a lane for unavailable gifts that are due for a real stock recheck.

Initial freshness objectives are daily checks for the most exposed/promoted
gifts, a roughly 30–45-day rotation for quiet public products, weekly rechecks of
unavailable holds, and finite photos before their actual deadline. Compute the
required throughput from these needs. Roughly 100 checks per day is a pilot
estimate, not a hard cutoff; include hot-product work when calculating whole-
catalog coverage. Use supplier-supported finite batches and bounded concurrency.

Resolve the 164 undated legacy negative-stock labels with current observations,
not a mass unlisting. Confirmed current unavailability removes a gift from public
shopping surfaces and buy links, preserving its URL, identity, cleared content and
history. A genuine positive observation restores it. Errors, omitted/ambiguous
responses, age and photo expiry alone are not stockout evidence; retain the
reviewed confirmation behavior and selection-paused landing page.

Permanent owner-cleared images/descriptions never expire. Finite overlays retain
their actual observation/deadline and fall back to cleared fields. Validate image
responses and browser decoding; use a verified alternative where available.
Never renew a timestamp without an observation or discard catalog/native history
to resolve an asset failure. A failed refresh does not rewrite good copy.

## Homepage and campaign preference

Keep six weekly highlights plus eighteen daily discoveries. Review a bounded
candidate pool using actual photos, canonical copy, prior exposure and saved
appeal/campaign facts. Preserve variety without category quotas or keyword gates.
The separately approved `/h` assortment and submit-only search remain unchanged.

Use the existing relevance-first ranker: protect exact/literal matches, then
compare gag appeal, then prefer higher verified eligible commission within
comparable relevance/appeal tiers. Spread only verified repeated designs.
Commission cannot make an irrelevant or ordinary object a strong gag gift.
Keep rates/terms private; evaluate future changes with exposure-normalized clicks
and actual affiliate results, not a new speculative revenue calculator.

Extend the campaign adapter to retain outside-catalog leads as well as existing
ASINs. Reuse complete raw research exports, not the Creator Research video-sales,
competition or payback calculator. Do not modify that separate project’s logic.
Account/card observations are leads, not proof of website participation.

A boost requires current accepted participation in the website account, exact
product/seller qualification, applicable funding/rate and fulfilled website
requirements. Track required content links and their actual submission state.
Send deduplicated Slack actions for new/changed manual joins or link obligations;
Cameron joins, then account evidence confirms participation. Never auto-join,
message sellers or treat a Slack acknowledgement as enrollment.

An expired/unknown campaign removes only its monetary boost, including cached
search results, not the gift. The browser-dependent campaign connector remains
optional until a supported unattended account-scoped feed is proven. Do not copy
Chrome sessions to a server. Core care continues with neutral/last-valid metadata
when exports, login or Slack are unavailable.

## Execution and publication contracts

Use one hosted Node 22 workflow in the existing GitHub repository first. Keep the
current frontend, static Cloudflare serving and search. Do not add Cloudflare
Workflows plus a separate builder, a generic autonomous deployment agent or
independently publishing services at this scale.

Extract only small configuration, artifact-storage and credential adapters.
Reuse existing D1 operation records, writer fencing, build/publication receipts
and same-run recovery. Add only the missing durable run metadata; do not layer
a second ownership/checkpoint system over them. A private R2 bucket holds saved
provider results and packages across runner loss, with original
retention rules. Validate access, atomic manifest updates and restore behavior
before cutover. GitHub caches are not authoritative recovery storage.

The shared boundaries are:

- **Run identity:** immutable source/config, captured edition and original input
  references. Hosted restart resumes this run, not a new label or new fetch.
- **Product changes:** existing maintenance results plus references to saved
  observations, editorial decision and embedding when required. Keep good prior
  public fields for an independently failed candidate; stage uncertain work.
- **Edition:** existing `schemaVersion/day/anchors/rotation` ID-only contract.
- **Campaigns:** existing scoped facts and review types, with lead/content-link
  tracking extended in place rather than another product database.
- **Acceptance:** existing genuine catalog receipt, public release identity,
  resolved build, idle owner and accepted successor. Code-only releases preserve
  the accepted catalog receipt instead of inventing a new one.

Keep one production writer. Reuse its existing fenced ownership; never take over
an uncertain external operation merely because a timer/lease elapsed. CI
serialization is an additional guard, not the source of truth. Do not cancel an
active publisher when a newer schedule arrives.

Use one maintained command path for normal execution/resumption and one supported
code-only mode over the accepted catalog. No private per-release wrappers for
routine work. Preserve saved provider/model results and all charged/unknown
attempts. Retry the failed step only. Content-addressed asset retries reuse exact
bytes; uncertain version/activation writes require provider readback first.

Build once per meaningful public change. Observation timestamps alone do not
justify a build; actual public photo/deadline, stock, content, edition or ranking
changes do. Reuse unchanged hashes/checks within the same immutable revision;
verify changed cohorts plus global identity/membership/link invariants. Keep
periodic full audits. Cleanup runs after acceptance, outside deployment locks,
with retries independent of publication success. Do not add incremental rendering
until measured cost after these changes justifies it.

Use the existing reviewed Luna configuration for finite editorial calls and the
existing embedding model. Validate allowed IDs and structured results, fact/copy
correspondence and representative images. AI cannot deploy, change credentials,
join campaigns or resolve uncertain provider mutations. Daily API copy/editorial
work replaces the present Monday/model-free policy only during its approved
activation phase, not by committing this file.

Give trusted production jobs scoped hosted credentials through protected secrets,
never ambient local secrets, copied Keychains or PR jobs. Resolve the exact scopes
and any required owner provisioning before the hosted canary. No new service plan
or unlimited model-spending commitment is implied.

Keep Pacific due dates. A delayed wake resumes due/pending work rather than
creating replacement batches. Use a bounded catch-up wake in the same workflow
and a missed-freshness alert through an existing independent reporting path; a
failed scheduler cannot be its own only health signal. Usage produces alerts,
not visitor/publication budget shutoffs. Preserve real provider throttling,
Retry-After, finite payloads/batches, request timeouts and bounded retries.

## Work packages and parallel boundaries

The existing Beads remain the tracker; this table defines delegation boundaries,
not a competing Markdown task list. Read current issue/source state before work.
Use separate branches and one integration owner. Agents do not deploy or edit an
active retained execution checkout independently.

| Package | Existing Bead and source focus | Deliverable and dependency |
| --- | --- | --- |
| A Publisher and recovery | **Simplify code-only release and post-publish cleanup** (`roadmap-lbbz1.28`); `daily-operator.mjs`, `publish-release.ts`, workspace/upload/recovery helpers | Maintained code-only/routine commands, reused durable state, cleanup outside deployment locks, preserved uncertain-write readback. Freeze shared interfaces first. |
| B Hosted execution | **Evaluate reliable hosted catalog care with agent curation** (`roadmap-lbbz1.16`); small storage/config/credential adapters and workflow | After A’s command/interface acceptance, host a model-free refresh/photo slice using approved unchanged copy and last-good edition. Shadow, real canary, then explicit single-writer cutover. Discovery may stay disabled until C is accepted; do not pretend desktop editorial moved unchanged. |
| C Discovery and editor | **Shortlist discovery before paid enrichment** (`roadmap-lbbz1.20`); discovery stage, homepage editor and focused model wrapper | Collect/judge/admit/enrich stages; saved decisions; tested API photo/copy review; removal of taste heuristics. Develop alongside A; integrate through frozen contracts. Daily cadence is a separate tested activation after B. |
| D Freshness | **Accelerate stock verification and resolve undated availability labels** (`roadmap-lbbz1.27`); selection and retail-availability logic | Due-work selection, fair rotation, legacy-label reconciliation and measured expanded throughput. Parallel with C; publisher changes belong to A. |
| E Campaign intake | **Website campaign scoring and manual-join pilot** (`roadmap-mt1gp`); campaign types/operator and digest | Outside-catalog leads, manual actions, verified boost/expiry and content-link tracking. Parallel with C/D; no dependency of hosted core acceptance. |

The integration owner owns shared CLI/config changes, `package.json`, schema
migrations, runbook and deployment. Packages C/D/E submit narrow changes, tests
and an interface note rather than independently rewriting A/B’s coordinator.
Bead scopes/dependencies must be reconciled to this spec before claiming
implementation; the current hosted issue is still investigation-only.

## Test and release acceptance

Before changing prompts or ranking, retain a small saved fixture set covering
strong gag gifts, ordinary filler, verified duplicates, distinct similar objects,
mismatched image/copy and missing facts. Confirm decisions and factual copy, not
only JSON shape. Keep specific broadcast constraints scoped to their intended
public surfaces; do not replace removed taste heuristics with new blanket bans.

Required recovery/regression cases:

- Duplicate wake and runner termination after each saved external stage do not
  repeat acknowledged supplier/model work or start a second writer.
- Malformed/contradictory model output defers that candidate, while good unrelated
  changes publish. Optional editor/Slack/telemetry/campaign failures retain service.
- Asset retry reuses the package; uncertain upload/version/activation is settled
  by exact readback. Delayed vector visibility preserves correct keyword fallback
  and cannot silently expose stale contradictory text.
- Real stockout/restock, unknown supplier response, broken/expired photo, stale
  edition and campaign expiry have the specified distinct behavior.
- Wrong account, offered-but-not-joined and unmet campaign obligations never
  produce a verified commission boost. No enrollment operation exists.
- Restore an accepted release/package in an isolated exercise. A backup file’s
  existence is not proof of recoverability. No live rollback/load test is needed.

Run the relevant existing suites, including `test:catalog-ops`,
`test:catalog-availability`, `test:homepage`, `test:staging`, `test:search-demand`
and lint, plus focused new adapter/editor tests. Build and independently verify
the explicit production package against the saved catalog context. Never use a
provider-mutating legacy entry point as a test or refetch a batch to measure cost.

Release order is A → B canary/cutover → C/D activation; E can follow independently.
Offline implementation and review of C/D/E may proceed in parallel with A/B.
Each package gets review, fixes, a simplification pass and tests before merge.
Only the integration owner publishes the reviewed combined source.

Before hosted activation, finish local pending work, verify durable artifacts and
scoped credentials, and disable local writes before the hosted canary. Shadow is
read-only. If cutover fails, stop hosted writing, reconcile pending external work,
then restore the local writer—never run both. Keep serving the last accepted site.

Production acceptance includes actual release/build/catalog receipt/successor
readback and QA-labelled checks of homepage first 24 and load-more, images/copy,
search/fallback, product/tagged link, guides, Random and unchanged `/h`. No test
purchases or repeated paid semantic probes. Completion distinguishes merged,
deployed, accepted and observation-pending states.

Close shipped implementation Beads on their actual acceptance. Track seven
consecutive unattended cycles, a due-photo pass, restart recovery and measured
cost as a separate substantive follow-up; do not leave completed implementation
open solely to await that observation. Replace accumulated historical operating
instructions with a concise current runbook, retaining receipts privately.

## Measurement and exclusions

Report publication age, oldest overdue check, due-photo failures, admissions and
decision reasons, retries, campaign actions, storage growth and actual supplier,
model, database and CI cost. Use existing private search-demand aggregates and
exposure-normalized clickthrough; result counts or no selection alone do not
establish result quality. Keep the existing 30-day privacy contract and never
forward raw queries to GA4/PostHog. Actual Amazon earnings remain separate from
advertised commissions and merchandise value.

Do not build a general task platform, per-visitor agent, third product index,
mandatory article generator, new revenue calculator or separate publishing
services. Do not replatform the frontend, resurrect retired features, restore
internal public budget cutoffs, buy a plan or auto-enroll campaigns. Preserve
catalog identities, stable URLs, licensed content, native history, backups and
Cloudflare redirects. Archive/delete obsolete wrappers only after proving no
active run or historical recovery depends on them; keep one normal entry point.

## References

- [GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule): delayed/dropped wakes require due-work checks and missed-run monitoring.
- [Cloudflare build limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/): compare the actual build phase, not the whole maintenance duration, when considering a future host change.
- [Google helpful-content guidance](https://developers.google.com/search/docs/fundamentals/creating-helpful-content): useful product pages, not compulsory word counts.
- [Routine release reliability](RELEASE_RELIABILITY_2026-11-04.md), [homepage contract](HOMEPAGE_EDITOR.md) and [catalog lifecycle](CATALOG_LIFECYCLE.md): preserve accepted behavior until the corresponding new phase is tested and activated.
