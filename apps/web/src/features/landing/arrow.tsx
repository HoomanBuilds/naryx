/** An inline arrow drawn as a graphic, sized and coloured like the text around it. */
export default function Arrow({ direction = "right" }: { direction?: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ display: "inline-block", width: "1em", height: "1em", verticalAlign: "-0.125em" }}
    >
      <path
        d={direction === "right" ? "M2 8h11M9 4l4 4-4 4" : "M14 8H3M7 4 3 8l4 4"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}
