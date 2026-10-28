// The masked secret prompt (cli/secret-input.mjs): feedback for every line, never the value.
//   node --test cli/test/secret-input.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { maskLine, readSecretTty } from "../secret-input.mjs";

const SECRET = "2abcDEFghijk_lmnop1234567890QRSTuvwxyz_0123456789";
function fake(chunks) {
  const input = Object.assign(new EventEmitter(), { modes: [], setRawMode(on) { this.modes.push(on); }, resume() {}, pause() {} });
  let screen = "";
  const out = { write: (s) => { screen += s; } };
  const p = readSecretTty("ngrok.env", input, out);
  for (const c of chunks) input.emit("data", Buffer.from(c));
  return p.then((v) => ({ v, screen, modes: input.modes }));
}

test("maskLine: the key stays, the value is dots and a length", () => {
  assert.equal(maskLine(`NGROK_AUTHTOKEN=${SECRET}`), `NGROK_AUTHTOKEN=${"•".repeat(24)} (${SECRET.length} chars)`);
  assert.equal(maskLine("abc"), "••• (3 chars)");
  assert.equal(maskLine(""), "");
});

test("pasting lines shows them masked; an empty line finishes; the value never reaches the screen", async () => {
  const { v, screen, modes } = await fake([`\x1b[200~NGROK_AUTHTOKEN=${SECRET}\nNGROK_DOMAIN=skintight-snap-edging.ngrok-free.dev\x1b[201~`, "\r", "\r"]);
  assert.equal(v, `NGROK_AUTHTOKEN=${SECRET}\nNGROK_DOMAIN=skintight-snap-edging.ngrok-free.dev\n`);
  assert.ok(!screen.includes(SECRET) && !screen.includes("skintight"), "no value on screen");
  assert.match(screen, /NGROK_AUTHTOKEN=•+ \(49 chars\)/);
  assert.match(screen, /Got 2 lines: NGROK_AUTHTOKEN \(49 chars\), NGROK_DOMAIN \(\d+ chars\)/);
  assert.deepEqual(modes, [true, false], "raw mode on, then restored");
});

test("Ctrl-D finishes with the line being typed; Backspace edits; Ctrl-C cancels", async () => {
  assert.equal((await fake(["tokx", "\x7f", "en", "\x04"])).v, "token\n");
  assert.equal((await fake(["A=1\r", "\x03"])).v, null);
});
