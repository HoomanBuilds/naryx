"use client";

import { useRef, type CSSProperties } from "react";
import { GLYPHS, glyphSrc } from "@/features/landing/glyphs";
import { gsap, reducedMotion, useGSAP } from "@/features/landing/gsap";
import styles from "./use-cards.module.css";

/** Pictograms drawn with the glyph alphabet: which glyph goes in each cell (-1 for empty). */
const PICTURES = {
  trade: [
    [12, -1, -1, -1, 10],
    [12, 12, -1, 10, 10],
    [12, 12, 9, 10, 10],
    [12, 12, 9, 10, 10],
  ],
  route: [
    [7, -1, -1, -1, -1],
    [1, 1, 1, -1, -1],
    [-1, -1, 1, -1, -1],
    [-1, -1, 1, 1, 8],
  ],
};

const CARDS = [
  {
    id: "trade",
    title: "Trade",
    body: "Pick a package, compare complete-package quotes with their settlement class and every fee, then enter and exit all legs from one terminal.",
    action: "Open the terminal",
    href: "/trade",
    tone: "yellow",
  },
  {
    id: "route",
    title: "Quote",
    body: "Publish quote surfaces for canonical series, answer RFQs automatically, and back firm quotes with onchain reservations or performance bonds.",
    action: "How solvers compete",
    href: "#engine",
    tone: "cyan",
  },
  {
    id: "build",
    title: "Build",
    body: "Plug package execution into a wallet, vault, treasury or trading app through the API and SDK, with builder attribution and fee caps the order owner signs.",
    action: "See the settlement classes",
    href: "#shielded",
    tone: "outline",
  },
] as const;

/** The Build card's layers, top to bottom: each plate's top-face gradient. */
const PLATES = [
  ["#5d93ff", "#0048ff"],
  ["#7dffff", "#00a8d6"],
  ["#ffff00", "#ffae00"],
  ["#ff8af2", "#c21fc8"],
  ["#b44dff", "#4a0a9e"],
];

/** Integration layers stacked like the engine's slabs; they part when the card is hovered. */
function Layers() {
  const [cx, hw, hh, t] = [150, 118, 56, 12];
  return (
    <svg className={styles.layers} viewBox="0 0 300 240" aria-hidden="true">
      <defs>
        <pattern id="layers-grain" width="3" height="3" patternUnits="userSpaceOnUse">
          <rect width="1" height="1" fill="#fff" fillOpacity="0.28" />
        </pattern>
        {PLATES.map(([light, deep], i) => (
          <linearGradient key={i} id={`layers-${i}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={light} />
            <stop offset="1" stopColor={deep} />
          </linearGradient>
        ))}
      </defs>
      {PLATES.map((_, k) => {
        const i = PLATES.length - 1 - k;
        const cy = 66 + i * 26;
        const top = `M${cx} ${cy - hh}L${cx + hw} ${cy}L${cx} ${cy + hh}L${cx - hw} ${cy}Z`;
        const left = `M${cx - hw} ${cy}L${cx} ${cy + hh}V${cy + hh + t}L${cx - hw} ${cy + t}Z`;
        const right = `M${cx + hw} ${cy}L${cx} ${cy + hh}V${cy + hh + t}L${cx + hw} ${cy + t}Z`;
        return (
          <g key={i} data-plate style={{ "--i": i } as CSSProperties}>
            <path d={left} fill={`url(#layers-${i})`} />
            <path d={left} fill="#000" fillOpacity="0.35" />
            <path d={right} fill={`url(#layers-${i})`} />
            <path d={right} fill="#000" fillOpacity="0.6" />
            <path d={top} fill={`url(#layers-${i})`} />
            <path d={top} fill="url(#layers-grain)" stroke="#fff" strokeOpacity="0.4" />
          </g>
        );
      })}
    </svg>
  );
}

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
                {id === "build" ? <Layers /> : <Pictogram id={id} />}
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
