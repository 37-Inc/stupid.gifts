# Stupid Gifts — ChatGPT privacy addendum draft

**Unpublished review text. Not approved policy or a live listing URL.** Prepared November 6, 2026 against the proposed MCP adapter and current catalog-service source. The bracketed operator name and publication checks must be resolved before hosting this alongside the website privacy policy.

## Proposed public copy

**Operator:** [[Confirm the legal publisher operating Stupid Gifts]]
**Applies to:** Stupid Gifts gift discovery in ChatGPT.

When you ask Stupid Gifts for ideas, the app receives the gift-interest text or selected product identifiers that ChatGPT sends for that operation. Please describe interests rather than include names, contact details or other private information. The app does not request payment details, retailer passwords, exact location or your complete ChatGPT history.

We use the interest text to search the Stupid Gifts catalog and use selected identifiers to retrieve current product information. The response contains product facts, photos and Stupid Gifts page links. The app does not place orders or access retailer accounts.

The proposed service uses Cloudflare infrastructure and the Stupid Gifts catalog/search service. Catalog search can use keywords or meaning-based matching. When meaning-based matching is enabled, search text is sent to OpenAI to create a numerical representation and matched using Cloudflare Vectorize. This functional search processing is separate from ChatGPT's handling of your conversation.

The MCP adapter does not intentionally log raw gift queries or IP addresses. The catalog service uses an in-memory network-address hash for one-minute capacity estimates and reuses cached product search results for up to five minutes. Expired in-memory entries are cleared on later relevant requests or eviction, rather than guaranteed physical deletion at those exact times. Its operational diagnostics can contain a query hash and length, result counts, matching information and a generated request identifier; they do not contain the raw query or an IP address. These diagnostic records are assigned a 30-day expiry and are removed during subsequent permitted diagnostic writes, rather than guaranteed deletion at an exact instant. Hosting/provider logs and support-message retention must be stated in the final retention notice before publication.

Product photos load from the image host identified in the approved product record. Depending on that record, this can be Stupid Gifts or an approved external image provider. Those requests may be subject to the provider's own privacy practices. The final notice must identify the image providers actually enabled for this release.

Opening a gift page takes you to the Stupid Gifts website, whose privacy notice explains its website analytics and other processing. Choosing a retailer link then takes you to a separate retailer. ChatGPT, the website and retailers have their own data practices; this addendum does not promise deletion of information held independently by them.

For questions or requests about Stupid Gifts' handling of information, contact [goosegifts@37.technology](mailto:goosegifts@37.technology). Send only the information needed to explain the request; do not send passwords, payment details or a full private chat transcript.

## Publication checks outside the public copy

- Confirm the legal publisher/controller and that the public product mailbox is monitored for app/privacy requests.
- Confirm the deployed provider list, whether meaning-based search is enabled, and the actual approved image hosts.
- Add verified hosting/provider access/error-log and support-message retention periods, access arrangements and deletion/request procedures. Do not infer zero retention from the adapter's lack of raw-query logging.
- Confirm that the catalog diagnostic expiry/cleanup behavior above matches the selected release and explain any operational exceptions accurately.
- Confirm available country targeting and whether additional disclosures or controls are needed. No country availability is inferred from this English draft.
- Publish the approved notice at a real controlled HTTPS page, inspect it without a private login and only then populate the listing privacy URL.

Source facts: `site-catalog.mjs`, `production.mjs`, `worker.mjs`, `workers/site/search.ts`, `workers/site/d1-search.ts`, `lib/catalog/storage/d1.ts`, `lib/privacy-policy.ts` (November 5, 2026) and `lib/site.ts`. [OpenAI privacy requirements](https://developers.openai.com/plugins/plugin-guidelines) explain the submission categories; this draft does not attest compliance.
