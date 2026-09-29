"use client";

import { useRef } from "react";
import { gsap, reducedMotion, ScrollTrigger, useGSAP } from "@/features/landing/gsap";
import styles from "./marquee.module.css";

/** A looping marquee band, pushed faster (or backwards) by the scroll. */
export default function Marquee({ text, href }: { text: string; href: string }) {
  const root = useRef<HTMLAnchorElement>(null);

  useGSAP(
    () => {
      if (reducedMotion()) return;
      const loop = gsap.to(`.${styles.track}`, { xPercent: -50, duration: 26, ease: "none", repeat: -1 });
      ScrollTrigger.create({
        trigger: root.current,
        start: "top bottom",
        end: "bottom top",
        onUpdate: (self) => {
          const boost = Math.min(Math.abs(self.getVelocity()) / 300, 6);
          gsap.to(loop, {
            timeScale: self.direction * (1 + boost),
            duration: 0.2,
            overwrite: true,
            onComplete: () => void gsap.to(loop, { timeScale: self.direction, duration: 1 }),
          });
        },
      });
    },
    { scope: root },
  );

  const run = (copy: number) =>
    Array.from({ length: 4 }, (_, i) => (
      <span key={`${copy}-${i}`} className={styles.item} aria-hidden={copy > 0 || i > 0 || undefined}>
        {text}
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 19 19 5M8 5h11v11" fill="none" stroke="currentColor" strokeWidth="2.4" />
        </svg>
      </span>
    ));

  return (
    <a ref={root} href={href} className={styles.marquee}>
      <span className={styles.track}>
        {run(0)}
        {run(1)}
      </span>
    </a>
  );
}
