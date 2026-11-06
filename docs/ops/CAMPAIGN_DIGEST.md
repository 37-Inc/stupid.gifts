# Stupid Gifts — Manual campaign digest

Optional work inside the existing morning Codex task, not a new service,
timer, enrollment bot or catalog-publication prerequisite. Evening care stays
photo-only. No command in this integration joins a campaign.

## Shared product and ranking contract

- `lib/catalog/presentation.ts` resolves the existing public `description` for
  cards, details, metadata, guides, keyword search and new embedding inputs.
  `content/catalog-presentation.json` contains only exact-input-bound legacy
  corrections, replacing old card-note and homepage-copy overrides. November5:
  all3,355 public products covered;2,319 descriptions reused directly and1,036
  correction records. IDs, slugs, imagery, articles, holds, sealed snapshots
  and native history are unchanged.
- New embeddings use title plus that description. Saved legacy vectors keep
  their original recipe/identity; changed cohorts use the versioned v2 projection
  through normal delivery. Known contradictory old vectors are not served, but
  remain retained; correct keyword content does not wait for re-embedding.
- Search retrieves lexical and ANN candidates before truncation, fuses ranks,
  protects exact matches, then orders comparable relevance by reviewed appeal
  and descending verified commission priority. Verified design groups spread
  repeats without deleting variants. No category quotas, legacy quality-score
  boosts, per-query generation or new public-search budgets.
- Missing appeal is neutral. Commission preference expires even on cache hits.
  Rates/account details stay private. The homepage editor has an additional
  verified-campaign candidate lane, not reserved promotional slots.

## Existing morning task

Use the accepted operator and runbook's scrubbed Node22 prefix, before preparing
a NEW run. Never change a prepared/active run's source or captured config.

1. `npm run catalog:campaigns -- status`. Reuse complete saved Creator Research
   inventory as **leads**, bypassing its video/sales/payback calculator and
   qualified-only pool. `research <export.json>` accepts its complete
   `CampaignInventoryEntry[]` export and retains exact public-ASIN overlaps.
   Card-only, full and other-account observations never become website proof.
   No runtime connection to research SQLite or credentials is introduced.
2. Verify promising leads read-only in Chrome37's parent store
   `rileyehrlic0b-20`, tracking ID `goose-gifts-37-20`. Never switch the separate
   Creator Product Research profile's account. `import <feed.json>` saves the
   normalized schema1 website facts defined in `lib/catalog/campaigns.ts`:
   actual observation/expiry and campaign dates, exact ASIN and safe detail URL,
   bonus/effective rate, enrollment and requirements evidence. Copy/accept-action
   URLs are not safe detail links. Do not renew observations without readback.
3. Review a small cohort's current title, description and photos. Save specific
   appeal or verified same-design judgments with `review '<JSON>'`, schema:

   ```json
   {"schemaVersion":1,"reviews":{"ASIN":{"title":"exact current title","description":"exact current description","appeal":"standout","reason":"specific gag-fit reason","reviewedAt":"UTC ISO"}}}
   ```

   Appeal:standout/giftable/ordinary/unreviewed; optional `variantGroup` identifies
   a genuinely verified same-design family, never title/category similarity.
   Changed products do not inherit another object's review.
4. `digest` previews actionable offers. `digest --send` sends new/changed groups
   via existing OpenClaw to marketing `C0AGRSTBP5H`: products, advertised bonus,
   account, deadline and manual detail link. Unchanged notices deduplicate.
   `test-notification` is a one-time configuration test, not daily work.
5. Continue homepage editorial and normal `catalog:care`. Preparation pins
   optional merchandising in the normal publication config. Appeal/commission
   metadata needs no supplier batch, catalog rewrite or product embedding.

Drafts, source handoffs, facts and notification receipts stay private in
`daily-catalog-care/campaigns`. Import retains content-hashed history. Never
commit provider exports. Initial reviewed appeal records live in
`content/catalog-merchandising.json`; ordinary/unreviewed products stay public.

Only current offered/joinable/website-eligible campaigns for actual admitted,
reviewed gag gifts notify. Outside-catalog products are discovery leads, not an
extra-batch authorization. Cameron joins manually. Verify accepted participation
afterward, including effective eligible rate, seller, funding, dates and
content-link obligations. Accepted campaigns full to newcomers can still qualify.
Notification or a Slack acknowledgement is not enrollment evidence.

Slack failure falls back to this thread and never blocks site care. An uncertain
delivery retains its intent; inspect Slack history for the printed digest ID
before resolving, never blindly resend. Missing/stale facts remove monetary
preference, not listings. An unavailable optional compiler reuses bound
nonmonetary metadata or neutral defaults, stripping commission preference.

## Scope and evidence

Chrome37 readback on November5 confirmed Riley's parent store and Creator
Connections access. A live11% Seymour Butz prank-box offer was inspected; its
four ASINs do not overlap the accepted catalog, so it is a lead, not a join
notification or active boost. No campaign was joined by this work. Enrollment
and actual bonus earnings remain distinct owner/provider follow-up.

Monday's existing discovery caps admissions before generation. The deeper
collect→agent-shortlist→enrich internal split and automated research export
remain follow-ups, not claims made by this release. No cadence expansion,
new provider plan or wholesale enrichment is introduced.
