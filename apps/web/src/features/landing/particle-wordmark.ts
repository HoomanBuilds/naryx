/**
 * The footer's wordmark: a word that reads as crisp
 * type on the left and breaks into ever coarser pixels towards the right,
 * drawn as a field of square particles that scatter from the pointer and
 * spring back. It flies together from scattered points the first time it
 * comes into view.
 */
type Options = { canvas: HTMLCanvasElement; text: string; family: string; color: string };

export class ParticleWordmark {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private text: string;
  private family: string;
  private color: string;

  private dpr = 1;
  private width = 0;
  private height = 0;
  private step = 4;
  private homeX = new Float32Array(0);
  private homeY = new Float32Array(0);
  private x = new Float32Array(0);
  private y = new Float32Array(0);
  private vx = new Float32Array(0);
  private vy = new Float32Array(0);
  private count = 0;
  private pointer = { x: -9999, y: -9999, active: false };
  private settled = false;

  constructor({ canvas, text, family, color }: Options) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.text = text;
    this.family = family;
    this.color = color;
    this.layout();
  }

  layout() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.step = this.width < 700 ? 3 : 4;

    // 1. The word, as large as fits.
    const [w, h] = [Math.round(this.width), Math.round(this.height)];
    const source = document.createElement("canvas");
    source.width = w;
    source.height = h;
    const sctx = source.getContext("2d", { willReadFrequently: true })!;
    let size = h;
    sctx.font = `italic 400 ${size}px ${this.family}`;
    size *= Math.min(1, (w * 0.96) / sctx.measureText(this.text).width);
    sctx.font = `italic 400 ${size}px ${this.family}`;
    sctx.textBaseline = "middle";
    sctx.textAlign = "center";
    sctx.fillStyle = "#fff";
    sctx.fillText(this.text, w / 2, h * 0.52);
    const alpha = sctx.getImageData(0, 0, w, h).data;

    // 2. Pixelate progressively: blocks grow from one step at 30% of the width to 9 steps at the far right.
    const inked = (px: number, py: number) => alpha[(py * w + px) * 4 + 3] > 110;
    const points: number[] = [];
    const step = this.step;
    for (let gx = 0; gx < w; gx += step) {
      const t = Math.max(0, (gx - w * 0.3) / (w * 0.7));
      const block = step * Math.max(1, Math.round(1 + t ** 1.15 * (w < 700 ? 4 : 8)));
      const bx = Math.floor(gx / block) * block;
      for (let gy = 0; gy < h; gy += step) {
        const by = Math.floor(gy / block) * block;
        let on: boolean;
        if (block === step) on = inked(gx, gy);
        else {
          // A block is inked when enough of it is.
          let hits = 0;
          let total = 0;
          for (let sx = bx; sx < Math.min(w, bx + block); sx += step) {
            for (let sy = by; sy < Math.min(h, by + block); sy += step) {
              total++;
              if (inked(sx, sy)) hits++;
            }
          }
          on = hits / total > 0.42;
        }
        if (on) points.push(gx, gy);
      }
    }

    this.count = points.length / 2;
    this.homeX = new Float32Array(this.count);
    this.homeY = new Float32Array(this.count);
    this.x = new Float32Array(this.count);
    this.y = new Float32Array(this.count);
    this.vx = new Float32Array(this.count);
    this.vy = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      this.homeX[i] = this.x[i] = points[i * 2];
      this.homeY[i] = this.y[i] = points[i * 2 + 1];
    }
    this.settled = false;
  }

  /** Scatters every particle, to fly home over the next frames. */
  scatter() {
    for (let i = 0; i < this.count; i++) {
      this.x[i] = Math.random() * this.width;
      this.y[i] = this.height * (0.2 + Math.random() * 1.6);
      this.vx[i] = this.vy[i] = 0;
    }
    this.settled = false;
  }

  setPointer(x: number, y: number, active: boolean) {
    this.pointer = { x, y, active };
    this.settled = false;
  }

  /** One frame of physics and drawing. Returns false once everything is at rest. */
  frame() {
    if (this.settled) return false;
    const { x: px, y: py, active } = this.pointer;
    const radius = 130;
    let energy = 0;
    for (let i = 0; i < this.count; i++) {
      let vx = this.vx[i] + (this.homeX[i] - this.x[i]) * 0.045;
      let vy = this.vy[i] + (this.homeY[i] - this.y[i]) * 0.045;
      if (active) {
        const dx = this.x[i] - px;
        const dy = this.y[i] - py;
        const d2 = dx * dx + dy * dy;
        if (d2 < radius * radius && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const push = (1 - d / radius) ** 2 * 7;
          vx += (dx / d) * push;
          vy += (dy / d) * push;
        }
      }
      vx *= 0.8;
      vy *= 0.8;
      this.x[i] += vx;
      this.y[i] += vy;
      this.vx[i] = vx;
      this.vy[i] = vy;
      energy += Math.abs(vx) + Math.abs(vy) + Math.abs(this.homeX[i] - this.x[i]) * 0.02;
    }
    this.draw();
    if (!active && energy / Math.max(1, this.count) < 0.004) {
      for (let i = 0; i < this.count; i++) {
        this.x[i] = this.homeX[i];
        this.y[i] = this.homeY[i];
      }
      this.draw();
      this.settled = true;
    }
    return true;
  }

  draw() {
    const { ctx, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.color;
    const size = this.step - 1;
    for (let i = 0; i < this.count; i++) ctx.fillRect(this.x[i], this.y[i], size, size);
  }
}
