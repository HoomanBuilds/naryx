"use client";

import { useRef } from "react";
import Button from "@/features/landing/button";
import { gsap, reducedMotion, ScrollTrigger, useGSAP } from "@/features/landing/gsap";
import { CHAINS } from "@/features/brand/chain-icons";
import styles from "./stats.module.css";

const TILES: readonly { value: number; decimals: number; prefix: string; suffix: string; label: string; tone: string; chains?: boolean }[] = [
  { value: 1, decimals: 0, prefix: "", suffix: "", label: "Signature for every leg of the strategy", tone: "blue" },
  { value: 4, decimals: 0, prefix: "", suffix: "", label: "Domains: Solana, Base, Arbitrum, Hyperliquid", tone: "light", chains: true },
  { value: 3, decimals: 0, prefix: "", suffix: "", label: "Settlement classes, each with its own guarantee", tone: "dark" },
  { value: 4, decimals: 0, prefix: "", suffix: "", label: "Evidence grades on every receipt", tone: "ink" },
];

/** The stat mosaic: tiles on dithered pixel patterns, counting up. */
export default function Stats() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const q = gsap.utils.selector(root);
      const values = q<HTMLElement>("[data-value]");
      if (reducedMotion()) return;
      values.forEach((element) => (element.textContent = (0).toFixed(Number(element.dataset.decimals))));
      ScrollTrigger.create({
        trigger: q(`.${styles.tiles}`)[0],
        start: "top 80%",
        once: true,
        onEnter: () => {
          values.forEach((element, i) => {
            const counter = { value: 0 };
            gsap.to(counter, {
              value: Number(element.dataset.value),
              duration: 1.8,
              delay: i * 0.1,
              ease: "expo.out",
              onUpdate: () => (element.textContent = counter.value.toFixed(Number(element.dataset.decimals))),
            });
          });
          gsap.from(q(`.${styles.tile}`), { y: 40, opacity: 0, duration: 1.1, ease: "expo.out", stagger: 0.08 });
        },
      });
    },
    { scope: root },
  );

  return (
    <section ref={root} className={styles.stats} data-theme="yellow">
      <div className={`container ${styles.inner}`}>
        <div className={styles.copy}>
          <h2 className={`display ${styles.title}`} data-reveal>
            One integration
          </h2>
          <p className={styles.lede} data-reveal>
            Delta-neutral vaults, trading desks, market makers, treasuries, wallets and strategy platforms already pay
            to coordinate legs themselves. One Naryx integration replaces that work for every package they run.
          </p>
          <div data-reveal>
            <Button href="#use" variant="ink" arrow>
              Integrate Naryx
            </Button>
          </div>
        </div>

        <div className={styles.tiles}>
          {TILES.map(({ value, decimals, prefix, suffix, label, tone, chains }) => (
            <div key={label} className={`${styles.tile} ${styles[tone]}`}>
              {chains ? (
                <span className={styles.logos} aria-hidden="true">
                  {CHAINS.map(({ id, Icon }) => (
                    <span key={id}>
                      <Icon size={22} variant="branded" />
                    </span>
                  ))}
                </span>
              ) : null}
              <strong>
                {prefix}
                <span data-value={value} data-decimals={decimals}>
                  {value.toFixed(decimals)}
                </span>
                {suffix}
              </strong>
              <span className={styles.label}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
