"use client";

import { useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type { PublicCatalogProduct } from "../../lib/catalog/types";
import { ProductCard } from "./ProductCard";
import { captureRenderedLists, captureStaticSearch } from "../lib/analytics";
import { catalogDeadline, persistentPublicProduct, resolvePublicProduct } from "../../lib/catalog/display";
import { validatePublicCatalogProduct } from "../../lib/catalog/snapshot";
import { createBrowserSearchDemand } from "../lib/search-demand";

type SearchState = {
  status: "idle" | "loading" | "ready" | "unavailable";
  products: PublicCatalogProduct[];
};

export function Search({ children, action = "/", autoSearch = true }: {
  children?: ReactNode; action?: "/" | "/h"; autoSearch?: boolean;
} = {}) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({
    status: "idle",
    products: [],
  });
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const debounce = useRef<number | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const demand = useRef<ReturnType<typeof createBrowserSearchDemand> | null>(null);
  const submitted = useRef(false);

  function clear() {
    demand.current?.edit();
    setQuery("");
    navigate("");
    input.current?.focus();
  }

  function navigate(value: string, replace = false) {
    submitted.current = !replace;
    if (debounce.current !== null) window.clearTimeout(debounce.current);
    debounce.current = null;
    const q = value.trim().slice(0, 200);
    const url = new URL(window.location.href);
    const hadQuery = url.searchParams.has("q");
    url.pathname = action;
    if (q.length >= 2) url.searchParams.set("q", q);
    else url.searchParams.delete("q");
    if (`${url.pathname}${url.search}` !== `${window.location.pathname}${window.location.search}`)
      window.history[replace && hadQuery ? "replaceState" : "pushState"](null, "", `${url.pathname}${url.search}`);
    if (q.length < 2) {
      controller.current?.abort();
      sequence.current++;
      setState({ status: "idle", products: [] });
      return;
    }
    window.dispatchEvent(new Event("catalog-search"));
  }

  useEffect(() => {
    let active = true;
    demand.current = createBrowserSearchDemand();
    const search = async () => {
      if (debounce.current !== null) window.clearTimeout(debounce.current);
      debounce.current = null;
      const q = (new URLSearchParams(window.location.search).get("q") || "")
        .trim()
        .slice(0, 200);
      setQuery(q);
      controller.current?.abort();
      const request = ++sequence.current;
      if (q.length < 2) {
        demand.current?.edit();
        setState({ status: "idle", products: [] });
        return;
      }
      demand.current?.begin(q, submitted.current);
      submitted.current = false;
      // Bookmarked queries and history navigation should reveal the search,
      // not leave mobile visitors above the complete curated opening set.
      document.getElementById("catalog-search")?.scrollIntoView({ behavior: "instant", block: "start" });
      const abort = new AbortController();
      controller.current = abort;
      setState({ status: "loading", products: [] });
      try {
        const response = await fetch(
          `/api/search-products?q=${encodeURIComponent(q)}&limit=36`,
          { signal: abort.signal },
        );
        if (!response.ok) throw new Error("Search unavailable");
        const data = await response.json();
        if (!Array.isArray(data.results))
          throw new Error("Invalid search response");
        // API owns eligibility and public-field validation. Expiry is checked again
        // before showing results, including a response received across its deadline.
        const now = new Date();
        const products = data.results.slice(0, 36).flatMap((raw: unknown) => {
          try {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
            const display = Object.fromEntries(Object.entries(raw).filter(([key]) => !["similarity", "rankScore", "matchType"].includes(key)));
            const product = validatePublicCatalogProduct(display, now);
            const resolved = persistentPublicProduct(product) ?? resolvePublicProduct(product, now);
            return resolved ? [resolved] : [];
          } catch { return []; }
        });
        if (active && !abort.signal.aborted && request === sequence.current) {
          setState({ status: "ready", products });
          captureStaticSearch(products.length);
          demand.current?.complete(products.length);
        }
      } catch {
        if (active && !abort.signal.aborted && request === sequence.current) {
          setState({ status: "unavailable", products: [] });
          demand.current?.complete(null);
        }
      }
    };
    void search();
    window.addEventListener("popstate", search);
    window.addEventListener("catalog-search", search);
    return () => {
      active = false;
      controller.current?.abort();
      demand.current?.dispose();
      demand.current = null;
      if (debounce.current !== null) window.clearTimeout(debounce.current);
      window.removeEventListener("popstate", search);
      window.removeEventListener("catalog-search", search);
    };
  }, []);

  useEffect(() => captureRenderedLists(), [state.products]);

  useEffect(() => {
    if (!state.products.length) return;
    const deadline = Math.min(
      ...state.products.map((product) => catalogDeadline(product.eligibleUntil)),
    );
    if (!Number.isFinite(deadline)) return;
    const timer = window.setTimeout(
      () =>
        setState((current) => ({
          ...current,
          products: current.products.filter(
            (product) => catalogDeadline(product.eligibleUntil) > Date.now(),
          ),
        })),
      Math.max(0, Math.min(2_147_483_647, deadline - Date.now())),
    );
    return () => window.clearTimeout(timer);
  }, [state.products]);

  const hasQuery = state.status !== "idle" || (autoSearch && query.trim().length >= 2);
  function selectResult(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || ![0, 1].includes(event.button) || !(event.target instanceof Element)) return;
    const card = event.target.closest('a[data-analytics-product-link]')?.closest('[data-analytics-card]');
    if (!card) return;
    const index = [...event.currentTarget.querySelectorAll('[data-analytics-card]')].indexOf(card);
    if (index >= 0) demand.current?.select(index + 1);
  }
  return (
    <section
      className="search-section"
      aria-label="Find a gift"
      id="catalog-search"
    >
      <form
        className="search-form"
        action={action}
        method="get"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(query);
        }}
      >
        <label className="sr-only" htmlFor="gift-query">
          Search gifts
        </label>
        <input
          ref={input}
          id="gift-query"
          name="q"
          type="search"
          placeholder="Find something stupid"
          value={query}
          minLength={2}
          maxLength={200}
          onChange={(event) => {
            demand.current?.edit();
            const value = event.target.value;
            setQuery(value);
            controller.current?.abort();
            sequence.current++;
            if (debounce.current !== null) window.clearTimeout(debounce.current);
            if (autoSearch) debounce.current = window.setTimeout(() => navigate(value, true), 400);
          }}
        />
        <button type="submit">
          Search
        </button>
        {query.length > 0 && <button type="button" className="clear-search"
          onClick={clear}>Clear</button>}
      </form>
      <div role="status" aria-live="polite">
        {state.status === "loading" && (
          <p className="search-status">Searching…</p>
        )}
        {state.status === "unavailable" && (
          <p className="search-status">
            Search couldn’t load. Your search is still here.
          </p>
        )}
        {state.status === "ready" && (
          <p className="search-status">
            {state.products.length
              ? `${state.products.length} ${state.products.length === 1 ? "gift" : "gifts"}`
              : "No matches. Try an object, an interest or a shorter search."}
          </p>
        )}
        {!hasQuery && query.length === 1 && (
          <p className="search-status">Use at least two characters.</p>
        )}
      </div>
      {(state.status === "unavailable" || (state.status === "ready" && !state.products.length)) && (
        <div className="search-recovery">
          {state.status === "unavailable" && <button type="button" className="button" onClick={() => navigate(query)}>Try again</button>}
          <button type="button" className="button button-secondary" onClick={clear}>Browse all gifts</button>
        </div>
      )}
      {state.status === "loading" && (
        <div className="catalog-grid search-skeleton" aria-hidden="true">
          {[0, 1, 2].map((item) => <div key={item}><div className="skeleton-art" /><div className="skeleton-line" /><div className="skeleton-line" /></div>)}
        </div>
      )}
      {state.status === "ready" && state.products.length > 0 && (
        <div className="catalog-grid" onClickCapture={selectResult} onAuxClickCapture={selectResult}>
          <h2 className="sr-only">Search results</h2>
          {state.products.map((product) => (
            <ProductCard key={product.id} product={product} context="catalog_search" />
          ))}
        </div>
      )}
      {state.status === "idle" && children}
    </section>
  );
}
