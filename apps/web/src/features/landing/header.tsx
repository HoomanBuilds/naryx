"use client";

import { useEffect, useRef, useState } from "react";
import { useExperience } from "@/features/landing/experience";
import { GLYPHS, glyphSrc } from "@/features/landing/glyphs";
import { gsap, ScrollTrigger, useGSAP } from "@/features/landing/gsap";
import styles from "./header.module.css";

const LINKS = [
  { label: "Engine", href: "#engine" },
  { label: "Settlement", href: "#shielded" },
  { label: "Use", href: "#use" },
  { label: "Lifecycle", href: "#roadmap" },
];
const TICKER = [
  "Cash-and-carry in one package",
  "Solvers quote the whole outcome",
  "One receipt for every leg",
  "Pre-mainnet: public deployment deferred",
];
const WORD = "NARYX";

/** The wordmark, which re-scrambles through the glyph alphabet on hover. */
function Wordmark() {
  const [slots, setSlots] = useState<(string | number)[]>([...WORD]);
  const timer = useRef<number | undefined>(undefined);
  const scramble = () => {
    window.clearInterval(timer.current);
    let frame = 0;
    timer.current = window.setInterval(() => {
      frame++;
      setSlots([...WORD].map((letter, i) => (frame > 3 + i * 2 ? letter : (frame * 3 + i * 5) % GLYPHS.length)));
      if (frame > 3 + WORD.length * 2) window.clearInterval(timer.current);
    }, 55);
  };
  useEffect(() => () => window.clearInterval(timer.current), []);
  return (
    <span className={styles.word} onPointerEnter={scramble} aria-hidden="true">
      {slots.map((slot, i) => (
        <span key={i} className={styles.slot}>
          {typeof slot === "number" ? (
            <i style={{ WebkitMaskImage: `url(${glyphSrc(GLYPHS[slot])})`, maskImage: `url(${glyphSrc(GLYPHS[slot])})` }} />
          ) : (
            slot
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * The header: a ticker along the top, the spaced wordmark, caps
 * links with a caret, and a solid button. It tucks away while you scroll down,
 * comes back when you scroll up, and takes the colours of the section below it.
 */
export default function Header() {
  const { ready } = useExperience();
  const root = useRef<HTMLElement>(null);
  const [tone, setTone] = useState("dark");
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(false);

  useGSAP(() => {
    for (const section of document.querySelectorAll<HTMLElement>("[data-theme]")) {
      ScrollTrigger.create({
        trigger: section,
        start: "top 40px",
        end: "bottom 40px",
        onToggle: (self) => self.isActive && setTone(section.dataset.theme!),
      });
    }
    ScrollTrigger.create({
      start: 0,
      end: "max",
      onUpdate: (self) => setHidden(self.direction === 1 && self.scroll() > 240),
    });
  });

  useGSAP(
    () => {
      if (!ready) return;
      gsap.from(root.current!.children, { yPercent: -100, opacity: 0, duration: 1.1, ease: "expo.out", stagger: 0.08, delay: 0.6 });
    },
    { dependencies: [ready], scope: root },
  );

  useEffect(() => {
    document.documentElement.classList.toggle("menu-open", open);
  }, [open]);

  return (
    <header
      ref={root}
      className={styles.header}
      data-tone={tone}
      data-hidden={(hidden && !open) || undefined}
      data-waiting={!ready || undefined}
    >
      <a className={`mono ${styles.ticker}`} href="#roadmap">
        <span className={styles.tickerTrack}>
          {[0, 1].map((copy) =>
            TICKER.map((item) => (
              <span key={`${copy}-${item}`} aria-hidden={copy > 0 || undefined}>
                {item}
              </span>
            )),
          )}
        </span>
      </a>

      <div className={`container ${styles.bar}`}>
        <a href="#top" className={styles.brand} aria-label="Naryx, back to top">
          <span className={styles.mark} aria-hidden="true" />
          <Wordmark />
        </a>

        <nav className={styles.nav} aria-label="Main">
          {LINKS.map(({ label, href }) => (
            <a key={label} href={href}>
              {label}
              <i className={styles.caret} aria-hidden="true">
                <span />
                <span />
              </i>
            </a>
          ))}
        </nav>

        <a className={styles.cta} href="#use">
          Get started
        </a>

        <button
          type="button"
          className={styles.menuButton}
          aria-expanded={open}
          aria-controls="menu"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((value) => !value)}
        >
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} />
          ))}
        </button>
      </div>

      <nav id="menu" className={styles.menu} data-open={open || undefined} aria-label="Menu" inert={!open}>
        {LINKS.map(({ label, href }, i) => (
          <a key={label} href={href} onClick={() => setOpen(false)}>
            <span className="mono">0{i + 1}</span>
            {label}
          </a>
        ))}
      </nav>
    </header>
  );
}
