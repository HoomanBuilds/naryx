"use client";

import { useRef } from "react";
import { GLYPHS, glyphSrc } from "@/features/landing/glyphs";
import { gsap, reducedMotion, useGSAP } from "@/features/landing/gsap";
import styles from "./use-cards.module.css";

/** Pictograms drawn with the glyph alphabet: which glyph goes in each cell (-1 for empty). */
const PICTURES = {
  trade: [
    [13, -1, -1, -1, 12],
    [13, 13, -1, 12, 12],
    [13, 13, 4, 12, 12],
    [13, 13, 4, 12, 12],
  ],
  route: [
    [7, -1, -1, -1, -1],
    [1, 1, 1, -1, -1],
    [-1, -1, 1, -1, -1],
    [-1, -1, 1, 1, 9],
  ],
};

const CARDS = [
  {
    id: "trade",
    title: "Trade",
    body: "Build a package from the strategy catalogue or the graph builder, compare complete-package quotes, and manage entry, rebalance, roll and exit in one terminal.",
    action: "Open the terminal",
    href: "/trade",
    tone: "yellow",
  },
  {
    id: "route",
    title: "Quote",
    body: "Publish quote surfaces for canonical series, answer RFQs automatically and hedge across venues with inventory-aware skew.",
    action: "Run a solver",
    href: "#roadmap",
    tone: "cyan",
  },
  {
    id: "build",
    title: "Build",
    body: "Plug package execution into a wallet, vault, treasury or trading app, with builder attribution and revenue sharing.",
    action: "Read the docs",
    href: "#roadmap",
    tone: "outline",
  },
] as const;

function Pictogram({ id }: { id: "trade" | "route" }) {
  return (
    <div className={styles.pictogram} data-pictogram>
      {PICTURES[id].flatMap((row, r) =>
        row.map((glyph, c) =>
          glyph < 0 ? (
            <span key={`${r}-${c}`} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={`${r}-${c}`} src={glyphSrc(GLYPHS[glyph])} alt="" data-glyph={glyph} />
          ),
        ),
      )}
    </div>
  );
}

/**
 * The use cards: yellow, cyan and outlined, stepped down the
 * page, each with a pixel pictogram and a full-width button. Hovering a card
 * re-rolls its glyphs.
 */
export default function UseCards() {
  const root = useRef<HTMLElement>(null);

  const { contextSafe } = useGSAP(
    () => {
      if (reducedMotion()) return;
      gsap.from(`.${styles.card}`, {
        y: 120,
        opacity: 0,
        duration: 1.2,
        ease: "expo.out",
        stagger: 0.12,
        scrollTrigger: { trigger: `.${styles.cards}`, start: "top 80%" },
      });
    },
    { scope: root },
  );

  const shuffle = contextSafe((card: HTMLElement) => {
    const glyphs = card.querySelectorAll<HTMLImageElement>("[data-glyph]");
    let ticks = 0;
    const timer = window.setInterval(() => {
      glyphs.forEach((img) => {
        const base = Number(img.dataset.glyph);
        img.src = glyphSrc(GLYPHS[ticks < 5 ? Math.floor(Math.random() * GLYPHS.length) : base]);
      });
      if (++ticks > 5) window.clearInterval(timer);
    }, 70);
  });

  return (
    <section ref={root} id="use" className={styles.use} data-theme="dark">
      <div className="container">
        <p className="tag" data-reveal>
          Use Naryx
        </p>
        <div className={styles.cards}>
          {CARDS.map(({ id, title, body, action, href, tone }) => (
            <article
              key={id}
              className={`${styles.card} ${styles[tone]}`}
              onPointerEnter={(event) => shuffle(event.currentTarget)}
            >
              <div className={styles.art}>
                {id === "build" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className={styles.layers} src="/landing/layers.webp" alt="" />
                ) : (
                  <Pictogram id={id} />
                )}
              </div>
              <h3 className="display">{title}</h3>
              <p>{body}</p>
              <a className={styles.action} href={href}>
                {action}
              </a>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
