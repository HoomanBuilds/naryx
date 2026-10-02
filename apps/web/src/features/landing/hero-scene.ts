import { random } from "@/features/landing/glyph-field";

/**
 * The hero's source picture, painted in code: a valley at first light in the
 * Naryx palette, with a river running out of the sun between two ranges. The
 * glyph field samples it once per cell, so only its broad shapes, hues and
 * brightness matter. Seeded, so it is the same picture on every visit.
 */
const W = 480;
const H = 360;

type Stops = [number, string][];

function linear(ctx: CanvasRenderingContext2D, y0: number, y1: number, stops: Stops) {
  const gradient = ctx.createLinearGradient(0, y0, 0, y1);
  stops.forEach(([at, color]) => gradient.addColorStop(at, color));
  return gradient;
}

function radial(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, stops: Stops) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
  stops.forEach(([at, color]) => gradient.addColorStop(at, color));
  return gradient;
}

/** A skyline from a sum of waves plus seeded jitter: [frequency, amplitude, phase] in picture units. */
function profile(rand: () => number, base: number, waves: [number, number, number][], jitter: number) {
  const points: [number, number][] = [];
  for (let x = -8; x <= W + 8; x += 4) {
    let y = base;
    for (const [frequency, amplitude, phase] of waves) y += Math.sin((x / W) * Math.PI * 2 * frequency + phase) * amplitude;
    points.push([x, y + (rand() - 0.5) * jitter]);
  }
  return points;
}

/** Fills everything below a skyline, with an optional bright rim along it. */
function fillBelow(ctx: CanvasRenderingContext2D, points: [number, number][], fill: CanvasGradient | string, rim?: string) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], H + 4);
  points.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(points[points.length - 1][0], H + 4);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (!rim) return;
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = rim;
  ctx.lineWidth = 3;
  ctx.stroke();
}

/** A soft horizontal streak of light: a radial glow squashed into a band. */
function streak(ctx: CanvasRenderingContext2D, x: number, y: number, length: number, height: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(length / height, 1);
  ctx.fillStyle = radial(ctx, 0, 0, height, [
    [0, color],
    [1, "rgba(255, 255, 255, 0)"],
  ]);
  ctx.fillRect(-height, -height, height * 2, height * 2);
  ctx.restore();
}

