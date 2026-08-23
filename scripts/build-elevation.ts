/**
 * Bakes a terrain lattice for San Francisco into a static asset.
 *
 * Sampling elevation at runtime meant every first-time visitor fired ~18 rapid
 * requests at Open-Meteo and got rate limited, which silently flattened the
 * terrain and broke the hills preference. San Francisco is bounded and terrain
 * does not move, so the whole city is sampled once here instead.
 *
 * The grid uses exactly the same cell geometry as src/elevation.ts, so indices
 * line up without any interpolation at load time.
 *
 * Both providers throttle bursts, so this is paced, fails over between them,
 * and checkpoints as it goes — rerun it and it resumes where it stopped.
 *
 *   bun run scripts/build-elevation.ts
 */
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CELL_M, REF_LAT, cellCentre, cellIndex } from "../src/elevation";

const OUT = "web/data/elevation.json";
const CHECKPOINT = ".cache/elevation-progress.json";
const BATCH = 100;
const PACE_MS = 1100;

// Generous bounds around the city, matching the app's service area.
const BOUNDS = { south: 37.68, west: -122.56, north: 37.85, east: -122.33 };

const lo = cellIndex(BOUNDS.south, BOUNDS.west);
const hi = cellIndex(BOUNDS.north, BOUNDS.east);
const nx = hi.ix - lo.ix + 1;
const ny = hi.iy - lo.iy + 1;
const total = nx * ny;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Provider {
  name: string;
  fetch(coords: Array<{ lat: number; lon: number }>): Promise<number[]>;
}

const providers: Provider[] = [
  {
    name: "open-meteo",
    async fetch(coords) {
      const url =
        "https://api.open-meteo.com/v1/elevation" +
        `?latitude=${coords.map((c) => c.lat.toFixed(6)).join(",")}` +
        `&longitude=${coords.map((c) => c.lon.toFixed(6)).join(",")}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { elevation?: number[] };
      return json.elevation ?? [];
    },
  },
  {
    name: "opentopodata",
    async fetch(coords) {
      const url =
        "https://api.opentopodata.org/v1/srtm30m?locations=" +
        coords.map((c) => `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`).join("|");
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { results?: Array<{ elevation: number | null }> };
      return (json.results ?? []).map((r) => r.elevation ?? 0);
    },
  },
];

/** Row-major, ny rows of nx. Ocean and bay legitimately read as 0. */
const ele = new Int16Array(total);
let nextBatch = 0;

// Resume a previous run rather than re-spending anyone's rate limit.
if (existsSync(CHECKPOINT)) {
  const saved = (await Bun.file(CHECKPOINT).json()) as {
    nx: number;
    ny: number;
    nextBatch: number;
    ele: number[];
  };
  if (saved.nx === nx && saved.ny === ny) {
    ele.set(Int16Array.from(saved.ele));
    nextBatch = saved.nextBatch;
    console.log(`Resuming from checkpoint at batch ${nextBatch}`);
  }
}

const queue: Array<{ i: number; lat: number; lon: number }> = [];
for (let row = 0; row < ny; row++) {
  for (let col = 0; col < nx; col++) {
    const c = cellCentre(lo.ix + col, lo.iy + row);
    queue.push({ i: row * nx + col, lat: c.lat, lon: c.lon });
  }
}

const batches = Math.ceil(queue.length / BATCH);
console.log(
  `Lattice ${nx} x ${ny} = ${total} cells at ${CELL_M}m ` +
    `(~${((nx * CELL_M) / 1000).toFixed(1)} x ${((ny * CELL_M) / 1000).toFixed(1)} km)`,
);
console.log(`${batches} batches, ~${((batches * PACE_MS) / 60000).toFixed(1)} min\n`);

await mkdir(".cache", { recursive: true });

async function checkpoint(): Promise<void> {
  await Bun.write(
    CHECKPOINT,
    JSON.stringify({ nx, ny, nextBatch, ele: Array.from(ele) }),
  );
}

let provider = 0;

for (let b = nextBatch; b < batches; b++) {
  const chunk = queue.slice(b * BATCH, (b + 1) * BATCH);

  let values: number[] | null = null;
  for (let attempt = 0; attempt < 8 && !values; attempt++) {
    const p = providers[provider % providers.length]!;
    try {
      values = await p.fetch(chunk);
    } catch (err) {
      // Rotate providers first — the other one has an independent quota — and
      // only then start waiting.
      provider++;
      const wait = Math.min(60_000, 1500 * 2 ** Math.floor(attempt / providers.length));
      process.stdout.write(`\n  ${p.name} said ${(err as Error).message}; waiting ${wait / 1000}s`);
      await sleep(wait);
    }
  }

  if (!values) {
    await checkpoint();
    throw new Error(`Both providers refused at batch ${b}. Rerun to resume.`);
  }

  chunk.forEach((c, j) => {
    const v = values![j];
    if (typeof v === "number") ele[c.i] = Math.round(v);
  });

  nextBatch = b + 1;
  if (b % 20 === 0) await checkpoint();

  const done = Math.min(total, nextBatch * BATCH);
  process.stdout.write(`\r  ${done}/${total} cells (${((done / total) * 100).toFixed(1)}%)      `);
  if (b + 1 < batches) await sleep(PACE_MS);
}

await checkpoint();
await mkdir("web/data", { recursive: true });

const body = JSON.stringify({
  note: "Terrain lattice for San Francisco. Row-major, ny rows of nx, metres.",
  source: "https://open-meteo.com/ and https://www.opentopodata.org/",
  cell: CELL_M,
  refLat: REF_LAT,
  ix0: lo.ix,
  iy0: lo.iy,
  nx,
  ny,
  ele: Array.from(ele),
});
await Bun.write(OUT, body);

const land = Array.from(ele).filter((v) => v > 0);
console.log(
  `\n\n${OUT}: ${total} cells, ` +
    `${(body.length / 1024).toFixed(0)} KB raw, ` +
    `${(Bun.gzipSync(Buffer.from(body)).length / 1024).toFixed(0)} KB gzipped`,
);
console.log(
  `elevation 0–${Math.max(...ele)} m, ` +
    `${((land.length / total) * 100).toFixed(0)}% of cells above sea level`,
);
