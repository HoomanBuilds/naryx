"use client";

import { useRef, useState, type FormEvent } from "react";
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
  X: "https://x.com/NaryxNetwork",
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
 * ornaments, the waitlist tag and link columns in the mono face, and a
 * particle wordmark that breaks into pixels and scatters from the pointer.
 */
export default function Footer() {
  const root = useRef<HTMLElement>(null);
  const submitting = useRef(false);
  const [state, setState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

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

  const subscribe = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current || state === "success") return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const api = process.env.NEXT_PUBLIC_NARYX_PUBLIC_API_BASE_URL;
    if (!api) {
      setState("error");
      setMessage("The waitlist is temporarily unavailable. Please try again shortly.");
      return;
    }
    submitting.current = true;
    setState("pending");
    setMessage("");
    try {
      const response = await fetch(`${api.replace(/\/$/, "")}/v1/waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ email: data.get("email"), consent: true, website: data.get("website") }),
      });
      if (!response.ok) {
        setState("error");
        setMessage(response.status === 429 ? "Too many attempts. Please try again in 10 minutes."
          : response.status === 400 ? "Enter a valid email address and try again."
          : "We could not save your email. Please try again shortly.");
        return;
      }
      const result = await response.json() as { status?: string };
      if (result.status !== "joined") throw new Error("Unexpected waitlist response.");
      setState("success");
      setMessage("You're on the list. We'll email you when mainnet launches.");
      form.reset();
    } catch {
      setState("error");
      setMessage("We couldn't confirm your signup. Check your connection and try again.");
    } finally {
      submitting.current = false;
    }
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
          <form id="waitlist" className={styles.form} onSubmit={subscribe} aria-busy={state === "pending"}>
            <label htmlFor="waitlist-email" className={`${styles.title} ${styles.brand}`}>
              Mainnet waitlist
            </label>
            <p className={styles.intro}>Be first to know when Naryx goes live on mainnet.</p>
            <div className={styles.field}>
              <input id="waitlist-email" name="email" type="email" placeholder="Your email address" required maxLength={254}
                autoComplete="email" autoCapitalize="none" spellCheck={false}
                disabled={state === "pending" || state === "success"} aria-describedby="waitlist-consent waitlist-status" />
              <button type="submit" disabled={state === "pending" || state === "success"}>
                {state === "pending" ? "Joining..." : state === "success" ? "Joined" : "Join waitlist"}
              </button>
            </div>
            <div className={styles.honeypot} aria-hidden="true">
              <label htmlFor="waitlist-website">Leave this field empty</label>
              <input id="waitlist-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
            </div>
            <p id="waitlist-consent" className={styles.consent}>Join for early access to Naryx.</p>
            <p id="waitlist-status" className={styles.status} data-state={state} role="status" aria-live="polite">{message}</p>
          </form>
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
                      <a href={HREFS[link]}
                        {...(HREFS[link]?.startsWith("https://") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{link}</a>
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
          <span className={`${styles.glow} ${styles.unpublished}`} aria-disabled="true" title="Not yet published">
            Privacy policy &amp; legal terms
          </span>
          <span className={`${styles.glow} ${styles.unpublished}`} aria-disabled="true" title="Not yet published">
            Credits
          </span>
          <i className={styles.square} />
        </span>
      </div>
    </footer>
  );
}
