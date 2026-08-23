/**
 * Photographs for the places a walk passes.
 *
 * Wikimedia Commons indexes its images by coordinate, so a geosearch around a
 * viewpoint finds pictures actually taken there — no API key, no per-feature
 * tagging required, and it answers with `Access-Control-Allow-Origin: *` so the
 * browser can ask directly.
 *
 * Most Commons licences require attribution, so the author and licence come
 * back with the image and the UI is expected to show them.
 */
import { cached } from "./store";
import type { LatLon } from "./geo";

const ENDPOINT = "https://commons.wikimedia.org/w/api.php";
const MONTH = 30 * 24 * 60 * 60 * 1000;

export interface Photo {
  /** Thumbnail URL, already scaled — used for popups. */
  url: string;
  /**
   * Image for the chip row. Deliberately the same URL as `url`: rewriting the
   * width in a Commons thumbnail path (/500px- -> /96px-) looks like it should
   * work but upload.wikimedia.org will not generate arbitrary sizes on demand
   * and answers 400 for anything not already rendered. Sharing one URL also
   * means one download per stop rather than two.
   */
  icon: string;
  /** Commons file page, for attribution links. */
  page: string;
  title: string;
  author?: string;
  license?: string;
}

interface ApiPage {
  title?: string;
  index?: number;
  imageinfo?: Array<{
    thumburl?: string;
    url?: string;
    descriptionurl?: string;
    size?: number;
    extmetadata?: Record<string, { value?: string }>;
  }>;
}

/** Diagrams, maps and scans are geotagged too, and none of them are a view. */
const BAD_EXTENSION = /\.(svg|tif|tiff|pdf|djvu|ogv|webm|gif)$/i;
const BAD_TITLE = /\b(map|plan|diagram|logo|seal|coat of arms|chart|graph|sign|plaque)\b/i;

/** Largest original we are willing to show when no server thumbnail exists. */
const MAX_ORIGINAL_BYTES = 900_000;

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildUrl(p: LatLon, radiusM: number, width: number): string {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*", // required for anonymous CORS on the MediaWiki API
    generator: "geosearch",
    ggscoord: `${p.lat.toFixed(5)}|${p.lon.toFixed(5)}`,
    ggsradius: String(radiusM),
    ggslimit: "12",
    ggsnamespace: "6", // File:
    prop: "imageinfo",
    iiprop: "url|size|extmetadata",
    iiurlwidth: String(width),
  });
  return `${ENDPOINT}?${params}`;
}

async function search(p: LatLon, radiusM: number, width: number): Promise<Photo | null> {
  const res = await fetch(buildUrl(p, radiusM, width), {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Commons ${res.status}`);

  const json = (await res.json()) as { query?: { pages?: Record<string, ApiPage> } };
  const pages = Object.values(json.query?.pages ?? {});
  if (pages.length === 0) return null;

  // The geosearch generator numbers results by distance; keep that order.
  pages.sort((a, b) => (a.index ?? 999) - (b.index ?? 999));

  for (const page of pages) {
    const title = page.title ?? "";
    const info = page.imageinfo?.[0];
    if (BAD_EXTENSION.test(title) || BAD_TITLE.test(title)) continue;

    // Prefer a server-side thumbnail. Falling back to the original is only
    // safe when it is small — some Commons files are 40MB panoramas, and
    // hanging a marker popup on one of those is worse than showing no photo.
    let url = info?.thumburl;
    if (!url && info?.url && (info.size ?? Infinity) <= MAX_ORIGINAL_BYTES) {
      url = info.url;
    }
    if (!url) continue;

    const meta = info?.extmetadata ?? {};
    const author = meta.Artist?.value ? stripHtml(meta.Artist.value) : undefined;
    const license = meta.LicenseShortName?.value
      ? stripHtml(meta.LicenseShortName.value)
      : undefined;

    return {
      url,
      icon: url,
      page: info?.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
      title: title.replace(/^File:/, "").replace(/\.[a-z]+$/i, ""),
      // Some entries carry a wall of credit text; keep it to something showable.
      author: author && author.length <= 80 ? author : undefined,
      license,
    };
  }
  return null;
}

/**
 * A photo near a point, or null if Commons has nothing usable there.
 *
 * Results are cached by rounded coordinate — roughly a 10m grid, so two stops
 * at the same landmark share one lookup — and a miss is cached too, since an
 * unphotographed corner stays unphotographed.
 */
export async function findPhoto(
  p: LatLon,
  radiusM = 180,
  width = 480,
): Promise<Photo | null> {
  const key = `photo:v3:${p.lat.toFixed(4)},${p.lon.toFixed(4)}:${radiusM}`;
  return cached<Photo | null>(key, MONTH, async () => {
    try {
      // Widen the net when the immediate surroundings are unphotographed; a
      // viewpoint is often catalogued from a little further back than it sits.
      return (await search(p, radiusM, width)) ?? (await search(p, radiusM * 2.5, width));
    } catch {
      // A missing photo must never break a walk.
      return null;
    }
  });
}

/**
 * Looks up many points with a small concurrency cap, calling back as each
 * result lands so the map can fill in progressively rather than waiting for
 * the slowest lookup.
 */
export async function findPhotos<T extends LatLon>(
  points: T[],
  onFound: (point: T, photo: Photo | null) => void,
  concurrency = 4,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, points.length) }, async () => {
    for (;;) {
      const i = next++;
      const point = points[i];
      if (!point) return;
      const photo = await findPhoto(point);
      onFound(point, photo);
    }
  });
  await Promise.all(workers);
}
