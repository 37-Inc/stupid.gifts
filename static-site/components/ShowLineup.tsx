"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { fetchCardShard } from "../lib/card-shard";
import type { CatalogCard } from "../lib/card-shard";
import { showLineupIds } from "../lib/show-lineup";
import { ProductCard } from "./ProductCard";
import { captureRenderedLists } from "../lib/analytics";
import { catalogDeadline } from "../../lib/catalog/display";

export function ShowLineup({ children, catalogRevision, action }: {
  children: ReactNode; catalogRevision: string; action: string;
}) {
  const [state, setState] = useState<{ status: "default" | "loading" | "ready" | "error"; products: CatalogCard[] }>({ status: "default", products: [] });
  useEffect(() => {
    let abort: AbortController;
    const load = async () => {
      abort?.abort(); const current = new AbortController(); abort = current;
      try {
        const ids = showLineupIds(window.location.search);
        const main = document.getElementById("main");
        if (main) main.dataset.customShow = ids ? "true" : "false";
        if (!ids) { setState({ status: "default", products: [] }); return; }
        setState({ status: "loading", products: [] });
        const shard = await fetchCardShard(`/api/catalog-gifts?ids=${ids.join(',')}&view=cards`,
          { catalogRevision, version: catalogRevision, kind: "feed" }, current.signal);
        if (!current.signal.aborted) setState({ status: "ready", products: shard.products });
      } catch {
        if (!current.signal.aborted) setState({ status: "error", products: [] });
      }
    };
    void load(); window.addEventListener("popstate", load);
    return () => { abort?.abort(); window.removeEventListener("popstate", load); };
  }, [catalogRevision]);
  useEffect(() => captureRenderedLists(), [state.products]);
  useEffect(() => {
    const deadline = Math.min(...state.products.map(p => catalogDeadline(p.eligibleUntil)));
    if (!Number.isFinite(deadline)) return;
    const timer = window.setTimeout(() => setState(current => {
      const products = current.products.filter(p => catalogDeadline(p.eligibleUntil) > Date.now());
      return { status: products.length ? "ready" : "error", products };
    }), Math.max(0, Math.min(2_147_483_647, deadline - Date.now())));
    return () => window.clearTimeout(timer);
  }, [state.products]);
  return <>
    <div className="show-default-picks" hidden={state.status !== "default"}>{children}</div>
    {state.status === "loading" && <p role="status">Loading gifts…</p>}
    {state.status === "error" && <p role="status">This lineup couldn’t load. <a href={action}>Open the saved picks.</a></p>}
    {state.status === "ready" && <div className="catalog-grid" aria-label="Gifts">
      {state.products.map((product, index) => <ProductCard key={product.id} product={product} eager lead={index === 0} context="show-curated" />)}
    </div>}
  </>;
}
