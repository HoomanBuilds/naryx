import { BLOCK, buildAtlas, GLYPHS } from "@/features/landing/glyphs";

/**
 * The hero's canvas. A painted scene (see hero-scene.ts) is re-drawn as a
 * mosaic of glyphs: one glyph per cell, its colour snapped to the Naryx
 * palette and its shape and size chosen by the scene's brightness. It reacts to the
 * pointer like the footer particles (pushed away, springing back), and
 * as the page scrolls its cells sort themselves into an order book's depth
 * chart: bids on the left, asks on the right, meeting at the midpoint.
 */

/** Atlas rows. */
const PALETTE = ["#ffff00", "#00ffff", "#0048ff", "#9a0dff", "#ff4fe9", "#f8f8ff", "#2e2e2e"];
const [YELLOW, CYAN, BLUE, VIOLET, PINK, GLINT, DIM] = PALETTE.keys();

const BID = YELLOW;
const ASK = CYAN;

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** A small deterministic random, so the mosaic is the same on every visit. */
export function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The palette row for a sampled colour, by hue, saturation and value. */
function paletteFor(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const value = max / 255;
  const saturation = max === 0 ? 0 : (max - min) / max;
  if (value < 0.2) return { row: DIM, value };
  if (saturation < 0.22) return { row: value > 0.62 ? GLINT : DIM, value };
  let hue = 0;
  const d = max - min;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 18 || hue >= 320) return { row: PINK, value };
  if (hue < 95) return { row: YELLOW, value };
  if (hue < 190) return { row: CYAN, value };
  if (hue < 250) return { row: BLUE, value };
  if (hue < 285) return { row: VIOLET, value };
  return { row: PINK, value };
}

type Options = {
  canvas: HTMLCanvasElement;
  glyphs: HTMLImageElement[];
  source: HTMLCanvasElement;
  /** Horizontal focus of the scene when it is cropped to the canvas (0 to 1). */
  focusX?: number;
};

export class GlyphField {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private glyphs: HTMLImageElement[];
  private source: HTMLCanvasElement;
  private focusX: number;

  private dpr = 1;
  private width = 0;
  private height = 0;
  private cell = 16;
  private atlas: HTMLCanvasElement | null = null;
  private sprite = 0;

  // Per cell, in typed arrays: home position, look, motion and sorting.
  private count = 0;
  private homeX = new Float32Array(0);
  private homeY = new Float32Array(0);
  private row = new Uint8Array(0);
  private glyph = new Uint8Array(0);
  private size = new Float32Array(0);
  private offsetX = new Float32Array(0);
  private offsetY = new Float32Array(0);
  private velocityX = new Float32Array(0);
  private velocityY = new Float32Array(0);
  private appear = new Float32Array(0);
  private targetX = new Float32Array(0);
  private targetY = new Float32Array(0);
  private side = new Uint8Array(0); // 0 fades out, 1 bid, 2 ask
  private delay = new Float32Array(0);
  private arc = new Float32Array(0);
  /** Twinkling: the glyph a cell briefly shows, and for how many more redraws. */
  private flickerGlyph = new Uint8Array(0);
  private flickerLeft = new Uint8Array(0);
  private order: Uint32Array = new Uint32Array(0);

  /** 0 to 1: how far the intro decode has run. */
  intro = 0;
  /** 0 to 1: how far the cells have sorted into the depth chart. */
  sort = 0;
  private pointer = { x: 0, y: 0, active: false, radius: 150 };
  private settling = false;
  private dirty = true;

  /** The chart's geometry in CSS pixels, for overlays that line up with it. */
  chart = { midX: 0, baseY: 0, topY: 0, left: 0, right: 0 };

