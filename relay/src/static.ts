import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function contentType(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

/**
 * Serves the built ghost app. Missing files fall back to index.html so the
 * client can keep room codes in the path if we ever want pretty URLs.
 */
export function createStaticHandler(root: string) {
  const rootDir = resolve(root);

  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "Method not allowed");
      return;
    }

    if (!existsSync(rootDir)) {
      sendText(
        res,
        503,
        [
          "Ghost client is not built yet.",
          "",
          "Run:",
          "  npm install",
          "  npm run build",
          "",
          `Expected directory: ${rootDir}`,
        ].join("\n"),
      );
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      sendText(res, 400, "Bad request");
      return;
    }

    if (pathname.includes("\0")) {
      sendText(res, 400, "Bad request");
      return;
    }

    const relative = pathname.replace(/^\/+/, "");
    let file = resolve(rootDir, relative || "index.html");

    if (file !== rootDir && !file.startsWith(rootDir + sep)) {
      sendText(res, 403, "Forbidden");
      return;
    }

    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (pathname.includes(".")) {
        sendText(res, 404, "Not found");
        return;
      }
      file = resolve(rootDir, "index.html");
      if (!existsSync(file)) {
        sendText(res, 404, "Not found");
        return;
      }
    }

    const isIndex = file.endsWith(`${sep}index.html`) || file === resolve(rootDir, "index.html");
    const headers: Record<string, string> = {
      "content-type": contentType(file),
      "cache-control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    };

    if (req.method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    res.writeHead(200, headers);
    createReadStream(file)
      .on("error", () => {
        if (!res.headersSent) sendText(res, 500, "Read error");
        else res.destroy();
      })
      .pipe(res);
  };
}
