import type { MetadataRoute } from "next";
import { siteUrl } from "./site-url";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  return ["/", "/trade", "/portfolio", "/activity", "/network"].map((path) => ({
    url: new URL(path, base).href,
    changeFrequency: path === "/" ? "weekly" : "daily",
    priority: path === "/" ? 1 : 0.6,
  }));
}