  constructor({ canvas, glyphs, source, focusX = 0.5 }: Options) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.glyphs = glyphs;
    this.source = source;
    this.focusX = focusX;
    this.layout();
  }

  /** Rebuilds the mosaic for the canvas's current size. */
  layout() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.cell = this.width < 700 ? 11 : this.width < 1200 ? 14 : 16;
    this.sprite = Math.ceil(this.cell * this.dpr);
    this.atlas = buildAtlas(this.glyphs, PALETTE, this.sprite);

    const cell = this.cell;
    const columns = Math.ceil(this.width / cell);
    const rows = Math.ceil(this.height / cell);
    const count = columns * rows;
    this.count = count;
    const floats = () => new Float32Array(count);
    this.homeX = floats();
    this.homeY = floats();
    this.size = floats();
    this.offsetX = floats();
    this.offsetY = floats();
    this.velocityX = floats();
    this.velocityY = floats();
    this.appear = floats();
    this.targetX = floats();
    this.targetY = floats();
    this.delay = floats();
    this.arc = floats();
    this.row = new Uint8Array(count);
    this.glyph = new Uint8Array(count);
    this.side = new Uint8Array(count);
    this.flickerGlyph = new Uint8Array(count);
    this.flickerLeft = new Uint8Array(count);

    // Sample the scene once, one pixel per cell, cropped to cover the canvas.
    const sample = document.createElement("canvas");
    sample.width = columns;
    sample.height = rows;
    const sctx = sample.getContext("2d", { willReadFrequently: true })!;
    const { width: iw, height: ih } = this.source;
    const scale = Math.max(columns / iw, rows / ih);
    const [dw, dh] = [iw * scale, ih * scale];
    sctx.drawImage(this.source, (columns - dw) * this.focusX, (rows - dh) / 2, dw, dh);
    const pixels = sctx.getImageData(0, 0, columns, rows).data;

    const rand = random(7);
    const far = Math.hypot(this.width / 2, this.height / 2);
    for (let i = 0; i < count; i++) {
      const [c, r] = [i % columns, Math.floor(i / columns)];
      const x = c * cell + cell / 2;
      const y = r * cell + cell / 2;
      this.homeX[i] = x;
      this.homeY[i] = y;
      const { row, value } = paletteFor(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]);
      this.row[i] = row;
      const density = clamp(value * 1.15 - 0.1 + (rand() - 0.5) * 0.25);
      this.glyph[i] = Math.round(density * (GLYPHS.length - 1));
      this.size[i] = cell * (row === DIM ? 0.3 + 0.16 * value : 0.38 + 0.42 * clamp(value));
      this.appear[i] = (Math.hypot(x - this.width / 2, y - this.height / 2) / far) * 0.7 + rand() * 0.3;
    }

    this.planChart(columns, rows, rand);
    this.dirty = true;
  }

  /** Lays out the depth chart and picks which cells travel into it. */
  private planChart(columns: number, rows: number, rand: () => number) {
    const cell = this.cell;
    const narrow = this.width < 700;
    const midColumn = Math.floor(columns / 2);
    const midX = midColumn * cell + cell / 2;
    const baseRow = Math.floor(rows * (narrow ? 0.72 : 0.8));
    const maxRows = Math.floor(rows * (narrow ? 0.34 : 0.44));
    const depthColumns = Math.floor(columns * 0.46) - 1;

    // Cumulative depth: rises away from the midpoint, with a little texture.
    const heights = (seed: number) => {
      const r = random(seed);
      let height = 1;
      return Array.from({ length: depthColumns }, (_, k) => {
        const shape = maxRows * ((k + 1) / depthColumns) ** 1.35;
        height = Math.max(height, Math.round(shape * (0.8 + r() * 0.35)));
        return Math.min(maxRows, height);
      });
    };
    const slots = (direction: -1 | 1, seed: number) =>
      heights(seed).flatMap((height, k) =>
        Array.from({ length: height }, (_, level) => ({
          x: midX + direction * (k + 1) * cell,
          y: (baseRow - level) * cell + cell / 2,
          k,
        })),
      );
    const bids = slots(-1, 11);
    const asks = slots(1, 23);

    // Candidates: visible cells from each half, in a shuffled order.
    const shuffle = <T>(list: T[]) => {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    };
    const candidates = (left: boolean) =>
      shuffle(
        Array.from({ length: this.count }, (_, i) => i).filter(
          (i) => this.row[i] !== DIM && (this.homeX[i] < midX) === left,
        ),
      );
    const assign = (list: { x: number; y: number; k: number }[], pool: number[], side: 1 | 2) => {
      list.forEach((slot, index) => {
        const i = pool[index % pool.length];
        this.side[i] = side;
        this.targetX[i] = slot.x;
        this.targetY[i] = slot.y;
        // Cells nearest the midpoint arrive first.
        this.delay[i] = 0.04 + (slot.k / depthColumns) * 0.22 + rand() * 0.14;
        this.arc[i] = (rand() - 0.5) * cell * 14;
      });
    };
    this.side.fill(0);
    assign(bids, candidates(true), 1);
    assign(asks, candidates(false), 2);

    // Travelling cells draw last, on top of the ones fading away.
    const sorted = Array.from({ length: this.count }, (_, i) => i).sort((a, b) => this.side[a] - this.side[b]);
    this.order = Uint32Array.from(sorted);

    const topRow = baseRow - maxRows;
    this.chart = {
      midX,
      baseY: baseRow * cell + cell,
      topY: topRow * cell,
      left: midX - depthColumns * cell - cell / 2,
      right: midX + depthColumns * cell + cell / 2,
    };
  }

  setPointer(x: number, y: number, active: boolean) {
    this.pointer.x = x;
    this.pointer.y = y;
    this.pointer.active = active;
    if (active) this.settling = true;
  }

  /** Makes a few cells briefly show another glyph, like prices ticking. */
  twinkle(amount = 0.004) {
    const n = Math.ceil(this.count * amount);
    for (let k = 0; k < n; k++) {
      const i = Math.floor(Math.random() * this.count);
      if (this.row[i] === DIM) continue;
      this.flickerGlyph[i] = Math.floor(Math.random() * GLYPHS.length);
      this.flickerLeft[i] = 3;
    }
    this.dirty = true;
  }

  invalidate() {
    this.dirty = true;
  }

  /** Advances the physics and redraws when something changed. Returns whether it drew. */
  frame() {
    const moving = this.step();
    if (!moving && !this.dirty) return false;
    this.draw();
    this.dirty = false;
    return true;
  }

  /** Spring physics for the pointer push. Returns whether anything is still moving. */
  private step() {
    if (!this.settling) return false;
    const { x: px, y: py, active, radius } = this.pointer;
    const r2 = radius * radius;
    let energy = 0;
    const blend = this.sort;
    for (let i = 0; i < this.count; i++) {
      let ox = this.offsetX[i];
      let oy = this.offsetY[i];
      let vx = this.velocityX[i];
      let vy = this.velocityY[i];
      if (active) {
        const t = this.side[i] ? easeInOut(clamp((blend - this.delay[i]) / 0.5)) : 0;
        const x = this.homeX[i] + (this.targetX[i] - this.homeX[i]) * t + ox;
        const y = this.homeY[i] + (this.targetY[i] - this.homeY[i]) * t + oy;
        const dx = x - px;
        const dy = y - py;
        const d2 = dx * dx + dy * dy;
        if (d2 < r2 && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const push = (1 - d / radius) ** 2 * 2.6;
          vx += (dx / d) * push;
          vy += (dy / d) * push;
        }
      }
      if (ox === 0 && oy === 0 && vx === 0 && vy === 0) continue;
      vx = (vx - ox * 0.06) * 0.82;
      vy = (vy - oy * 0.06) * 0.82;
      ox += vx;
      oy += vy;
      if (Math.abs(ox) < 0.05 && Math.abs(oy) < 0.05 && Math.abs(vx) < 0.05 && Math.abs(vy) < 0.05) {
        ox = oy = vx = vy = 0;
      }
      this.offsetX[i] = ox;
      this.offsetY[i] = oy;
      this.velocityX[i] = vx;
      this.velocityY[i] = vy;
      energy += Math.abs(vx) + Math.abs(vy);
    }
    if (!active && energy === 0) this.settling = false;
    return energy > 0 || active;
  }

  private draw() {
    const { ctx, dpr, sprite, cell } = this;
    const atlas = this.atlas!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.intro <= 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const fade = easeInOut(clamp((this.sort - 0.02) / 0.5));
    const block = cell - 2;
    for (let n = 0; n < this.count; n++) {
      const i = this.order[n];
      // Intro: each cell decodes (a flicker of random glyphs) before settling.
      const reveal = (this.intro * 1.3 - this.appear[i]) / 0.18;
      if (reveal <= 0) continue;
      const decoding = reveal < 1;

      let row = this.row[i];
      let glyph = decoding ? (i + Math.floor(this.intro * 40)) % GLYPHS.length : this.glyph[i];
      let size = this.size[i];
      let alpha = 1;
      let x = this.homeX[i];
      let y = this.homeY[i];

      if (this.flickerLeft[i] && !decoding) {
        glyph = this.flickerGlyph[i];
        this.flickerLeft[i]--;
      }

      const side = this.side[i];
      if (side) {
        const t = easeInOut(clamp((this.sort - this.delay[i]) / 0.5));
        if (t > 0) {
          const arc = Math.sin(t * Math.PI) * this.arc[i];
          x += (this.targetX[i] - x) * t + arc;
          y += (this.targetY[i] - y) * t;
          if (t > 0.45) row = side === 1 ? BID : ASK;
          if (t > 0.8) glyph = BLOCK;
          size += (block - size) * t;
        }
      } else if (fade > 0) {
        alpha = 1 - fade * 0.88;
        size *= 1 - fade * 0.35;
        if (row !== DIM && fade > 0.6) row = DIM;
      }

      x += this.offsetX[i];
      y += this.offsetY[i];
      ctx.globalAlpha = decoding ? 0.9 : alpha;
      ctx.drawImage(atlas, glyph * sprite, row * sprite, sprite, sprite, x - size / 2, y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }
}
