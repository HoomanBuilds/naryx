"use client";

import { useRef, type FormEvent } from "react";
import { gsap, reducedMotion, ScrollTrigger, useGSAP } from "@/features/landing/gsap";
import { ParticleWordmark } from "@/features/landing/particle-wordmark";
import styles from "./footer.module.css";

const COLUMNS = [
  { title: "Product", links: ["Terminal", "Market makers", "Receipts"] },
  { title: "Build", links: ["Docs", "API", "Solver kit", "Brand assets"] },
  { title: "Network", links: ["Solvers", "Settlement classes", "Status"] },
  { title: "Company", links: ["Blog", "X", "Careers", "Contact"] },
  { title: "Security & legal", links: ["Security model", "Activation status"] },
];
// Only destinations that exist are links. Everything else is shown as not yet published.
const HREFS: Record<string, string> = {
  Terminal: "/trade",
  "Market makers": "#use",
  Receipts: "#engine",
  Solvers: "#engine",
  "Settlement classes": "#shielded",
  "Activation status": "/network",
};

function Crosshair() {
  return (
    <span className={styles.crosshair} aria-hidden="true">
      <i />
      <i />
    </span>
  );
}

/**
 * The footer: a violet cloud sky, glowing square and crosshair
 * ornaments, the newsletter tag and link columns in the mono face, and a
 * particle wordmark that breaks into pixels and scatters from the pointer.
 */
export default function Footer() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const q = gsap.utils.selector(root);
      const canvas = q<HTMLCanvasElement>("canvas")[0];
      const reduced = reducedMotion();
      let wordmark: ParticleWordmark | undefined;
      let running = false;
      const cleanups: (() => void)[] = [];

      const family = getComputedStyle(document.documentElement).getPropertyValue("--font-accent").trim();
      // Wait for the real face only; next/font's fallback face may not exist on every system.
      const primary = family.split(",")[0];
      const fontReady = document.fonts.load(`italic 400 100px ${primary}`).catch(() => undefined);
      fontReady.then(() => {
        wordmark = new ParticleWordmark({ canvas, text: "Naryx", family, color: "rgba(248, 248, 255, 0.78)" });
        wordmark.draw();

        const tick = () => {
          if (!wordmark!.frame()) {
            gsap.ticker.remove(tick);
            running = false;
          }
        };
        const wake = () => {
          if (running) return;
          running = true;
          gsap.ticker.add(tick);
        };
        cleanups.push(() => gsap.ticker.remove(tick));

        if (!reduced) {
          // The first time it comes into view, the word flies together.
          ScrollTrigger.create({
            trigger: canvas,
            start: "top 90%",
            once: true,
            onEnter: () => {
              wordmark!.scatter();
              wake();
            },
          });
          if (matchMedia("(hover: hover) and (pointer: fine)").matches) {
            const move = (event: PointerEvent) => {
              const box = canvas.getBoundingClientRect();
              wordmark!.setPointer(event.clientX - box.left, event.clientY - box.top, true);
              wake();
            };
            const leave = () => {
              wordmark!.setPointer(-9999, -9999, false);
              wake();
            };
            canvas.addEventListener("pointermove", move);
            canvas.addEventListener("pointerleave", leave);
            cleanups.push(() => {
              canvas.removeEventListener("pointermove", move);
              canvas.removeEventListener("pointerleave", leave);
            });
          }
        }

        const observer = new ResizeObserver(() => {
          wordmark!.layout();
          wordmark!.draw();
        });
        observer.observe(canvas);
        cleanups.push(() => observer.disconnect());
      });

      if (!reduced) {
        gsap.fromTo(
          q(`.${styles.sky}`),
          { scale: 1.2, yPercent: -6 },
          { scale: 1, yPercent: 0, ease: "none", scrollTrigger: { trigger: root.current, start: "top bottom", end: "bottom bottom", scrub: true } },
        );
      }

      return () => cleanups.forEach((cleanup) => cleanup());
    },
    { scope: root },
  );

  // There is no mailing list yet, so the form is visibly closed instead of pretending to accept an address.
  const subscribe = (event: FormEvent) => {
    event.preventDefault();
  };

  return (
    <footer ref={root} id="footer" className={styles.footer}>
      <div className={styles.sky} aria-hidden="true" />

      <div className={styles.row}>
        <span className={styles.group}>
          <i className={styles.square} />
          <i className={`${styles.square} ${styles.hollow}`} />
        </span>
        <Crosshair />
        <i className={styles.square} />
      </div>

      <div className={styles.middle}>
        <div className={styles.top}>
          <form className={styles.form} onSubmit={subscribe}>
            <label htmlFor="newsletter" className={`${styles.title} ${styles.brand}`}>
              Newsletter
            </label>
            <div className={styles.field}>
              <input id="newsletter" type="email" placeholder="OPENS AT PUBLIC LAUNCH" disabled aria-describedby="newsletter-status" />
              <button type="submit" disabled>
                Not open yet
              </button>
            </div>
          </form>
          <p id="newsletter-status" className={`${styles.title} ${styles.contact}`}>
            Newsletter and contact channels open at public launch
          </p>
        </div>

        <nav className={styles.columns} aria-label="Footer">
          {COLUMNS.map(({ title, links }) => (
            <div key={title}>
              <p className={styles.title}>{title}</p>
              <ul>
                {links.map((link) => (
                  <li key={link}>
                    {HREFS[link] === undefined ? (
                      <span className={styles.unpublished} aria-disabled="true" title="Not yet published">
                        {link}
                      </span>
                    ) : (
                      <a href={HREFS[link]}>{link}</a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <canvas className={styles.wordmark} role="img" aria-label="Naryx" />
      </div>

      <div className={`${styles.row} ${styles.bottom}`}>
        <span className={styles.group}>
          <i className={styles.square} />
          <span className={styles.glow}>2026</span>
          <span className={styles.glow}>Naryx Labs</span>
          <i className={`${styles.square} ${styles.hollow}`} />
        </span>
        <Crosshair />
        <span className={styles.group}>
          <a className={styles.glow} href="#top">
            Privacy policy &amp; legal terms
          </a>
          <a className={styles.glow} href="#top">
            Credits
          </a>
          <i className={styles.square} />
        </span>
      </div>
    </footer>
  );
}
