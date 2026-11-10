"use client";

import { useEffect, useState } from "react";
import { readShowPreviews } from "../lib/show-preview";
import type { ShowPreviewProduct } from "../lib/show-preview";
import { captureRenderedLists } from "../lib/analytics";
import { Icon } from "./Icon";

/** Optional filming-only additions; failure never hides the saved catalog picks. */
export function ShowPreviews() {
  const [products, setProducts] = useState<ShowPreviewProduct[]>([]);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('ids')) return;
    const abort = new AbortController(), timeout = window.setTimeout(() => abort.abort(), 5000);
    void (async () => {
      try {
        const response = await fetch('/api/show-preview', { cache: 'no-store', credentials: 'omit', signal: abort.signal });
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
        const text = await response.text();
        if (text.length > 8000 || abort.signal.aborted) return;
        setProducts(readShowPreviews(JSON.parse(text), Date.now()));
      } catch { /* The existing lineup is still useful without optional previews. */ }
    })();
    return () => { abort.abort(); window.clearTimeout(timeout); };
  }, []);
  useEffect(() => {
    captureRenderedLists();
    const deadline = Math.min(...products.map(product => Date.parse(product.eligibleUntil)));
    if (!Number.isFinite(deadline)) return;
    const expire = () => setProducts(current => current.filter(product => Date.parse(product.eligibleUntil) > Date.now()));
    const timer = window.setTimeout(expire, Math.max(0, deadline - Date.now()));
    window.addEventListener('pageshow', expire); document.addEventListener('visibilitychange', expire);
    return () => { window.clearTimeout(timer); window.removeEventListener('pageshow', expire); document.removeEventListener('visibilitychange', expire); };
  }, [products]);
  // eslint-disable-next-line react-hooks/purity -- A queued render must not start an expired third-party image request.
  return products.filter(product => Date.parse(product.eligibleUntil) > Date.now()).map(product =>
    <article key={product.id} className="product-card" data-analytics-card="" data-analytics-id={product.id}
      data-analytics-source="amazon" data-analytics-context="show-preview" data-analytics-expiry={product.eligibleUntil}>
      <a className="product-art retailer-art" data-analytics-outbound="" href={product.affiliateUrl}
        target="_blank" rel="sponsored noopener noreferrer" aria-label={`View ${product.title} on Amazon`}>
        {/* Exact observed photo, not a catalog image or an evergreen generated asset. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={product.imageUrl} alt={product.title} className="object-contain" style={{ width: '100%', height: '100%' }}
          onError={event => { if (!event.currentTarget.src.endsWith('/images/gift-placeholder.svg')) event.currentTarget.src = '/images/gift-placeholder.svg'; }} />
      </a>
      <div className="card-copy"><h2><a data-analytics-outbound="" href={product.affiliateUrl} target="_blank" rel="sponsored noopener noreferrer">{product.title}</a></h2>
        <p className="card-description">{product.description}</p>
        <a className="card-action" data-analytics-outbound="" href={product.affiliateUrl} target="_blank" rel="sponsored noopener noreferrer">
          View on Amazon <Icon name="arrow" /><span className="sr-only">: {product.title}</span>
        </a>
      </div>
    </article>);
}
