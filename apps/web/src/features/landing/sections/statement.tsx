"use client";

import { useRef } from "react";
import { gsap, reducedMotion, SplitText, useGSAP } from "@/features/landing/gsap";
import styles from "./statement.module.css";

/**
 * An editorial photograph, walking into light, under a line of serif
 * that starts out of focus and sharpens word by word as you scroll.
 */
export default function Statement() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (reducedMotion()) return;
      const q = gsap.utils.selector(root);
      const split = SplitText.create(q(`.${styles.title}`), { type: "words", wordsClass: "word" });
      gsap
        .timeline({
          defaults: { ease: "none" },
          scrollTrigger: { trigger: root.current, start: "top top", end: "bottom bottom", scrub: 1 },
        })
        .fromTo(q(`.${styles.photo}`), { scale: 1.28 }, { scale: 1, duration: 1 }, 0)
        .fromTo(q(`.${styles.glare}`), { opacity: 0.9 }, { opacity: 0.35, duration: 1 }, 0)
        .fromTo(
          split.words,
          { filter: "blur(22px)", opacity: 0.15, y: 18 },
          { filter: "blur(0px)", opacity: 1, y: 0, duration: 0.35, stagger: 0.05 },
          0.05,
        )
        .fromTo(q(`.${styles.foot}`), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.15 }, 0.62);
      return () => split.revert();
    },
    { scope: root },
  );

  return (
    <section ref={root} className={styles.statement} data-theme="dark">
      <div className={styles.stage}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.photo} src="/landing/light-walk.avif" alt="" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.glare} src="/landing/glare.avif" alt="" />
        <div className={styles.shade} aria-hidden="true" />

        <div className={`container ${styles.content}`}>
          <h2 className={styles.title}>Onchain venues sell single trades. Strategies have more than one leg.</h2>
          <div className={styles.foot}>
            <p>
              Vaults, desks and treasuries keep rebuilding the same risky work: placing each leg, watching for partial
              fills, unwinding when one side fails. Naryx makes the complete strategy the thing you trade.
            </p>
            <span className="mono">Solana, Base, Hyperliquid, Arbitrum</span>
          </div>
        </div>
      </div>
    </section>
  );
}
