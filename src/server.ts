/**
 * Local development server.
 *
 * sanbu is a static site — the routing engine runs in the browser — so this
 * only serves `dist/`. It exists so that what you test locally is byte for byte
 * what GitHub Pages will serve.
 *
 *   bun run dev     build, then serve
 */
import { existsSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 4321);
const ROOT = "dist";

if (!existsSync(ROOT)) {
  console.error(`No ${ROOT}/ directory. Run \`bun run build\` first.`);
  process.exit(1);
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff2: "font/woff2",
};

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";

    // Nothing may escape dist/.
    const rel = path.replace(/^\/+/, "");
    if (rel.split("/").some((part) => part === "..")) {
      return new Response("Forbidden", { status: 403 });
    }

    const file = Bun.file(`${ROOT}/${rel}`);
    if (await file.exists()) {
      const ext = rel.split(".").pop() ?? "";
      return new Response(file, {
        headers: {
          "content-type": TYPES[ext] ?? "application/octet-stream",
          // Hashed bundles are immutable; everything else must revalidate.
          "cache-control": /-[a-z0-9]{8}\.(js|css)$/.test(rel)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`sanbu (static) on http://localhost:${server.port}`);
