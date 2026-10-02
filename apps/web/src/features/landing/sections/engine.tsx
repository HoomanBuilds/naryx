"use client";

import { useRef } from "react";
import Arrow from "@/features/landing/arrow";
import { GLYPHS, glyphSrc } from "@/features/landing/glyphs";
import { gsap, reducedMotion, SCRAMBLE, useGSAP } from "@/features/landing/gsap";
import { CHAINS as BRAND_CHAINS } from "@/features/brand/chain-icons";
import styles from "./engine.module.css";

const STEPS = [
  {
    letter: "A",
    name: "Package order",
    title: "One order carries every leg",
    body: [
      "A cash-and-carry package buys spot and shorts the matching perpetual in one typed, signed order. Your price, size and risk limits apply to the whole strategy, not to each leg.",
      "Every package resolves to a canonical strategy series, so equivalent strategies share one market without hiding how each would execute.",
    ],
  },
  {
    letter: "B",
    name: "Solver competition",
    title: "Solvers quote the whole outcome",
    body: [
      "Independent solvers and market makers return signed quotes for the complete package. Each quote states its firmness: an onchain inventory reservation, a performance bond, or a simulated reservation on test networks.",
      "Naryx compares net outcomes after fees, slippage, collateral, settlement and recovery risk, and picks an eligible route within your limits.",
    ],
  },
  {
    letter: "C",
    name: "Settlement",
    title: "Settled under a stated guarantee",
    body: [
      "Every route carries a settlement class. It is atomic only when every leg shares one rollback boundary; otherwise it is batched or asynchronous, with bounded recovery.",
      "You get one receipt for every leg, fee, residual and recovery action, graded by how strong its evidence is.",
    ],
  },
];

// ------------------------------------------------------------------ scene

const CENTER = { x: 300, y: 300 };
/** A venue's leg feed: a curve from its slab down into the package mark. */
const feed = (x: number) => `M${x} 124 C${x} 200 ${CENTER.x} 190 ${CENTER.x} 256`;
const VENUES = [180, 300, 420];
/** The four domains a match can settle on, one slab each, with Base as the settling example. */
const CHAIN_SLABS = BRAND_CHAINS.map((chain, i) => ({ ...chain, x: 120 + i * 120 }));
const SETTLING_CHAIN = 1;

/** Package book rows (A), each of which becomes a quote cell in the solver grid (B). */
const LEVELS = [36, 58, 84, 104, 132, 156, 178];
const ladder = LEVELS.flatMap((length, level) => {
  const y = 226 + level * 25;
  return [
    { side: "bid", x: CENTER.x - 10 - length, y, width: length },
    { side: "ask", x: CENTER.x + 10, y, width: length * (0.8 + ((level * 7) % 5) / 10) },
  ];
});

/** Solver competition (B) shows every quote as a cell in one grid. */
const CELL = 18;
const PITCH = 26;
const COLS = 8;
const ROWS = 5;
const GRID_X = CENTER.x - (COLS * PITCH - (PITCH - CELL)) / 2;
const GRID_Y = CENTER.y - (ROWS * PITCH - (PITCH - CELL)) / 2;
/** Grid slots in a scattered order (17 and 40 share no factor, so this visits every slot once). */
const SLOTS = Array.from({ length: COLS * ROWS }, (_, i) => {
  const slot = (i * 17 + 5) % (COLS * ROWS);
  return { x: GRID_X + (slot % COLS) * PITCH, y: GRID_Y + Math.floor(slot / COLS) * PITCH };
});
/** Where each ladder bar lands in the grid. */
const CELLS = ladder.map((_, i) => SLOTS[i]);
/** Cells that only exist in the grid: quotes from other solvers. */
const CROWD = SLOTS.slice(ladder.length);
/** The two cells that end up paired: your package and the winning quote. */
const MATCH = [4, 9];
/** Where the matched pair meets, above the grid. */
const PAIR = { y: 200, left: CENTER.x - 16, right: CENTER.x + 16 };
const centre = (i: number) => ({ x: CELLS[i].x + CELL / 2, y: CELLS[i].y + CELL / 2 });
/** Pairs of quotes that are briefly compared during the competition. */
const LINKS = [
  [0, 7],
  [2, 11],
  [5, 12],
  [1, 8],
  [MATCH[0], MATCH[1]],
];

