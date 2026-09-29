"use client";

import Lenis from "lenis";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { gsap, reducedMotion, ScrollTrigger } from "@/features/landing/gsap";

type ExperienceValue = { ready: boolean; setReady: () => void };

const ExperienceContext = createContext<ExperienceValue>({ ready: true, setReady: () => {} });

/** `ready` turns true when the loader has handed the screen over to the page. */
export const useExperience = () => useContext(ExperienceContext);

let lenis: Lenis | undefined;
export const getLenis = () => lenis;

export default function Experience({ children }: { children: ReactNode }) {
  const [ready, setReadyState] = useState(false);
  const setReady = useCallback(() => setReadyState(true), []);
  const value = useMemo(() => ({ ready, setReady }), [ready, setReady]);

  // Lenis on GSAP's ticker, so ScrollTrigger and the smooth scroll share a clock.
  useEffect(() => {
    history.scrollRestoration = "manual";
    window.scrollTo(0, 0);
    const instance = new Lenis({ autoRaf: false, lerp: 0.11, anchors: true });
    lenis = instance;
    instance.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => instance.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    document.fonts.ready.then(() => ScrollTrigger.refresh());
    return () => {
      gsap.ticker.remove(tick);
      instance.destroy();
      lenis = undefined;
    };
  }, []);

  // The page holds still under the loader.
  useEffect(() => {
    document.documentElement.classList.toggle("is-loading", !ready);
    if (ready) {
      lenis?.start();
      ScrollTrigger.refresh();
    } else lenis?.stop();
  }, [ready]);

  // Lines marked data-reveal rise into place as they enter.
  useEffect(() => {
    if (reducedMotion()) return;
    const triggers = ScrollTrigger.batch("[data-reveal]", {
      start: "top 88%",
      once: true,
      onEnter: (elements) => {
        elements.forEach((element) => ((element as HTMLElement).dataset.revealed = ""));
        gsap.fromTo(
          elements,
          { opacity: 0, y: 24 },
          { opacity: 1, y: 0, duration: 1.1, ease: "expo.out", stagger: 0.07, clearProps: "opacity,transform" },
        );
      },
    });
    return () => triggers.forEach((trigger) => trigger.kill());
  }, []);

  return <ExperienceContext.Provider value={value}>{children}</ExperienceContext.Provider>;
}
