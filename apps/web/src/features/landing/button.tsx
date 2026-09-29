import type { ReactNode } from "react";
import styles from "./button.module.css";

type Variant = "yellow" | "ink" | "outline";

/** Small caps on a solid, rounded chip that turns cyan on hover. */
export default function Button({
  href,
  variant = "yellow",
  arrow = false,
  children,
  className = "",
}: {
  href: string;
  variant?: Variant;
  arrow?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const external = href.startsWith("http");
  return (
    <a
      href={href}
      className={`${styles.button} ${styles[variant]} ${className}`}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      <span>{children}</span>
      {arrow && (
        <svg className={styles.arrow} viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 9 9 3M4 3h5v5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )}
    </a>
  );
}