/** An isometric slab: top face, then left and right sides. */
function slab(cx: number, cy: number, w: number, h: number, t: number) {
  const top = `M${cx} ${cy - h / 2}L${cx + w / 2} ${cy}L${cx} ${cy + h / 2}L${cx - w / 2} ${cy}Z`;
  const left = `M${cx - w / 2} ${cy}L${cx} ${cy + h / 2}L${cx} ${cy + h / 2 + t}L${cx - w / 2} ${cy + t}Z`;
  const right = `M${cx + w / 2} ${cy}L${cx} ${cy + h / 2}L${cx} ${cy + h / 2 + t}L${cx + w / 2} ${cy + t}Z`;
  return { top, left, right };
}

function Scene() {
  return (
    <svg className={styles.scene} viewBox="0 0 600 640" aria-hidden="true">
      <defs>
        <linearGradient id="side-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b2b2b" />
          <stop offset="1" stopColor="#141414" />
        </linearGradient>
        <linearGradient id="side-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1f1f1f" />
          <stop offset="1" stopColor="#0d0d0d" />
        </linearGradient>
      </defs>

      {/* A: venues feeding their legs into the package mark */}
      <g data-part="venues">
        {VENUES.map((x, i) => {
          const s = slab(x, 92, 92, 52, 12);
          return (
            <g key={x} data-venue={i}>
              <path d={s.left} fill="url(#side-left)" />
              <path d={s.right} fill="url(#side-right)" />
              <path d={s.top} fill="#262626" stroke="#3a3a3a" />
              <image href={glyphSrc(GLYPHS[[11, 7, 4][i]])} x={x - 11} y={81} width="22" height="22" opacity="0.8" />
            </g>
          );
        })}
      </g>
      <g data-part="feeds">
        {VENUES.map((x) => (
          <path key={x} d={feed(x)} fill="none" stroke="#3a3a3a" strokeWidth="1.5" pathLength={1} />
        ))}
        {VENUES.map((x, i) => (
          // Positioned by the motion path, from the origin.
          <rect key={x} data-packet={i} x="-3" y="-3" width="6" height="6" fill="#f8f8ff" transform={`translate(${x} 124)`} />
        ))}
      </g>

      <line data-part="midline" x1={CENTER.x} x2={CENTER.x} y1="150" y2="420" stroke="#f8f8ff" strokeWidth="1.5" />

      {/* Ladder bars that fold into the matching grid's cells */}
      <g data-part="orders">
        {ladder.map((bar, i) => (
          <rect
            key={i}
            data-order={i}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height="12"
            rx="2"
            fill={bar.side === "bid" ? "#ffff00" : "#00ffff"}
          />
        ))}
      </g>

      <g data-part="crowd" opacity="0">
        {CROWD.map(({ x, y }, i) => (
          <rect key={i} x={x} y={y} width={CELL} height={CELL} rx="2" fill="#2a2a2a" />
        ))}
      </g>

      <g data-part="links">
        {LINKS.map(([a, b], i) => (
          <line
            key={i}
            data-link={i}
            x1={centre(a).x}
            y1={centre(a).y}
            x2={centre(b).x}
            y2={centre(b).y}
            stroke={i === LINKS.length - 1 ? "#ffff00" : "#8a8a8a"}
            strokeWidth={i === LINKS.length - 1 ? 2 : 1}
            pathLength={1}
            strokeDasharray="1"
            strokeDashoffset="1"
          />
        ))}
      </g>

      <g data-part="mid">
        <rect x={CENTER.x - 7} y={CENTER.y - 7} width="14" height="14" fill="#ffff00" />
        <rect x={CENTER.x + 10} y="146" width="112" height="22" rx="3" fill="#f8f8ff" />
        <text x={CENTER.x + 18} y="161" className={styles.price}>
          NET <tspan data-mid-price>+0.42%</tspan>
        </text>
      </g>

      {/* C: chains the match can settle on */}
      <g data-part="chains">
        {CHAIN_SLABS.map(({ x, name, Icon }, i) => {
          const s = slab(x, 520, 100, 58, 46);
          return (
            <g key={name} data-chain={i}>
              <path d={s.left} fill="url(#side-left)" />
              <path d={s.right} fill="url(#side-right)" />
              <path data-top d={s.top} fill="#242424" stroke="#3a3a3a" />
              <g data-logo className={styles.chainLogo}>
                <Icon x={x - 13} y={520 - 15} size={26} variant="mono" />
              </g>
              <text x={x} y={604} textAnchor="middle" className={styles.chainLabel}>
                {name}
              </text>
            </g>
          );
        })}
      </g>

      <rect data-part="settle" x={CENTER.x - 12} y={PAIR.y - 12} width="24" height="24" fill="#ffff00" opacity="0" />

      <g data-part="receipt" opacity="0">
        <rect x="330" y="444" width="232" height="30" rx="4" fill="#ffff00" />
        <text x="342" y="464" className={styles.receipt}>
          ATOMIC SETTLEMENT, 2 OF 2 LEGS
        </text>
      </g>
      <g data-part="matched" opacity="0">
        <text x={CENTER.x} y={PAIR.y - 26} textAnchor="middle" className={styles.matched}>
          BEST NET QUOTE
        </text>
      </g>
    </svg>
  );
}

