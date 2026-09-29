"use client";

import { useRef } from "react";
import { gsap, useGSAP } from "@/features/landing/gsap";
import styles from "./cursor.module.css";

/** A pixel cursor: a small square that opens into a frame over anything clickable. */
export default function Cursor() {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    const media = gsap.matchMedia();
    media.add("(hover: hover) and (pointer: fine)", () => {
      const cursor = root.current!;
      const x = gsap.quickTo(cursor, "x", { duration: 0.25, ease: "power3.out" });
      const y = gsap.quickTo(cursor, "y", { duration: 0.25, ease: "power3.out" });
      const move = (event: PointerEvent) => {
        x(event.clientX);
        y(event.clientY);
        cursor.dataset.visible = "";
      };
      const over = (event: PointerEvent) => {
        cursor.toggleAttribute("data-link", !!(event.target as Element).closest("a, button, input, [role=slider]"));
      };
      const leave = () => delete cursor.dataset.visible;
      window.addEventListener("pointermove", move);
      document.addEventListener("pointerover", over);
      document.documentElement.addEventListener("pointerleave", leave);
      return () => {
        window.removeEventListener("pointermove", move);
        document.removeEventListener("pointerover", over);
        document.documentElement.removeEventListener("pointerleave", leave);
      };
    });
    return () => media.revert();
  });

  return <div ref={root} className={styles.cursor} aria-hidden="true" />;
}
