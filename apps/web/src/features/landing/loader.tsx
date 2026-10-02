"use client";

import { useEffect, useRef, useState } from "react";
import { useExperience } from "@/features/landing/experience";
import { GLYPHS, glyphSrc, loadGlyphs, BLOCK, buildAtlas } from "@/features/landing/glyphs";
import { gsap, reducedMotion } from "@/features/landing/gsap";
import styles from "./loader.module.css";

const WORD = "NARYX";
const MIN_SECONDS = 1.7;
const CELL = 36;

/**
 * The loader: a yellow screen where the name decodes out of the glyph
 * alphabet, one letter at a time. Then the yellow breaks up into cells that
 * flash as glyphs and drop out, from the centre outwards, onto the page.
 */
export default function Loader() {
  const { ready, setReady } = useExperience();
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [slots, setSlots] = useState<(string | number)[]>(() => [...WORD].map((_, i) => i * 3));
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const reduced = reducedMotion();
    let cancelled = false;
    const started = performance.now();

    // Letters cycle through glyphs, then settle left to right.
    let frame = 0;
    const settleAt = [...WORD].map((_, i) => 9 + i * 3);
    const cycle = window.setInterval(() => {
      frame++;
      setSlots([...WORD].map((letter, i) => (frame >= settleAt[i] ? letter : (frame + i * 5) % GLYPHS.length)));
    }, 70);

    const assets = Promise.all([loadGlyphs(), document.fonts.ready]);

    assets.then(async ([glyphs]) => {
      const elapsed = (performance.now() - started) / 1000;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, MIN_SECONDS - elapsed) * 1000));
      window.clearInterval(cycle);
      setSlots([...WORD]);
      if (cancelled) return;

      if (reduced) {
        setReady();
        gsap.to(root.current, { opacity: 0, duration: 0.5, onComplete: () => setGone(true) });
        return;
      }

      // Swap the flat yellow for a canvas of yellow cells and dissolve them.
      const cvs = canvas.current;
      if (!cvs) return;
      const dpr = Math.min(devicePixelRatio, 2);
      const [w, h] = [innerWidth, innerHeight];
      cvs.width = w * dpr;
      cvs.height = h * dpr;
      const ctx = cvs.getContext("2d")!;
      const atlas = buildAtlas(glyphs, ["#ffff00"], CELL * dpr);
      const size = CELL * dpr;
      const columns = Math.ceil(w / CELL);
      const rows = Math.ceil(h / CELL);
      const far = Math.hypot(w / 2, h / 2);
      const cells = Array.from({ length: columns * rows }, (_, i) => {
        const [x, y] = [(i % columns) * CELL, Math.floor(i / columns) * CELL];
        const distance = Math.hypot(x + CELL / 2 - w / 2, y + CELL / 2 - h / 2) / far;
        return { x, y, out: 0.15 + distance * 0.55 + Math.random() * 0.25, glyph: Math.floor(Math.random() * GLYPHS.length) };
      });
      root.current!.dataset.dissolving = "";
      setReady();

      const clock = { t: 0 };
      gsap.to(clock, {
        t: 1.05,
        duration: 1.3,
        ease: "none",
        onUpdate: () => {
          ctx.clearRect(0, 0, cvs.width, cvs.height);
          for (const cell of cells) {
            const left = cell.out - clock.t;
            if (left <= 0) continue;
            // The last moment of each cell: a yellow glyph, then nothing.
            const column = left < 0.07 ? cell.glyph : BLOCK;
            ctx.drawImage(atlas, column * size, 0, size, size, cell.x * dpr, cell.y * dpr, size + 1, size + 1);
          }
        },
        onComplete: () => setGone(true),
      });
      gsap.to(`.${styles.word}`, { opacity: 0, duration: 0.25 });
    });

    return () => {
      cancelled = true;
      window.clearInterval(cycle);
    };
  }, [setReady]);

  if (gone) return null;

  return (
    <div ref={root} className={styles.loader} aria-hidden={ready} role="status">
      <canvas ref={canvas} className={styles.canvas} />
      <p className={styles.word} aria-label="Naryx, loading">
        {slots.map((slot, index) => (
          <span key={index} className={styles.slot}>
            {typeof slot === "number" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={glyphSrc(GLYPHS[slot])} alt="" />
            ) : (
              slot
            )}
          </span>
        ))}
      </p>
    </div>
  );
}
