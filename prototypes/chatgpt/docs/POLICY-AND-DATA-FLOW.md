# Stupid Gifts — data flow and policy preparation

Checked November 6, 2026. This is an implementation inventory and policy gap list, **not published policy or approved terms**. The maintained public website uses an older shared privacy-policy source; a wordmark substitution alone does not establish coverage of this integration.

## Observed integration flow

| Step | Data and recipient | Observed behavior / remaining check |
| --- | --- | --- |
| ChatGPT calls search_gifts | A bounded gift-interest query goes to the MCP service. | The schema requests query only, not a full chat log, account credentials, exact location or payment details. User-supplied queries can still contain personal information; do not promise that all inputs are anonymous. |
| MCP searches the catalog | A shortened interest query is sent to stupid.gifts /api/search-products. | The adapter also reads catalog-release metadata. The code-only production candidate re-fetches selected public IDs through /api/catalog-gifts before rendering and checks canonical pages; it does not depend on the prior process cache. Production website/provider handling and retention still need confirmation; absence of a direct model call in the adapter does not establish the website’s downstream providers. |
| ChatGPT receives candidates / render result | Public IDs, titles, short descriptions, tags, canonical product-page URLs and photo URLs. | No price, retailer-account access, affiliate destination, private retailer IDs or database credentials are intended in tool output. Confirm with release-candidate protocol tests. |
| Widget displays images | Direct requests to allowed Stupid Gifts, Amazon or Etsy photo hosts. | These are separate network recipients. Establish permitted display, applicable metadata/log handling and policy disclosure. CSP allowlisting is not permission. |
| User opens View Gift | Canonical Stupid Gifts product page opens using the host bridge. | The page has its own hosting/analytics/privacy behavior; a later retailer click is a separate user action. |
| Hosting and diagnostics | Production MCP and website infrastructure may process request metadata and service errors. | The code-only production adapter contains no raw-prompt/IP logging and uses a route-wide capacity key rather than an IP/user key. Confirm provider logs, retention, access and any deployment-specific behavior. Do not infer zero retention from absent application logging. |

The production candidate remains disabled without an explicit catalog-approval flag, a bounded per-product ID/digest approval list and a shared rate-limit binding. The digest binds the normalized displayed facts and image URL, so changed copy or a changed media URL requires renewed approval. It does not detect changed image bytes at an unchanged external URL. These are code safeguards, not proof of rights clearance or public activation.

The current catalog source also maintains non-raw operational search diagnostics (query hash/length and result/matching fields) with a 30-day expiry and cleanup on later permitted writes, a one-minute estimate window keyed by an in-memory network-address hash, and up-to-five-minute result reuse. In-memory expiry is logical; entries are cleared by later requests/eviction rather than guaranteed physical deletion at that instant. Optional meaning-based search uses OpenAI embeddings and Cloudflare Vectorize. The MCP adapter does not call the separate website search-demand observation endpoint. Confirm these source facts against the selected deployed release before publishing them as policy.

Actual reviewable copy is drafted in `PRIVACY-ADDENDUM-DRAFT.md`, `SUPPORT-PAGE-DRAFT.md` and `USE-TERMS-DRAFT.md`; none is approved or hosted.

## Facts needed before final policy text

- The selected legal publisher/controller and monitored support/privacy contact. Current website attribution is not proof of Platform developer verification.
- Actual production service providers and query propagation, including catalog/search infrastructure and direct image recipients.
- Retention periods for gift queries, transient caches, access/error logs, analytics and support messages; deletion/control mechanisms that actually exist.
- Intended country availability and any resulting policy localization or eligibility decisions.
- Which parts of the website's existing analytics notice apply after a user opens a product page, and how the MCP integration differs.
- A verified public support page and applicable public terms page. A mailto footer is not the submission's required supportURL.

The current source's general website privacy statements do not supply specific ChatGPT provider/retention/control facts. No new legal promises, response-time guarantees, jurisdiction or retention values are inserted here. Fill those facts with the operator/owner before preparing approved public policy copy; host and inspect the final pages before setting their listing fields.

## Proposed policy additions for owner review

1. Explain the interest-query → MCP → Stupid Gifts catalog/search flow and the public-field response.
2. Identify actual image/hosting/search recipients and their purposes.
3. State the verified retention and access/control arrangements for each data category.
4. Explain the user-initiated website/retailer transition and affiliate model without implying that the app places orders.
5. Supply a working privacy/support request path and accurate boundaries on deletion, including data controlled separately by ChatGPT or retailers.

[OpenAI privacy requirements](https://developers.openai.com/plugins/plugin-guidelines) require a published policy addressing data categories, use, recipients, retention and controls. The current submission still lacks approved, verified privacy/support/terms fields.