export function paintHeroScene() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const rand = random(19);
  const sun = { x: W * 0.63, y: H * 0.44 };

  // Sky: blue overhead, through violet and magenta, to a yellow horizon.
  ctx.fillStyle = linear(ctx, 0, H * 0.58, [
    [0, "#0f22c8"],
    [0.35, "#5a22e0"],
    [0.62, "#e83fd8"],
    [0.86, "#ffd84a"],
    [1, "#ffff3a"],
  ]);
  ctx.fillRect(0, 0, W, H);

  // Rays fanning out of the sun, then its glow, then a few stars in the dark part of the sky.
  for (let k = 0; k < 18; k++) {
    const a0 = (k / 18) * Math.PI * 2 + 0.1;
    const a1 = a0 + Math.PI / 30;
    ctx.beginPath();
    ctx.moveTo(sun.x, sun.y);
    ctx.lineTo(sun.x + Math.cos(a0) * W, sun.y + Math.sin(a0) * W);
    ctx.lineTo(sun.x + Math.cos(a1) * W, sun.y + Math.sin(a1) * W);
    ctx.closePath();
    ctx.fillStyle = k % 2 ? "rgba(255, 250, 160, 0.22)" : "rgba(255, 120, 240, 0.16)";
    ctx.fill();
  }
  ctx.fillStyle = radial(ctx, sun.x, sun.y, W * 0.34, [
    [0, "rgba(255, 255, 120, 1)"],
    [0.4, "rgba(255, 245, 60, 0.8)"],
    [1, "rgba(255, 230, 40, 0)"],
  ]);
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#f8f8ff";
  for (let k = 0; k < 70; k++) {
    const [x, y] = [rand() * W, rand() * H * 0.24];
    if (Math.hypot(x - sun.x, y - sun.y) < W * 0.3) continue;
    ctx.fillRect(x, y, 2 + rand() * 2.5, 2 + rand() * 2.5);
  }

  // Long clouds, white where they catch the light.
  streak(ctx, W * 0.2, H * 0.12, 150, 9, "rgba(248, 248, 255, 0.95)");
  streak(ctx, W * 0.36, H * 0.2, 120, 6, "rgba(248, 248, 255, 0.85)");
  streak(ctx, W * 0.82, H * 0.16, 110, 8, "rgba(248, 248, 255, 0.9)");
  streak(ctx, W * 0.5, H * 0.3, 160, 5, "rgba(255, 255, 230, 0.8)");
  streak(ctx, W * 0.9, H * 0.33, 90, 5, "rgba(255, 255, 230, 0.75)");

  // The sun itself: a near-white disc.
  ctx.fillStyle = radial(ctx, sun.x, sun.y, 30, [
    [0, "#ffffff"],
    [0.75, "#fffff2"],
    [1, "rgba(255, 255, 200, 0)"],
  ]);
  ctx.beginPath();
  ctx.arc(sun.x, sun.y, 30, 0, Math.PI * 2);
  ctx.fill();

  // Far range, violet, with a pale rim.
  fillBelow(
    ctx,
    profile(rand, H * 0.52, [[2.3, 14, 0.6], [5.1, 7, 2.1], [11, 3, 0.4]], 3),
    linear(ctx, H * 0.38, H * 0.7, [
      [0, "#c06bff"],
      [1, "#5a1fd0"],
    ]),
    "rgba(248, 248, 255, 0.55)",
  );

  // Valley floor: lit fields, in rows that darken with distance from the sun.
  fillBelow(
    ctx,
    profile(rand, H * 0.6, [[1.2, 5, 1.4], [4, 3, 0.2]], 2),
    linear(ctx, H * 0.56, H * 0.9, [
      [0, "#ffff40"],
      [0.6, "#e8d800"],
      [1, "#8f8a00"],
    ]),
  );
  for (let y = H * 0.63, k = 0; y < H; y += 7 + k * 1.6, k++) {
    ctx.fillStyle = k % 2 ? "rgba(255, 255, 210, 0.35)" : "rgba(60, 40, 0, 0.22)";
    ctx.fillRect(0, y, W, 3 + k * 0.8);
  }

  // Hills either side: magenta on the left, blue on the right, leaving the valley open under the sun.
  const left = profile(rand, H * 0.5, [[0.9, 26, 2.2], [3.3, 9, 0.8], [9, 3, 1.9]], 4).map(([x, y]): [number, number] => [
    x,
    y + Math.max(0, (x - W * 0.3) * 1.4),
  ]);
  fillBelow(
    ctx,
    left,
    linear(ctx, H * 0.28, H * 0.95, [
      [0, "#ff6ff0"],
      [0.5, "#e02cc4"],
      [1, "#5a0a52"],
    ]),
    "rgba(255, 230, 250, 0.7)",
  );
  // Round trees along the magenta hills, lighter and darker than the slope.
  for (let k = 0; k < 46; k++) {
    const [x, y] = left[Math.floor(rand() * left.length * 0.55)];
    const r = 4 + rand() * 7;
    ctx.fillStyle = rand() < 0.5 ? "#ffa6f6" : "#9a1fd8";
    ctx.beginPath();
    ctx.arc(x + (rand() - 0.5) * 10, y + 6 + rand() * 46, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const right = profile(rand, H * 0.42, [[1.1, 20, 4.1], [3.7, 8, 1.2], [8, 3, 2.6]], 4).map(([x, y]): [number, number] => [
    x,
    y + Math.max(0, (W * 0.8 - x) * 1.1),
  ]);
  fillBelow(
    ctx,
    right,
    linear(ctx, H * 0.3, H * 0.95, [
      [0, "#4d78ff"],
      [0.5, "#0048ff"],
      [1, "#0a1a80"],
    ]),
    "rgba(160, 255, 255, 0.85)",
  );
  // Pines on the blue hills.
  for (let k = 0; k < 40; k++) {
    const [x, y] = right[Math.floor(right.length * (0.62 + rand() * 0.38))];
    const [w, h] = [5 + rand() * 6, 12 + rand() * 18];
    const top = y + 4 + rand() * 50;
    ctx.fillStyle = rand() < 0.55 ? "#4fa8ff" : "#1a2fb0";
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x + w, top + h);
    ctx.lineTo(x - w, top + h);
    ctx.closePath();
    ctx.fill();
  }

  // The river, out of the sun's reflection and widening towards the viewer.
  ctx.beginPath();
  ctx.moveTo(sun.x - 6, H * 0.6);
  ctx.bezierCurveTo(W * 0.54, H * 0.7, W * 0.74, H * 0.78, W * 0.56, H * 0.88);
  ctx.bezierCurveTo(W * 0.44, H * 0.95, W * 0.36, H * 0.98, W * 0.3, H + 4);
  ctx.lineTo(W * 0.62, H + 4);
  ctx.bezierCurveTo(W * 0.68, H * 0.95, W * 0.88, H * 0.82, W * 0.72, H * 0.72);
  ctx.bezierCurveTo(W * 0.66, H * 0.67, sun.x + 4, H * 0.63, sun.x + 6, H * 0.6);
  ctx.closePath();
  ctx.fillStyle = linear(ctx, H * 0.6, H, [
    [0, "#f4ffff"],
    [0.2, "#5ff8ff"],
    [0.6, "#00e0f0"],
    [1, "#008fa0"],
  ]);
  ctx.fill();

  // Foreground banks, deep blue, rising at both sides and dipping out of sight where the river runs.
  const banks = profile(rand, H * 0.86, [[1, 10, 0.3], [3, 5, 1.7]], 3).map(([x, y]): [number, number] => {
    const u = x / W;
    return [x, y + 50 - Math.max(0, (0.42 - u) * 220, (u - 0.62) * 300)];
  });
  fillBelow(
    ctx,
    banks,
    linear(ctx, H * 0.6, H, [
      [0, "#2f5cff"],
      [0.45, "#0b2fd0"],
      [1, "#050b3a"],
    ]),
    "rgba(0, 255, 255, 0.8)",
  );

  // Broad, soft patches of shade over everything, so neighbouring cells pick different glyphs.
  const shade = document.createElement("canvas");
  shade.width = 20;
  shade.height = 15;
  const sctx = shade.getContext("2d")!;
  for (let y = 0; y < shade.height; y++) {
    for (let x = 0; x < shade.width; x++) {
      const v = Math.round(190 + rand() * 65);
      sctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
      sctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.globalCompositeOperation = "multiply";
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(shade, 0, 0, W, H);
  ctx.globalCompositeOperation = "source-over";

  // Fine grain, in blocks about a cell wide, like a dithered print.
  const image = ctx.getImageData(0, 0, W, H);
  const grain = Array.from({ length: Math.ceil(W / 3) * Math.ceil(H / 3) }, () => 0.7 + rand() * 0.42);
  for (let i = 0; i < W * H; i++) {
    const g = grain[Math.floor(Math.floor(i / W) / 3) * Math.ceil(W / 3) + Math.floor((i % W) / 3)];
    for (let c = 0; c < 3; c++) image.data[i * 4 + c] = Math.min(255, image.data[i * 4 + c] * g);
  }
  ctx.putImageData(image, 0, 0);

  return canvas;
}
