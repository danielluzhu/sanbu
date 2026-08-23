/**
 * Produces the static site in `dist/`.
 *
 * Bun's HTML bundler follows `<script type="module" src="./main.ts">`, compiles
 * the TypeScript engine, bundles Leaflet, inlines its marker images and emits
 * relative asset URLs — which is what lets the same output work at a domain
 * root and under a GitHub Pages subpath like /sanbu/.
 */
import { rm, mkdir, readdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const OUT = "dist";

await rm(OUT, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["web/index.html"],
  outdir: OUT,
  minify: true,
  sourcemap: "linked",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("build failed");
}

// The baked High Injury Network is fetched at runtime, so it is copied rather
// than bundled.
if (existsSync("web/data")) {
  await mkdir(`${OUT}/data`, { recursive: true });
  for (const name of await readdir("web/data")) {
    await copyFile(`web/data/${name}`, `${OUT}/data/${name}`);
  }
}

// Without this, GitHub Pages runs the output through Jekyll, which strips files
// and directories beginning with an underscore.
await Bun.write(`${OUT}/.nojekyll`, "");

let total = 0;
for (const name of await readdir(OUT)) {
  const file = Bun.file(`${OUT}/${name}`);
  const size = file.size;
  if (size > 0) total += size;
  if (!name.endsWith(".map")) {
    console.log(`  ${name.padEnd(28)} ${(size / 1024).toFixed(1)} KB`);
  }
}
console.log(`\ndist/ built — ${(total / 1024).toFixed(0)} KB total`);
