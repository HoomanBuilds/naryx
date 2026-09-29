"use client";

import { useRef } from "react";
import { GLYPHS, glyphSrc } from "@/features/landing/glyphs";
import { gsap, reducedMotion, useGSAP } from "@/features/landing/gsap";
import styles from "./roadmap.module.css";

const PATH = "M40 440H300V300H620V380H900V140H1160";
/** Stops, with their label placed wherever the line leaves room. */
const STAGES = [
  { x: 180, y: 440, title: "Entry", when: "Quote, sign, settle", place: "below" },
  { x: 460, y: 300, title: "Monitor", when: "PnL, funding, margin, residuals", place: "above" },
  { x: 760, y: 380, title: "Rebalance or roll", when: "Same package account", place: "below" },
  { x: 1030, y: 140, title: "Exit", when: "Every leg, one order", place: "above end" },
];
/** How far along the path (0 to 1) each stop sits, for lighting them as the line passes. */
const AT = [0.1, 0.37, 0.6, 0.86];
const SPRINKLES = [
  { x: 110, y: 330, g: 11 },
  { x: 520, y: 200, g: 3 },
  { x: 860, y: 470, g: 7 },
  { x: 1100, y: 290, g: 12 },
  { x: 360, y: 470, g: 1 },
];

/**
 * A pixel roadmap, used for a package's lifecycle: a stepped line that
 * draws itself with the scroll, numbered stops that fill as it reaches them,
 * and a glyph riding the line.
 */
export default function Roadmap() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const q = gsap.utils.selector(root);
      const stops = q<HTMLElement>("[data-stop]");
      if (reducedMotion()) {
        stops.forEach((stop) => stop.setAttribute("data-on", ""));
        return;
      }
      const state = { t: 0 };
      gsap.set(q("[data-line]"), { strokeDashoffset: 1 });
      gsap.to(state, {
        t: 1,
        ease: "none",
        scrollTrigger: { trigger: q(`.${styles.map}`)[0], start: "top 75%", end: "bottom 45%", scrub: 0.8 },
        onUpdate: () => {
          gsap.set(q("[data-line]"), { strokeDashoffset: 1 - state.t });
          stops.forEach((stop, i) => stop.toggleAttribute("data-on", state.t >= AT[i]));
        },
      });
      gsap.to(q("[data-runner]"), {
        // The runner is drawn around the origin, so the path can be followed as-is.
        motionPath: { path: PATH },
        ease: "none",
        scrollTrigger: { trigger: q(`.${styles.map}`)[0], start: "top 75%", end: "bottom 45%", scrub: 0.8 },
      });
    },
    { scope: root },
  );

  return (
    <section ref={root} id="roadmap" className={styles.roadmap} data-theme="yellow">
      <div className="container">
        <h2 className={styles.title} data-reveal>
          Package
          <br />
          lifecycle
        </h2>

        <div className={styles.map}>
          <svg viewBox="0 0 1200 520" aria-hidden="true">
            <path d={PATH} className={styles.track} />
            <path d={PATH} className={styles.line} pathLength={1} strokeDasharray="1" data-line />
            {SPRINKLES.map(({ x, y, g }) => (
              <image key={`${x}-${y}`} href={glyphSrc(GLYPHS[g])} x={x} y={y} width="26" height="26" className={styles.sprinkle} />
            ))}
            <g className={styles.runner} data-runner>
              <rect x="-16" y="-16" width="32" height="32" rx="4" />
              <image href={glyphSrc(GLYPHS[10])} x="-11" y="-11" width="22" height="22" />
            </g>
          </svg>
          {STAGES.map(({ x, y, title, when, place }, i) => (
            <div
              key={title}
              className={styles.stop}
              style={{ left: `${(x / 1200) * 100}%`, top: `${(y / 520) * 100}%` }}
              data-stop
              data-place={place}
            >
              <span className={`mono ${styles.dot}`}>0{i + 1}</span>
              <span className={styles.label}>
                <strong className="display">{title}</strong>
                <span className="mono">{when}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
