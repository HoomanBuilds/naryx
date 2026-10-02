"use client";

import { useRef } from "react";
import Arrow from "@/features/landing/arrow";
import { useExperience } from "@/features/landing/experience";
import Button from "@/features/landing/button";
import { GlyphField } from "@/features/landing/glyph-field";
import { loadGlyphs } from "@/features/landing/glyphs";
import { gsap, reducedMotion, SCRAMBLE, ScrollTrigger, SplitText, useGSAP } from "@/features/landing/gsap";
import { paintHeroScene } from "@/features/landing/hero-scene";
import { CHAINS } from "@/features/brand/chain-icons";
import styles from "./hero.module.css";

/**
 * The market as a painted valley, drawn in the glyph alphabet: single legs
 * scattered across venues. Scrolling sorts them into one package order book
 * that meets at a package mark, which is where the next section (the engine)
 * picks up.
 */
export default function Hero() {
  const { ready } = useExperience();
  const root = useRef<HTMLElement>(null);
  const field = useRef<GlyphField | null>(null);

  useGSAP(
    () => {
      const q = gsap.utils.selector(root);
      const stage = q<HTMLElement>(`.${styles.stage}`)[0];
      const canvas = q<HTMLCanvasElement>("canvas")[0];
      const reduced = reducedMotion();
      let disposed = false;
      const cleanups: (() => void)[] = [];

      loadGlyphs().then((glyphs) => {
        if (disposed) return;
        const mosaic = new GlyphField({ canvas, glyphs, source: paintHeroScene(), focusX: 0.62 });
        field.current = mosaic;
        if (reduced) mosaic.intro = 1;

        // Overlays that sit on the chart follow its geometry.
        const place = () => {
          const { midX, baseY, topY, left, right } = mosaic.chart;
          stage.style.setProperty("--mid-x", `${midX}px`);
          stage.style.setProperty("--base-y", `${baseY}px`);
          stage.style.setProperty("--top-y", `${topY}px`);
          stage.style.setProperty("--chart-left", `${left}px`);
          stage.style.setProperty("--chart-right", `${right}px`);
        };
        place();

        const draw = () => void mosaic.frame();
        gsap.ticker.add(draw);
        cleanups.push(() => gsap.ticker.remove(draw));

        // Prices ticking: a few glyphs change at a time.
        const twinkle = window.setInterval(() => !reduced && mosaic.twinkle(), 110);
        cleanups.push(() => window.clearInterval(twinkle));

        const observer = new ResizeObserver(() => {
          mosaic.layout();
          place();
          ScrollTrigger.refresh();
        });
        observer.observe(canvas);
        cleanups.push(() => observer.disconnect());

        if (!reduced && matchMedia("(hover: hover) and (pointer: fine)").matches) {
          const move = (event: PointerEvent) => {
            const box = canvas.getBoundingClientRect();
            mosaic.setPointer(event.clientX - box.left, event.clientY - box.top, true);
          };
          const leave = () => mosaic.setPointer(0, 0, false);
          stage.addEventListener("pointermove", move);
          stage.addEventListener("pointerleave", leave);
          cleanups.push(() => {
            stage.removeEventListener("pointermove", move);
            stage.removeEventListener("pointerleave", leave);
          });
        }

        if (reduced) return;

        // The sort, scrubbed by the smoothed scroll.
        const price = q<HTMLElement>("[data-price]")[0];
        const timeline = gsap.timeline({
          defaults: { ease: "none" },
          scrollTrigger: { trigger: root.current, start: "top top", end: "bottom bottom", scrub: 1 },
        });
        timeline
          .to(mosaic, { sort: 1, duration: 1, onUpdate: () => mosaic.invalidate() }, 0)
          .to(q(`.${styles.copy}`), { y: -60, opacity: 0, duration: 0.18 }, 0.02)
          .to(q(`.${styles.scrim}`), { opacity: 0, duration: 0.25 }, 0.05)
          .to(q(`.${styles.side}, .${styles.scroll}`), { opacity: 0, duration: 0.12 }, 0.02)
          .fromTo(q(`.${styles.midline}`), { scaleY: 0 }, { scaleY: 1, duration: 0.18 }, 0.55)
          .fromTo(q(`.${styles.axis}`), { opacity: 0 }, { opacity: 1, duration: 0.15 }, 0.6)
          .fromTo(q(`.${styles.midLabel}`), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.12 }, 0.66)
          .add(() => {
            if (timeline.scrollTrigger?.direction === 1) {
              gsap.to(price, { duration: 0.8, scrambleText: { text: price.dataset.price!, chars: "0123456789", speed: 0.6 } });
            }
          }, 0.68)
          .fromTo(q(`.${styles.caption}`), { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.2 }, 0.62);
      });

      return () => {
        disposed = true;
        cleanups.forEach((cleanup) => cleanup());
      };
    },
    { scope: root },
  );

  // Intro: the field decodes as the loader dissolves, then the headline sets.
  useGSAP(
    () => {
      if (!ready || reducedMotion()) return;
      const q = gsap.utils.selector(root);
      const split = SplitText.create(q("[data-line]"), { type: "words", mask: "words", wordsClass: "word" });
      const kicker = q<HTMLElement>(`.${styles.kicker} span`)[0];
      const wait = () =>
        new Promise<void>((resolve) => {
          const check = () => (field.current ? resolve() : requestAnimationFrame(check));
          check();
        });
      gsap.set(split.words, { yPercent: 110 });
      gsap.set(q("[data-hero-fade]"), { opacity: 0, y: 14 });
      wait().then(() => {
        const mosaic = field.current!;
        gsap
          .timeline({ defaults: { ease: "expo.out" } })
          .to(mosaic, { intro: 1, duration: 2, ease: "power2.out", onUpdate: () => mosaic.invalidate() }, 0)
          .to(split.words, { yPercent: 0, duration: 1.3, stagger: 0.06 }, 0.55)
          .to(kicker, { duration: 0.9, scrambleText: { text: kicker.textContent!, chars: SCRAMBLE, speed: 0.5 } }, 0.5)
          .to(q("[data-hero-fade]"), { opacity: 1, y: 0, duration: 1.1, stagger: 0.08 }, 0.9);
      });
      return () => split.revert();
    },
    { dependencies: [ready], scope: root },
  );

  return (
    <section ref={root} id="top" className={styles.hero} data-theme="dark">
      <div className={styles.stage}>
        <canvas className={styles.canvas} aria-hidden="true" />
        <div className={styles.scrim} aria-hidden="true" />

        <div className={`container ${styles.content}`}>
          <div className={styles.copy}>
            <p className={`tag ${styles.kicker}`}>
              <span>Open strategy execution network</span>
            </p>
            <h1 className={`display ${styles.title}`}>
              <span data-line>Trade the</span>
              <span data-line>strategy,</span>
              <span data-line>not the legs</span>
            </h1>
          </div>

          <div className={styles.side} data-hero-fade>
            <p>
              Send one order with every leg of a strategy. Independent solvers quote the complete outcome, Naryx holds
              them to your limits across venues, and one receipt covers the whole package.
            </p>
            <div className={styles.actions}>
              <Button href="/trade" arrow>
                Open the terminal
              </Button>
              <Button href="#engine" variant="outline">
                How it works
              </Button>
            </div>
            <div className={styles.chains}>
              <span className="mono">Settles on</span>
              <ul>
                {CHAINS.map(({ id, name, Icon }) => (
                  <li key={id}>
                    <Icon size={16} variant="branded" aria-hidden />
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <p className={`mono ${styles.scroll}`} data-hero-fade>
          Scroll to sort the market
        </p>

        {/* The depth chart's labels, placed on its geometry */}
        <div className={styles.overlay} aria-hidden="true">
          <span className={styles.midline} />
          <span className={styles.midLabel}>
            <span className="tag">Illustrative package mark</span>
            <strong className="mono" data-price="+0.42%">
              +0.42%
            </strong>
          </span>
          <span className={`mono ${styles.axis} ${styles.bids}`}>
            Bids <Arrow direction="left" /> +0.38%
          </span>
          <span className={`mono ${styles.axis} ${styles.asks}`}>
            +0.46% <Arrow /> Asks
          </span>
        </div>
        <p className={`display ${styles.caption}`}>Every leg, one package book</p>
      </div>
    </section>
  );
}
