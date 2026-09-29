/**
 * The glyph alphabet, ordered from the
 * sparsest shape to the densest by how much of their square they fill.
 */
export const GLYPHS = ["09", "11", "01", "07", "05", "12", "08", "13", "03", "02", "16", "10", "06", "04"] as const;
export type GlyphId = (typeof GLYPHS)[number];

export const glyphSrc = (id: GlyphId) => `/landing/glyphs/glyph-${id}.png`;

/** Index of the extra solid square appended to every atlas row. */
export const BLOCK = GLYPHS.length;

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });

export const loadGlyphs = () => Promise.all(GLYPHS.map((id) => loadImage(glyphSrc(id))));
export { loadImage };

/**
 * Pre-tinted glyph sprites: one row per colour, one column per glyph (plus a
 * solid block), each `size` device pixels square. Drawing from this is far
 * cheaper than tinting thousands of glyphs every frame.
 */
export function buildAtlas(images: HTMLImageElement[], colors: string[], size: number) {
  const atlas = document.createElement("canvas");
  atlas.width = size * (images.length + 1);
  atlas.height = size * colors.length;
  const ctx = atlas.getContext("2d")!;
  const cell = document.createElement("canvas");
  cell.width = cell.height = size;
  const cellCtx = cell.getContext("2d")!;
  colors.forEach((color, row) => {
    images.forEach((image, column) => {
      cellCtx.globalCompositeOperation = "source-over";
      cellCtx.clearRect(0, 0, size, size);
      // Fit the glyph inside its square, keeping its proportions.
      const scale = Math.min(size / image.width, size / image.height);
      const [w, h] = [image.width * scale, image.height * scale];
      cellCtx.drawImage(image, (size - w) / 2, (size - h) / 2, w, h);
      cellCtx.globalCompositeOperation = "source-in";
      cellCtx.fillStyle = color;
      cellCtx.fillRect(0, 0, size, size);
      ctx.drawImage(cell, column * size, row * size);
    });
    ctx.fillStyle = color;
    ctx.fillRect(images.length * size, row * size, size, size);
  });
  return atlas;
}