// ------------------------------------------------------------------ section

/**
 * A pinned card: a letter list on the left, a live diagram on the
 * right, and the page's scroll driving both. The diagram is one scene that
 * morphs from step to step: the package book (A) folds into a grid of
 * solver quotes (B), the winning quote pairs with the order, and the pair
 * drops into a chain to settle with a receipt (C).
 */
export default function Engine() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const q = gsap.utils.selector(root);
      const card = q<HTMLElement>(`.${styles.card}`)[0];
      const steps = q<HTMLElement>("[data-step]");
      const panels = q<HTMLElement>("[data-panel]");
      const bars = q<HTMLElement>("[data-bar]");
      const reduced = reducedMotion();

      let current = -1;
      const show = (index: number) => {
        if (index === current) return;
        const previous = current;
        current = index;
        steps.forEach((step, i) => step.toggleAttribute("data-active", i === index));
        panels.forEach((panel, i) => {
          if (i === index) {
            gsap.fromTo(
              panel,
              { opacity: 0, y: previous < index ? 24 : -24, filter: "blur(6px)" },
              { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.7, ease: "expo.out", overwrite: true },
            );
            panel.removeAttribute("aria-hidden");
          } else {
            gsap.to(panel, { opacity: 0, duration: 0.25, overwrite: true });
            panel.setAttribute("aria-hidden", "true");
          }
        });
        const label = q<HTMLElement>(`[data-step="${index}"] [data-name]`)[0];
        gsap.to(label, { duration: 0.5, scrambleText: { text: label.textContent!, chars: SCRAMBLE, speed: 0.8 } });
      };
      show(0);
      if (reduced) {
        card.dataset.static = "";
        return;
      }

      // Idle motion while the section is on screen: price packets running down the feeds.
      const idle = gsap.timeline({ paused: true, repeat: -1 });
      VENUES.forEach((x, i) => {
        idle.fromTo(
          q(`[data-packet="${i}"]`),
          { opacity: 1 },
          { motionPath: { path: feed(x) }, opacity: 0.2, duration: 1.4, ease: "power1.in" },
          i * 0.45,
        );
      });
      const priceTicker = window.setInterval(() => {
        const price = q<SVGTSpanElement>("[data-mid-price]")[0];
        price.textContent = `+${(0.42 + (Math.random() - 0.5) * 0.02).toFixed(2)}%`;
      }, 900);

      // The scroll timeline: 3 units, one per step.
      const orders = q<SVGRectElement>("[data-order]");
      const [bid, ask] = MATCH.map((i) => orders[i]);
      const tl = gsap.timeline({
        defaults: { ease: "power2.inOut" },
        scrollTrigger: {
          trigger: root.current,
          start: "top top",
          end: "bottom bottom",
          scrub: 0.8,
          onUpdate: (self) => {
            show(Math.min(2, Math.floor(self.progress * 3 + 0.08)));
            bars.forEach((bar, i) => gsap.set(bar, { scaleX: gsap.utils.clamp(0, 1, self.progress * 3 - i) }));
          },
          onToggle: (self) => (self.isActive ? idle.play() : idle.pause()),
        },
      });

      // A to B: book rows fold into quote cells; venues and feeds step back.
      tl.to({}, { duration: 0.55 })
        .addLabel("toB")
        .to(q('[data-part="venues"], [data-part="feeds"]'), { opacity: 0.18, duration: 0.3 }, "toB")
        .to(q('[data-part="midline"]'), { opacity: 0, duration: 0.2 }, "toB")
        .to(q('[data-part="mid"]'), { opacity: 0, duration: 0.2 }, "toB")
        .to(
          orders,
          {
            attr: {
              x: (i: number) => CELLS[i].x,
              y: (i: number) => CELLS[i].y,
              width: CELL,
              height: CELL,
            },
            fill: "#2a2a2a",
            duration: 0.4,
            stagger: 0.012,
          },
          "toB",
        )
        .to(q('[data-part="crowd"]'), { opacity: 1, duration: 0.3 }, "toB+=0.2");

      // B: quotes are compared pair by pair; the last pair is the winner.
      LINKS.forEach((_, i) => {
        const at = `toB+=${0.45 + i * 0.09}`;
        tl.to(q(`[data-link="${i}"]`), { strokeDashoffset: 0, duration: 0.07, ease: "none" }, at);
        if (i < LINKS.length - 1) tl.to(q(`[data-link="${i}"]`), { opacity: 0, duration: 0.08 }, `${at}+=0.1`);
      });
      tl.addLabel("matched", "toB+=0.9")
        .to(bid, { attr: { x: PAIR.left - CELL / 2, y: PAIR.y - CELL / 2 }, fill: "#ffff00", duration: 0.25 }, "matched")
        .to(ask, { attr: { x: PAIR.right - CELL / 2, y: PAIR.y - CELL / 2 }, fill: "#00ffff", duration: 0.25 }, "matched")
        .to(
          q(`[data-link="${LINKS.length - 1}"]`),
          { attr: { x1: PAIR.left + CELL / 2, y1: PAIR.y, x2: PAIR.right - CELL / 2, y2: PAIR.y }, duration: 0.25 },
          "matched",
        )
        .to(q('[data-part="matched"]'), { opacity: 1, duration: 0.12 }, "matched+=0.15");

      // B to C: the pair fuses and drops into a chain, which lights up with the receipt.
      tl.addLabel("toC", 2)
        .to(orders.filter((_, i) => !MATCH.includes(i)), { opacity: 0.2, duration: 0.25 }, "toC")
        .to(q('[data-part="crowd"]'), { opacity: 0.2, duration: 0.25 }, "toC")
        .to(q('[data-part="links"], [data-part="matched"]'), { opacity: 0, duration: 0.15 }, "toC")
        .to([bid, ask], { attr: { x: CENTER.x - CELL / 2 }, opacity: 0, duration: 0.18 }, "toC")
        .fromTo(
          q('[data-part="settle"]'),
          { opacity: 0, scale: 0.4, svgOrigin: `${CENTER.x} ${PAIR.y}` },
          { opacity: 1, scale: 1, duration: 0.14 },
          "toC+=0.12",
        )
        .to(q('[data-part="settle"]'), { attr: { x: CHAIN_SLABS[SETTLING_CHAIN].x - 12, y: 520 - 12 }, duration: 0.3, ease: "power2.in" }, "toC+=0.3")
        .to(q('[data-part="settle"]'), { opacity: 0, duration: 0.05 }, "toC+=0.6")
        .to(q(`[data-chain="${SETTLING_CHAIN}"] [data-top]`), { fill: "#ffff00", stroke: "#ffff00", duration: 0.08 }, "toC+=0.6")
        .to(q(`[data-chain="${SETTLING_CHAIN}"] [data-logo]`), { color: "#000000", duration: 0.08 }, "toC+=0.6")
        .fromTo(q('[data-part="receipt"]'), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.12 }, "toC+=0.68")
        .to({}, { duration: 0.2 });

      return () => window.clearInterval(priceTicker);
    },
    { scope: root },
  );

  return (
    <section ref={root} id="engine" className={styles.engine} data-theme="dark">
      <div className={styles.stage}>
        <div className={styles.card}>
          <div className={styles.text}>
            <header className={styles.head}>
              <ol className={styles.steps}>
                {STEPS.map(({ letter, name }, i) => (
                  <li key={letter} data-step={i}>
                    <span className={styles.letter} aria-hidden="true">
                      <span>{letter}</span>
                      <span className={styles.arrow}>
                        <Arrow />
                      </span>
                    </span>
                    <span data-name>{name}</span>
                  </li>
                ))}
              </ol>
            </header>

            <div className={styles.panels}>
              {STEPS.map(({ letter, title, body }, i) => (
                <article key={letter} className={styles.panel} data-panel={i}>
                  <h3 className={styles.title}>{title}</h3>
                  {body.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </article>
              ))}
            </div>

            <footer className={styles.foot}>
              <a className={styles.pill} href="#shielded">
                Settlement classes
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M3 9 9 3M4 3h5v5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                </svg>
              </a>
              <div className={styles.progress} aria-hidden="true">
                {STEPS.map(({ letter }) => (
                  <span key={letter}>
                    <i data-bar />
                  </span>
                ))}
              </div>
            </footer>
          </div>

          <div className={styles.visual}>
            <Scene />
          </div>
        </div>
      </div>
    </section>
  );
}
