/**
 * Documents as PDF (server/src/pdf.ts): the route, the print page and the no-Chromium answer.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/pdf.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
const P = await import("../src/pdf.ts");
const Fastify = (await import("fastify")).default;

test("print page: strict CSP (no scripts, no network), escaped title, the document inside", () => {
  const page = P.printPage(`Plan <v2> & "notes"`, "<h1>Hello</h1>");
  assert.match(page, /Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"/);
  assert.match(page, /<title>Plan &lt;v2&gt; &amp; &quot;notes&quot;<\/title>/);
  assert.match(page, /<h1>Hello<\/h1><\/body>/);
});

test("route: a PDF attachment named after the document; 501 without Chromium; empty and oversized refused", async () => {
  let printed = "";
  const app = Fastify();
  P.registerPdfRoutes(app, { chrome: () => "/fake/chrome", print: async (html) => { printed = html; return Buffer.from("%PDF-1.7 fake"); } });
  let r = await app.inject({ method: "POST", url: "/api/pdf", payload: { html: "<p>x</p>", name: "2026-10-11-plan.md" } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-type"], "application/pdf");
  assert.equal(r.headers["content-disposition"], 'attachment; filename="2026-10-11-plan.pdf"');
  assert.ok(r.rawPayload.toString().startsWith("%PDF"));
  assert.match(printed, /<p>x<\/p>/);
  r = await app.inject({ method: "POST", url: "/api/pdf", payload: { html: "  " } });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ method: "POST", url: "/api/pdf", payload: { html: "x".repeat(25 * 1024 * 1024 + 10) } });
  assert.equal(r.statusCode, 413);
  await app.close();
  const none = Fastify();
  P.registerPdfRoutes(none, { chrome: () => null });
  r = await none.inject({ method: "POST", url: "/api/pdf", payload: { html: "<p>x</p>" } });
  assert.equal(r.statusCode, 501);
  await none.close();
});
