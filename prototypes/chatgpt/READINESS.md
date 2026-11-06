# Stupid Gifts — ChatGPT submission readiness

Checked November 6, 2026. Engineering preparation is separate from deployment,
actual host acceptance, public content clearance and submission. This candidate
does not replace the existing private installation or expand its audience.

Central Roadmap parent: `roadmap-o9ff5.1`.

| Bead | Workstream | Current result | Remaining acceptance |
| --- | --- | --- | --- |
| `roadmap-o9ff5.1.1` | Public content rights | Primary-source policy review and conservative cohort process prepared. | Actual photo/copy permission and general-audience review; zero public items cleared. |
| `roadmap-o9ff5.1.2` | Source integration | Maintained prototype imported onto current main; CI and regression checks added. | Review/merge the scoped PR; source integration does not activate hosting. |
| `roadmap-o9ff5.1.3` | Restart-safe lookup | Fresh bounded UUID lookup replaces candidate-cache dependence; separate-instance regressions pass. | Deploy website lookup before switching the existing private adapter. |
| `roadmap-o9ff5.1.4` | Permanent hosting | Edge-safe bundle, production request protections, health route and closed configuration prepared. | Select account-scoped rate-limit namespace, configure binding/routing, deploy and measure actual resource usage after clearance. |
| `roadmap-o9ff5.1.5` | Product presentation | Factual presentation helper, curated copy preference and original photo identity preserved. | Visually inspect the final approved cohort. |
| `roadmap-o9ff5.1.6` | Accessibility | Quiet contrast, link semantics, focus/forced colors, reduced motion and stale-state handling checked in code. | Actual browser/screen-reader/device evidence belongs to host acceptance. |
| `roadmap-o9ff5.1.7` | Real ChatGPT acceptance | Desktop/mobile/error/refinement test plan prepared. | Current public candidate not run in real host; browser access disabled and endpoint not deployed. |
| `roadmap-o9ff5.1.8` | Publisher/policies | Data-flow inventory and unpublished policy/support/terms text prepared. | Verified publisher, actual provider retention/support commitments, approved hosted URLs and countries. |
| `roadmap-o9ff5.1.9` | Public package/listing | Listing draft, original icon proposal, starter prompts and local validation prepared. | Required facts, verified endpoint, final public upload package and icon approval. |
| `roadmap-o9ff5.1.10` | Review cases/video | Five positive and three negative cases, Not-run ledger and walkthrough script prepared. | Execute against release candidate and record/host a real accessible demo. |
| `roadmap-o9ff5.1.11` | Portal/submission | Required sequence and gates documented. | Exact-version domain/setup/scans, owner policy attestations and explicit submission action. |

## Engineering evidence

- The prototype suite includes separate-instance lookup, release mismatch,
  changed approved content, disabled/malformed configuration, concurrency,
  bounded streamed requests and honest failure handling.
- The upstream lookup and existing Worker/feed/search boundary suites pass
  63 tests. An independent run also passed without root dependency directories.
- Both strict TypeScript projects pass; changed source passes lint with zero
  warnings. The isolated production dependency audit reports zero vulnerabilities.
- The portable edge build contains no Node builtins or external runtime imports;
  the Cloudflare deployment dry-run succeeds. This does not measure actual
  Cloudflare CPU, end-to-end latency, cost or uptime.
- The submission draft validator passes. `--ready` fails deliberately while
  release facts and actual review evidence are missing.

The PR records exact command results and build identity. No fabricated host
screenshots, approval, video, endpoint or publication state is supplied.

## Production activation sequence

1. Integrate this code and deploy the website's read-only
   `/api/catalog-gifts` route through the normal website release contract.
   Verify actual release identity and lookup behavior before changing the
   retained private process. The current private server remains untouched.
2. Resolve the rights/general-audience cohort. Record non-sensitive provenance
   references separately from private licenses. Prefer immutable owned image
   URLs. Generate each exact normalized projection digest using
   `giftApprovalDigest`; a digest is a technical binding, not permission.
3. Select the intended existing Cloudflare account and an account-unique
   rate-limit namespace. Configure the required `MCP_RATE_LIMITER` binding with
   documented route capacity. The limit is approximate per-location protection,
   not a global usage ledger, user entitlement or cost guarantee.
4. Review the exact diff to `wrangler.chatgpt.jsonc`: approved cohort, approval
   flag, binding and route. The candidate uses `https://stupid.gifts` as its
   proposed public origin, with `/mcp` and `/mcp/health`; neither is claimed
   live. Current config has no routes, no workers.dev and no preview URL.
5. Build and dry-run with Node 22, then deploy the approved exact version.
   Verify health, actual production search/render/refinement/failure cases,
   release identity, real resource usage and no unexpected logging.
6. Roll back by disabling public approval and restoring the prior recorded
   Worker version/routing through the normal operator process. Keep the
   existing website and private installation available throughout. Never
   improvise a replacement private tunnel or replay a catalog publication.

## Final submission gates

The four listing URLs must be genuine HTTPS pages with the intended publisher,
and privacy text must match the reused website search and hosting behavior.
The current draft intentionally omits unconfirmed identity, countries, URLs,
demo URL and MCP connection configuration. Do not upload it as skills-only.
Author-supplied public uploads must not contain private App bindings, secrets
or operator history. The authorized publisher completes final policy
attestations; upload, submission, approval and publication are different states.

References: [OpenAI submission](https://developers.openai.com/plugins/deploy/submission),
[review requirements](https://developers.openai.com/plugins/deploy/app-review),
[guidelines](https://developers.openai.com/plugins/plugin-guidelines).
