"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText, ScrambleTextPlugin, MotionPathPlugin);

export { gsap, ScrollTrigger, SplitText, useGSAP };

/** Characters used when text decodes into place. */
export const SCRAMBLE = "▖▘▝▗▚▞▙▟█░▒";

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
