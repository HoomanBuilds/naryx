"use client";

import { useRef } from "react";
import { GLYPHS, glyphSrc } from "@/features/landing/glyphs";
import { gsap, ScrollTrigger, SplitText, useGSAP, reducedMotion } from "@/features/landing/gsap";
import styles from "./shielded.module.css";

const FEATURES = [
  {
    title: "Atomic",
    body: "Every leg executes inside one real rollback boundary. If any precondition or postcondition fails, the whole package reverts.",
    cells: [0, 1, 2, 6, 7],
  },
  {
    title: "Batched, bounded residual",
    body: "Legs go out as one coordinated batch without a shared rollback. The signed package sets the quantity policy, the residual you accept and the recovery steps.",
    cells: [3, 4, 8, 9, 13, 14],
  },
  {
    title: "Bonded asynchronous",
    body: "Two-phase venue requests get deadlines, funded bonds, loss and residual caps, and a defined end state. This class is never called atomic.",
    cells: [10, 11, 15, 16, 17],
  },
  {
    title: "Cross-domain",
    body: "Cross-chain packages use inventory already in place on each chain, with no bridge in the critical path. Each chain's outcome is evidenced on its own.",
    cells: [5, 12, 18, 7, 14],
  },
];

/** A pointy-top hexagon grid of radius 2 (19 cells), in axial coordinates. */
const HEXES = (() => {
  const cells: { q: number; r: number }[] = [];
  for (let q = -2; q <= 2; q++) {
    for (let r = Math.max(-2, -q - 2); r <= Math.min(2, -q + 2); r++) cells.push({ q, r });
  }
  // Read in rows, top to bottom, so feature cell lists are easy to reason about.
  return cells.sort((a, b) => a.r - b.r || a.q - b.q);
})();
const SIZE = 52;
const hexPoints = (cx: number, cy: number, s: number) =>
  Array.from({ length: 6 }, (_, k) => {
    const angle = (Math.PI / 180) * (60 * k - 30);
    return `${(cx + s * Math.cos(angle)).toFixed(1)},${(cy + s * Math.sin(angle)).toFixed(1)}`;
  }).join(" ");

function Honeycomb() {
  return (
    <svg className={styles.honeycomb} viewBox="-300 -270 600 540" aria-hidden="true">
      <defs>
        {/* White glyphs, recoloured: yellow on black, black on yellow */}
        <filter id="to-yellow">
          <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" />
        </filter>
        <filter id="to-black">
          <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" />
        </filter>
      </defs>
      {HEXES.map(({ q, r }, i) => {
        const cx = SIZE * Math.sqrt(3) * (q + r / 2);
        const cy = SIZE * 1.5 * r;
        const centre = q === 0 && r === 0;
        return (
          <g key={i} data-hex={i} className={centre ? styles.centre : undefined}>
            <polygon points={hexPoints(cx, cy, SIZE - 3)} />
            {centre ? (
              <text x={cx} y={cy + 9} textAnchor="middle">
                NRX
              </text>
            ) : (
              <image
                href={glyphSrc(GLYPHS[(i * 5) % GLYPHS.length])}
                x={cx - 15}
                y={cy - 15}
                width="30"
                height="30"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The feature run: a big light intro line, then numbered features along
 * a timeline, beside a honeycomb of glyphs that lights the cells belonging to
 * whichever feature is in view.
 */
export default function Shielded() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const q = gsap.utils.selector(root);
      const features = q<HTMLElement>("[data-feature]");
      const light = (index: number) => {
        features.forEach((feature, i) => feature.toggleAttribute("data-active", i === index));
        const on = new Set(FEATURES[index].cells);
        q<SVGGElement>("[data-hex]").forEach((hex, i) => hex.toggleAttribute("data-on", on.has(i)));
      };
      light(0);
      features.forEach((feature, index) =>
        ScrollTrigger.create({
          trigger: feature,
          start: "top 60%",
          end: "bottom 60%",
          onToggle: (self) => self.isActive && light(index),
        }),
      );

      if (reducedMotion()) return;
      // The intro line rises in line by line.
      const split = SplitText.create(q(`.${styles.intro}`), { type: "lines", mask: "lines", linesClass: "line" });
      gsap.from(split.lines, {
        yPercent: 100,
        duration: 1.2,
        ease: "expo.out",
        stagger: 0.08,
        scrollTrigger: { trigger: q(`.${styles.intro}`)[0], start: "top 80%" },
      });
      gsap.to(q(`.${styles.honeycomb}`), {
        rotate: 30,
        ease: "none",
        scrollTrigger: { trigger: root.current, start: "top bottom", end: "bottom top", scrub: true },
      });
      return () => split.revert();
    },
    { scope: root },
  );

  return (
    <section ref={root} id="shielded" className={styles.shielded} data-theme="dark">
      <div className="container">
        <p className={styles.intro}>
          Naryx never hides behind one vague execution label. Every route is placed in a settlement class, and the
          class tells you exactly what is guaranteed.
        </p>

        <div className={styles.grid}>
          <div className={styles.sticky}>
            <Honeycomb />
          </div>

          <ol className={styles.features}>
            {FEATURES.map(({ title, body }, i) => (
              <li key={title} className={styles.feature} data-feature>
                <span className={`mono ${styles.number}`}>0{i + 1}</span>
                <h3 className="display">{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
