"use client";

import { useRef } from "react";
import Arrow from "@/features/landing/arrow";
import { GLYPHS, glyphSrc } from "@/features/landing/glyphs";
import { gsap, reducedMotion, useGSAP } from "@/features/landing/gsap";
import styles from "./involved.module.css";

const LINKS = [
  { group: "Trade", note: "Review a package, its quotes, settlement class and fees in the terminal.", label: "Open the terminal", href: "/trade" },
  { group: "Operate", note: "How independent solvers compete to quote complete packages.", label: "Solver competition", href: "#engine" },
  { group: "Join the community", note: "New strategies, domains and product news.", label: "X.com" },
  { group: "Build", note: "Package format, API reference and the protocol spec.", label: "Documentation" },
];

/** The name in the glyph cipher: each letter is a figure, a ring over a glyph. */
const FIGURES = [
  { letter: "N", glyph: 13 },
  { letter: "A", glyph: 0 },
  { letter: "R", glyph: 9 },
  { letter: "Y", glyph: 3 },
  { letter: "X", glyph: 4 },
];

/** The closing block: link cells, the glyph figures, and the tagline bar. */
export default function Involved() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (reducedMotion()) return;
      gsap.from(`.${styles.figure}`, {
        yPercent: 60,
        opacity: 0,
        duration: 0.9,
        ease: "back.out(2.2)",
        stagger: 0.08,
        scrollTrigger: { trigger: `.${styles.panel}`, start: "top 80%" },
      });
    },
    { scope: root },
  );

  return (
    <section ref={root} className={styles.involved} data-theme="yellow">
      <div className="container">
        <h2 className={`display ${styles.title}`} data-reveal>
          Get involved
        </h2>
        <div className={styles.cells}>
          {LINKS.map(({ group, note, label, href }) => {
            const content = (
              <>
                <span className={styles.groupRow}>
                  <span className="mono">{group}</span>
                  {href === undefined ? <span className={`mono ${styles.soon}`}>At public launch</span> : null}
                </span>
                <span className={styles.note}>{note}</span>
                <span className={`display ${styles.label}`}>
                  {label}
                  {href === undefined ? null : (
                    <svg viewBox="0 0 12 12" aria-hidden="true">
                      <path d="M3 9 9 3M4 3h5v5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                    </svg>
                  )}
                </span>
              </>
            );
            return href === undefined ? (
              <div key={label} className={`${styles.cell} ${styles.pending}`} aria-disabled="true">
                {content}
              </div>
            ) : (
              <a key={label} href={href} className={styles.cell}>
                {content}
              </a>
            );
          })}
        </div>

        <div className={styles.panel}>
          <div className={styles.figures} role="img" aria-label="Naryx, written in glyphs">
            {FIGURES.map(({ letter, glyph }) => (
              <span key={letter} className={styles.figure}>
                <i className={styles.head} />
                <i
                  className={styles.body}
                  style={{ WebkitMaskImage: `url(${glyphSrc(GLYPHS[glyph])})`, maskImage: `url(${glyphSrc(GLYPHS[glyph])})` }}
                />
                <span className="mono">{letter}</span>
              </span>
            ))}
          </div>
        </div>

        <div className={styles.bar}>
          <p className="display">Trade the strategy, not the legs</p>
          <a href="/trade" className={styles.signup}>
            Open the terminal
            <span aria-hidden="true">
              <Arrow />
            </span>
          </a>
        </div>
      </div>
    </section>
  );
}
