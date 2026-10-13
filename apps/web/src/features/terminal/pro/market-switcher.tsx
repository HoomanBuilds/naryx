"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AssetIcon, ChainIcon, chainOf } from "@/features/brand/chain-icons";
import type { PublicPackageMarket } from "../public-market-feed";
import { packageMarketChainName, packageMarketName, packageMarketUnderlying, packageMarketVariant } from "../market-label";
import styles from "./pro.module.css";

export function MarketSwitcher({
  selected,
  markets,
  onChange,
}: {
  selected: PublicPackageMarket;
  markets: readonly PublicPackageMarket[];
  onChange(packageMarketId: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return markets;
    return markets.filter((market) => `${packageMarketName(market)} ${packageMarketVariant(market) ?? ""} ${market.packageMarketId} ${market.domainIds.join(" ")}`.toLowerCase().includes(term));
  }, [markets, query]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId, open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) trigger.current?.focus();
  };
  const choose = (market: PublicPackageMarket) => {
    onChange(market.packageMarketId);
    close(true);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      close(event.key === "Escape");
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => visible.length === 0 ? 0 : (index + (event.key === "ArrowDown" ? 1 : visible.length - 1)) % visible.length);
    } else if (event.key === "Enter" && visible[active]) {
      event.preventDefault();
      choose(visible[active]);
    }
  };
  const chain = chainOf(packageMarketChainName(selected));

  return (
    <div className={styles.marketSwitcher}>
      <button
        ref={trigger}
        type="button"
        className={styles.marketSwitcherTrigger}
        aria-label={`Package market: ${packageMarketName(selected)}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected.packageMarketId}
        onClick={() => {
          if (open) close(false);
          else {
            setActive(Math.max(0, markets.findIndex((market) => market.packageMarketId === selected.packageMarketId)));
            setOpen(true);
          }
        }}
      >
        <span className={styles.marketSwitcherName}>{packageMarketName(selected)}</span>
        <span className={styles.marketSwitcherChevron} aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <>
          <button type="button" className={styles.marketSwitcherBackdrop} aria-label="Close market list" onClick={() => close(false)} />
          <div className={styles.marketSwitcherMenu} onKeyDown={onKeyDown}>
            <input
              autoFocus
              className={styles.marketSwitcherSearch}
              value={query}
              placeholder="Search markets"
              aria-label="Search package markets"
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={visible[active] ? `${listId}-${active}` : undefined}
              onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            />
            <div id={listId} role="listbox" aria-label="Package markets" className={styles.marketSwitcherList}>
              {visible.length === 0 ? <p className={styles.marketSwitcherEmpty}>No matching markets</p> : visible.map((market, index) => {
                const marketChain = chainOf(packageMarketChainName(market));
                const variant = packageMarketVariant(market);
                const selectedOption = market.packageMarketId === selected.packageMarketId;
                return (
                  <button
                    key={market.packageMarketId}
                    id={`${listId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={selectedOption}
                    tabIndex={-1}
                    title={market.packageMarketId}
                    className={`${styles.marketSwitcherOption} ${selectedOption ? styles.marketSwitcherSelected : ""} ${index === active ? styles.marketSwitcherActive : ""}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(market)}
                  >
                    <AssetIcon symbol={packageMarketUnderlying(market)} size={20} />
                    <span className={styles.marketSwitcherOptionText}>
                      <strong>{packageMarketName(market)}</strong>
                      <small>{marketChain?.name ?? "Other chain"}{variant ? ` / ${variant}` : ""}{market.halted ? " / Halted" : ""}</small>
                    </span>
                    <ChainIcon chain={marketChain?.id ?? ""} size={14} />
                  </button>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
      <span className={styles.visuallyHidden}>{chain?.name ?? "Unknown chain"}</span>
    </div>
  );
}
