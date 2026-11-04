"use client";

import { useEffect, useRef, useState } from "react";
import type { CatalogCard } from "../lib/card-shard";
import { fetchCardShard } from "../lib/card-shard";
import { eligiblePool, initialRandomIndex, nextRandomIndex } from "../lib/selection";
import { ProductCard } from "./ProductCard";
import { Icon } from "./Icon";
import { captureRenderedLists, captureStaticRandomSpin } from "../lib/analytics";
import { catalogDeadline } from "../../lib/catalog/display";

const LAST_GIFT_KEY = "stupid-gifts-last-random";
function lastGift(): string | null {
  try { return sessionStorage.getItem(LAST_GIFT_KEY); } catch { return null; }
}
function rememberGift(id: string) {
  try { sessionStorage.setItem(LAST_GIFT_KEY, id); } catch { /* Optional convenience. */ }
}

export function RandomSelection({
  initial,
  poolSize,
  poolPath,
  catalogRevision,
  version,
}: {
  initial?: CatalogCard;
  poolSize: number;
  poolPath: string;
  catalogRevision: string;
  version: string;
}) {
  const [pool, setPool] = useState(initial ? [initial] : []);
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(poolSize > 1);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => captureRenderedLists(), [pool, index]);
  useEffect(() => {
    if (poolSize < 2) return;
    const abort = new AbortController();
    pending.current = abort;
    async function chooseInitial() {
      try {
        const choices = (await fetchCardShard(poolPath, { catalogRevision, version, kind: "random" }, abort.signal)).products;
        if (abort.signal.aborted || choices.length !== poolSize) return;
        const next = initialRandomIndex(choices, lastGift());
        setPool(choices);
        setIndex(next);
        setLoaded(true);
        rememberGift(choices[next].id);
      } catch {
        // Keep the static gift usable if the shard is unavailable; the button can retry.
      } finally {
        if (pending.current === abort) {
          pending.current = null;
          setLoading(false);
        }
      }
    }
    void chooseInitial();
    return () => { abort.abort(); if (pending.current === abort) pending.current = null; };
  }, [poolPath, poolSize, catalogRevision, version]);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!pool.length) return;
    const nextExpiry = Math.min(
      ...pool.map((p) => catalogDeadline(p.eligibleUntil)),
    );
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => {
        if (pool.some((p) => catalogDeadline(p.eligibleUntil) <= Date.now())) {
          pending.current?.abort();
          pending.current = null;
          setPool([]);
          setLoading(false);
        } else setPool((current) => [...current]);
      },
      Math.max(0, Math.min(2_147_483_647, nextExpiry - Date.now())),
    );
    return () => window.clearTimeout(timer);
  }, [pool]);

  async function spin() {
    if (pending.current) return;
    const abort = new AbortController();
    pending.current = abort;
    setLoading(true);
    try {
      const choices = loaded
        ? eligiblePool(pool)
        : (
            await fetchCardShard(
              poolPath,
              { catalogRevision, version, kind: "random" },
              abort.signal,
            )
          ).products;
      if (abort.signal.aborted) return;
      if (
        !choices.length ||
        (loaded && choices.length !== pool.length) ||
        choices.length !== poolSize
      )
        throw new Error("Catalog shard unavailable");
      const current = choices.findIndex((p) => p.id === pool[index]?.id);
      const next = current < 0 ? initialRandomIndex(choices, lastGift()) : nextRandomIndex(choices.length, current);
      setIndex(next);
      setPool(choices);
      setLoaded(true);
      rememberGift(choices[next].id);
      captureStaticRandomSpin();
    } catch {
      if (!abort.signal.aborted) setPool([]);
    } finally {
      if (pending.current === abort) {
        pending.current = null;
        setLoading(false);
      }
    }
  }
  const product = pool[index];
  return (
    <section className="random-selection">
      {product ? (
        <>
          <ProductCard product={product} lead context="random_gift" />
          <button
            type="button"
            className="button"
            disabled={poolSize < 2 || loading}
            onClick={spin}
          >
            <Icon name="dice" />
            {loading ? "Choosing another…" : "Show me another gift"}
          </button>
        </>
      ) : (
        <div className="empty-state">
          <h2>The selection needs a fresh look.</h2>
          <p>
            Choices are unavailable or need a freshness review.{" "}
            <a href="/">Browse gifts</a>
          </p>
        </div>
      )}
    </section>
  );
}
