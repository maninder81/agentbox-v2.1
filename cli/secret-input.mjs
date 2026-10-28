// Typing or pasting a secret in a terminal (agentbox secret set): masked feedback, never the value.

/** What a line of a secret looks like on screen: `KEY=•••• (49 chars)`, or dots and a count. Never the value. */
export function maskLine(line) {
  const dots = (n) => "•".repeat(Math.min(n, 24));
  const m = /^([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/.exec(line);
  if (m) return `${m[1]}=${dots(m[2].length)}${m[2].length ? ` (${m[2].length} chars)` : ""}`;
  return line.length ? `${dots(line.length)} (${line.length} chars)` : "";
}

/**
 * Reads a secret from the terminal, showing each line masked (the key of KEY=value lines, dots for the
 * value, and its length), so typing or pasting gives feedback without the value ever reaching the
 * screen, or the helper's view of it. Enter on an empty line (or Ctrl-D) finishes; Ctrl-C cancels (null).
 */
export function readSecretTty(name, input = process.stdin, out = process.stderr) {
  out.write(`Paste or type the value for ${name}. Each line shows masked, e.g. KEY=•••• (49 chars).\n` +
    `Press Enter on an empty line (or Ctrl-D) when done; Ctrl-C cancels.\n`);
  const lines = [];
  let cur = "";
  const draw = () => out.write(`\r\x1b[K  ${maskLine(cur)}`);
  return new Promise((resolve) => {
    const finish = (v) => {
      input.off("data", onData);
      try { input.setRawMode?.(false); } catch { /* not a tty */ }
      input.pause();
      if (v !== null) {
        const keys = v.split("\n").filter(Boolean).map((l) => maskLine(l).replace(/=•+/, "").replace(/^•+ /, "value "));
        out.write(`\nGot ${keys.length} line${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}\n`);
      } else out.write("\n");
      resolve(v);
    };
    const value = () => (lines.length ? lines.join("\n") + "\n" : "");
    const onData = (chunk) => {
      // Pasted text arrives in one go, maybe wrapped in bracketed-paste markers; other escapes are dropped.
      const s = chunk.toString("utf8").replace(/\x1b\[20[01]~/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "").replace(/\x1b./g, "");
      for (const ch of s) {
        if (ch === "\x03") return finish(null); // Ctrl-C
        if (ch === "\x04") { if (cur) lines.push(cur); return finish(value()); } // Ctrl-D
        if (ch === "\r" || ch === "\n") {
          if (!cur) { if (lines.length) return finish(value()); continue; } // an empty line ends it
          draw(); // show this line masked before moving on (a paste brings several at once)
          lines.push(cur);
          out.write("\n");
          cur = "";
          draw();
          continue;
        }
        if (ch === "\x7f" || ch === "\b") { cur = [...cur].slice(0, -1).join(""); draw(); continue; }
        if (ch < " ") continue;
        cur += ch;
      }
      draw();
    };
    try { input.setRawMode?.(true); } catch { /* not a tty */ }
    input.resume();
    input.on("data", onData);
    draw();
  });
}
