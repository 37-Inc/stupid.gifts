# Stupid Gifts — submission preparation

This is a **draft**, not a submission-ready package or uploaded release. The private App/plugin, tunnel, identity and audience are untouched.

The supported listing, starter prompts, five positive/three negative cases, commerce description and release notes are in `plugin.draft.json`. Unknown publisher, support/privacy/terms URLs, country targeting and demo URL are deliberately omitted. The existing website is the only supplied public URL. Missing facts are tracked in `readiness-gaps.json`.

There is **no MCP configuration or ZIP**: a production endpoint has not been selected, deployed and verified. Do not upload this as a skills-only plugin or replace the current private package. After readiness gaps are resolved, copy the manifest to a separate public package as `plugin.json`, add exactly one verified remote server in portable `mcp.json`, include referenced icons, and inspect/validate the resulting archive. Author-supplied public uploads must omit `.app.json`, non-null `apps` declarations, lifecycle hooks, credentials, dependency directories and unrelated files. Portal-generated bindings in an eventual saved release are a separate concern.

The neutral icon is original vector source generated for the owned Stupid Gifts name; it is a review proposal. The 512px PNG is rendered from that SVG, with no legacy or retailer artwork.

Run `node prototypes/chatgpt/submission/validate-draft.mjs` for checks on the completed draft fields and assets. `--ready` intentionally fails while a release requirement is unresolved. This check is not a substitute for the current portal validation.

See `../docs/PUBLIC-DISTRIBUTION.md`, `../docs/POLICY-AND-DATA-FLOW.md`, and `../docs/REVIEW-WALKTHROUGH.md`. No policy approval, rights clearance, video, host run, verification or publishing claim is inferred from these drafts.

Sources checked November 6, 2026: [package/listing and review requirements](https://developers.openai.com/plugins/deploy/submission), [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines).

Unpublished public-copy drafts are available at `../docs/PRIVACY-ADDENDUM-DRAFT.md`, `../docs/SUPPORT-PAGE-DRAFT.md` and `../docs/USE-TERMS-DRAFT.md`. Their publication checks are the remaining factual/owner inputs; these files are not completed URL fields.
