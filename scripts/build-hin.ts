/**
 * Bakes San Francisco's Vision Zero High Injury Network into a static asset.
 *
 * The live DataSF dataset is ~5,900 segments spread over several paginated
 * requests. That is fine for a server that caches it once, but unacceptable to
 * ask of every visitor, so the geometry is fetched at build time and committed.
 *
 * Output is deliberately minimal: each segment becomes one flat array of
 * lat,lon,lat,lon... rounded to 5 decimal places (about a metre), which is far
 * smaller than GeoJSON and is exactly what the spatial index wants.
 *
 *   bun run scripts/build-hin.ts
 */
import { mkdir } from "node:fs/promises";

const DATASET = "enwt-3u8m";
const OUT = "web/data/hin.json";
const PAGE = 2000;

interface SodaRow {
  geom?: { type: string; coordinates: number[][] | number[][][] };
}

const round = (n: number) => Math.round(n * 1e5) / 1e5;

const segments: number[][] = [];

for (let offset = 0; ; offset += PAGE) {
  const url =
    `https://data.sfgov.org/resource/${DATASET}.json` +
    `?$select=geom&$limit=${PAGE}&$offset=${offset}`;
  process.stdout.write(`  fetching offset ${offset}… `);

  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`DataSF ${res.status}`);
  const rows = (await res.json()) as SodaRow[];
  console.log(`${rows.length} rows`);
  if (rows.length === 0) break;

  for (const row of rows) {
    const geom = row.geom;
    if (!geom) continue;
    // The dataset has shipped both LineString and MultiLineString over its life.
    const lines: number[][][] =
      geom.type === "MultiLineString"
        ? (geom.coordinates as number[][][])
        : [geom.coordinates as number[][]];

    for (const line of lines) {
      const flat: number[] = [];
      for (const c of line) {
        if (!Array.isArray(c) || c.length < 2) continue;
        flat.push(round(c[1]!), round(c[0]!));
      }
      if (flat.length >= 4) segments.push(flat);
    }
  }
  if (rows.length < PAGE) break;
}

await mkdir("web/data", { recursive: true });
const body = JSON.stringify({
  source: `https://data.sfgov.org/resource/${DATASET}.json`,
  name: "SF Vision Zero High Injury Network (2024)",
  format: "flat [lat,lon,...] per segment",
  segments,
});
await Bun.write(OUT, body);

const vertices = segments.reduce((n, s) => n + s.length / 2, 0);
console.log(
  `\n${OUT}: ${segments.length} segments, ${vertices} vertices, ` +
    `${(body.length / 1024).toFixed(0)} KB raw, ` +
    `${(Bun.gzipSync(Buffer.from(body)).length / 1024).toFixed(0)} KB gzipped`,
);
