import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { FastifyInstance } from "fastify";

/**
 * Documents as PDF (the reader's "Download PDF"). The portal sends the document as the reader
 * renders it (already sanitized HTML); we wrap it in a print stylesheet with a strict CSP (no
 * scripts, no network: only inline styles and data: images) and print it with headless Chromium,
 * the Playwright build the display module installs, or one on PATH. Without Chromium the route
 * answers 501 and the portal falls back to the browser's print dialog ("Save as PDF").
 */

const MAX_HTML = 25 * 1024 * 1024; // documents' images come embedded (data: URLs)
const TIMEOUT_MS = 45_000;

export function findChrome(): string | null {
  if (process.env.AGENTBOX_CHROME && fs.existsSync(process.env.AGENTBOX_CHROME)) return process.env.AGENTBOX_CHROME;
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    const builds = fs.readdirSync(cache).filter((d) => d.startsWith("chromium-") && !d.includes("headless")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const b of builds.reverse()) {
      for (const sub of ["chrome-linux", "chrome-linux64", "chrome-linux-arm64"]) {
        const p = path.join(cache, b, sub, "chrome");
        if (fs.existsSync(p)) return p;
      }
    }
  } catch { /* no Playwright cache */ }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
      const p = path.join(dir, name);
      if (dir && fs.existsSync(p)) return p;
    }
  }
  return null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The printable page: the document's HTML in a clean, light print layout. */
export function printPage(title: string, body: string) {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font: 10.5pt/1.55 -apple-system, "Segoe UI", "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif; color: #16181d; margin: 0; }
  .doc-title { font-size: 9pt; color: #5b6474; border-bottom: 1px solid #e2e4e8; padding-bottom: 6pt; margin-bottom: 14pt; }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.3em 0 .5em; page-break-after: avoid; break-after: avoid; }
  h1 { font-size: 19pt; margin-top: 0; } h2 { font-size: 15pt; border-bottom: 1px solid #e2e4e8; padding-bottom: 3pt; }
  h3 { font-size: 12.5pt; } h4 { font-size: 11pt; }
  p, ul, ol, blockquote, table, pre { margin: 0 0 .8em; }
  ul, ol { padding-left: 1.4em; } li { margin: .15em 0; }
  a { color: #2f5bd3; text-decoration: none; }
  code { font-family: "IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace; font-size: 9pt; background: #f0f1f3; padding: 0 3px; border-radius: 3px; }
  pre { background: #f6f7f9; border: 1px solid #e2e4e8; border-radius: 4px; padding: 8pt 10pt; white-space: pre-wrap; overflow-wrap: anywhere; page-break-inside: avoid; break-inside: avoid; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #cdd1d8; margin-left: 0; padding-left: 10pt; color: #5b6474; }
  table { border-collapse: collapse; width: 100%; font-size: 9.5pt; page-break-inside: auto; }
  th, td { border: 1px solid #d5d9e0; padding: 4pt 6pt; text-align: left; vertical-align: top; }
  th { background: #f0f1f3; } tr { page-break-inside: avoid; break-inside: avoid; }
  img { max-width: 100%; }
  hr { border: 0; border-top: 1px solid #e2e4e8; margin: 1.2em 0; }
  .pre-doc { font-family: "IBM Plex Mono", Menlo, monospace; font-size: 9pt; white-space: pre-wrap; overflow-wrap: anywhere; }
</style></head>
<body><div class="doc-title">${esc(title)}</div>${body}</body></html>`;
}

/** Print HTML to a PDF buffer with headless Chromium (null: no Chromium here). */
export async function htmlToPdf(html: string, chrome = findChrome()): Promise<Buffer | null> {
  if (!chrome) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbox-pdf-"));
  const src = path.join(dir, "doc.html"), out = path.join(dir, "doc.pdf");
  try {
    fs.writeFileSync(src, html);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(chrome, [
        "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--no-first-run",
        // Scripts are blocked by the page's CSP (default-src 'none'); --blink-settings=scriptEnabled=false
        // would also stop Chromium's own printing, so it isn't used.
        "--disable-background-networking",
        `--user-data-dir=${path.join(dir, "profile")}`, "--no-pdf-header-footer", "--print-to-pdf-no-header",
        `--print-to-pdf=${out}`, `file://${src}`,
      ], { stdio: ["ignore", "ignore", "pipe"], detached: true });
      let err = "";
      child.stderr!.on("data", (b) => { err += b; if (err.length > 20_000) err = err.slice(-10_000); });
      const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } reject(new Error("Chromium timed out")); }, TIMEOUT_MS);
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", () => { clearTimeout(timer); fs.existsSync(out) ? resolve() : reject(new Error(`Chromium made no PDF: ${err.trim().split("\n").slice(-2).join(" ")}`)); });
    });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const fileName = (s: unknown) => String(s ?? "document").replace(/\.[A-Za-z0-9]{1,8}$/, "").replace(/[^\w .()-]+/g, "_").slice(0, 120) || "document";

export function registerPdfRoutes(app: FastifyInstance, deps: { chrome?: () => string | null; print?: typeof htmlToPdf } = {}) {
  app.post("/api/pdf", { bodyLimit: MAX_HTML + 64 * 1024 }, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const html = String(b.html ?? "");
    if (!html.trim()) throw httpError(400, "Nothing to print");
    if (html.length > MAX_HTML) throw httpError(413, "This document is too large to export as PDF");
    const name = fileName(b.name);
    const chrome = (deps.chrome ?? findChrome)();
    if (!chrome) throw httpError(501, "PDF export needs Chromium on this computer (the display module installs it)");
    const pdf = await (deps.print ?? htmlToPdf)(printPage(String(b.title ?? name).slice(0, 200), html), chrome);
    if (!pdf) throw httpError(501, "PDF export needs Chromium on this computer");
    reply.header("content-type", "application/pdf");
    reply.header("content-disposition", `attachment; filename="${name}.pdf"`);
    reply.header("cache-control", "no-store");
    return reply.send(pdf);
  });
}
