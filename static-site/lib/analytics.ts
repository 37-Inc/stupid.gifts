"use client";

import type { createClientAnalytics } from "../../lib/client-analytics";
import type { ProductAnalyticsSource } from "../../lib/analytics-contract";
import { createSessionAttribution } from "./analytics-attribution";
import { isSiteAnalyticsHostname, isSiteProduction, siteIdentity } from "./site-identity";

type Analytics = ReturnType<typeof createClientAnalytics>;
let catalogRelease = false;
let client: Promise<Analytics> | undefined;
let pageViewed = false;
const impressions = new Set<string>();
const getAttribution = createSessionAttribution(isStaticAnalyticsAllowed);

/** Gate before importing any provider code, and again before each event. */
export function isStaticAnalyticsAllowed(): boolean {
  return isSiteProduction
    && process.env.NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED === "true"
    && catalogRelease
    && typeof window !== "undefined"
    && window.location.protocol === "https:"
    && isSiteAnalyticsHostname(window.location.hostname)
    && navigator.doNotTrack !== "1"
    && window.doNotTrack !== "1"
    && navigator.globalPrivacyControl !== true;
}

/** First-party search demand shares opt-out/host gates, never provider payloads. */
export function isSearchDemandAllowed(): boolean {
  return isStaticAnalyticsAllowed() && getAttribution().utmMedium?.toLowerCase() !== 'qa';
}

function withAnalytics(send: (analytics: Analytics) => void) {
  if (!isStaticAnalyticsAllowed()) return;
  // The compile-time branch also keeps provider chunks out of default builds.
  if (process.env.NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED === "true") {
    client ||= import("../../lib/client-analytics").then(({ createClientAnalytics }) =>
      createClientAnalytics({
        isAllowed: isStaticAnalyticsAllowed,
        pageOrigin: siteIdentity.origin,
        getAttribution,
      }),
    ).catch(() => {
      client = undefined;
      throw new Error("Analytics unavailable");
    });
    void client.then((analytics) => {
      if (isStaticAnalyticsAllowed()) send(analytics);
    }).catch(() => { /* Analytics never blocks native navigation or browsing. */ });
  }
}

function productData(element: HTMLElement) {
  const { analyticsId: id, analyticsSource: source,
    analyticsContext: context, analyticsExpiry: expiry } = element.dataset;
  if (!id || !context || !["amazon", "etsy"].includes(source || "")
    || !(element.dataset.analyticsPermanent === "" && !expiry
      || Date.parse(expiry || "") > Date.now())) return;
  return { id, source: source as ProductAnalyticsSource, context };
}

/** Only explicitly marked product cards, called after actual UI updates. */
export function captureRenderedLists() {
  withAnalytics((analytics) => {
    const lists = new Map<string, Array<{ id: string; source: ProductAnalyticsSource }>>();
    for (const element of document.querySelectorAll<HTMLElement>("[data-analytics-card]")) {
      if (!element.getClientRects().length) continue;
      const item = productData(element);
      if (!item) continue;
      const key = `${item.context}:${item.id}`;
      if (impressions.has(key)) continue;
      impressions.add(key);
      const items = lists.get(item.context) || [];
      items.push({ id: item.id, source: item.source });
      lists.set(item.context, items);
    }
    for (const [clickSource, products] of lists) {
      // Keep each explicit event within the contract's 36-item bound.
      for (let index = 0; index < products.length; index += 36)
        analytics.captureViewItemList({ clickSource, products: products.slice(index, index + 36) });
    }
  });
}

export function captureStaticSearch(resultCount: number) {
  withAnalytics((analytics) => analytics.captureSearch(resultCount));
}
export function captureStaticRandomSpin() {
  withAnalytics((analytics) => analytics.captureRandomGiftSpin());
}

export function startStaticAnalytics(isCatalogRelease: boolean): () => void {
  catalogRelease = isCatalogRelease;
  if (!isStaticAnalyticsAllowed()) return () => {};
  withAnalytics((analytics) => {
    if (pageViewed) return;
    pageViewed = true;
    analytics.capturePageView(window.location.pathname);
  });
  captureRenderedLists();
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>("a[data-analytics-product-link],a[data-analytics-outbound]");
    const element = link?.closest<HTMLElement>("[data-analytics-id]");
    const item = element && productData(element);
    if (!link || !item) return;
    withAnalytics((analytics) => {
      if (!productData(element!)) return;
      if (link.hasAttribute("data-analytics-outbound")) {
        analytics.captureOutboundProductClick({
          clickSource: item.context, productId: item.id,
          productSource: item.source, affiliateUrl: link.href,
          // Native target=_blank navigation proceeds immediately. Ads still gets
          // its callback/timeout without a callback opening a duplicate tab.
          callback: () => {},
        });
      } else {
        const cards = [...document.querySelectorAll<HTMLElement>("[data-analytics-card]")]
          .filter((card) => card.dataset.analyticsContext === item.context);
        analytics.captureSelectItem({
          clickSource: item.context, productId: item.id,
          productSource: item.source, index: Math.max(0, cards.indexOf(element!)),
        });
      }
    });
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}
