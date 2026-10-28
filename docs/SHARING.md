# Sharing work with a guest

Share **one piece of work** with someone outside your tailnet: a link that expires after 6 hours, a day
or a week. A **read** link follows the work live. A **chat** link can also message the agents, attach
files and stop them. The guest sees that one piece of work and nothing else of agentbox.

Code: `server/src/shares.ts` (links, the tunnel, the owner's routes), `server/src/shareServer.ts` (the
guest server), `web/src/share/` (the guest page), `web/src/components/Share.tsx` (the Share button),
`setup/modules/ngrok/` (setup). Tests: `server/test/shares.test.ts`.

## Using it

1. Open the work (its task room) and click **Share**.
2. If ngrok isn't set up, the button offers **Set up ngrok with the helper**. You'll need a free ngrok
   account; the authtoken goes into the VM's secrets in your terminal, never into the chat.
3. Choose **Read** or **Chat**, how long it lasts, and who it's for (the agents see this name). Click
   **Create link** and copy it. It's shown once.
4. **Share** lists the live links: when each one expires, whether it has been opened, and **Turn off**.
   Marking the work **Done** turns all of its links off.

From a terminal: `agentbox share <task> [--edit] [--for 6h|1d|7d] [--name who]`, `agentbox shares <task>`,
`agentbox share rm <id>`, `agentbox share status`.

## What a guest sees

| | Read | Chat |
|---|---|---|
| The conversation across the work's agents, live (replies stream in) | ✔ | ✔ |
| Who's working, live progress lines, the roadmap | ✔ | ✔ |
| Documents and files from this work (a reader for Markdown and text) | ✔ | ✔ |
| Notes | ✔ (read) | ✔ (read) |
| Hosted services: what runs and its state | ✔ | ✔ |
| Send messages and attach files to the work's lead | | ✔ |
| Stop a running agent | | ✔ |

A guest has no access to anything else. That includes other work, New task, routines, groups, crews,
agents' settings, the helper, setup, integrations, repos, the screen, the terminal, plans and reviews, and
the "needs you" items. **Hosted services are listed but don't open for a guest**: they stay on your
private network.

## How it's secured

- **A separate server.** Guests reach `shareServer.ts`, which listens on `127.0.0.1:<ports.share>` (7785).
  It isn't the portal. Its routes are `/`, `/assets/*`, `POST /api/session`, `GET /api/room`, `/roadmaps`,
  `/documents`, `/notes`, `/services` and `/file`, the `/api/events` WebSocket, and, for chat links only,
  `POST /api/messages`, `/uploads` and `/stop`. Every route is scoped to the link's work. The portal's
  API, proxies and session never exist on this origin.
- **The tunnel runs only while a link is live.** The portal starts `ngrok http 127.0.0.1:7785` when you
  create a link, and stops it when the last link expires, is turned off or its work is done (checked
  every minute). With no live link there's no public address at all. ngrok's local inspector, which
  records traffic, is turned off.
- **Tokens.** Each link holds 32 random bytes. Only their SHA-256 is stored, so neither the database
  nor an agent reading it can rebuild a link, and you see the link once. The token sits in the URL's
  `#fragment`, which browsers never send, so it doesn't land in ngrok's or anyone's request logs. The
  page trades it for a `__Host-` cookie (HttpOnly, Secure, SameSite=Strict), then removes it from the
  address bar.
- **Request checks.** The Host must be the tunnel's own. Cross-site requests and foreign Origins are
  refused, and writes must be JSON. Responses carry a strict CSP (`script-src 'self'`,
  `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff` and `no-referrer`. Agent-written HTML
  and SVG files are served sandboxed.
- **Limits.** Messages are limited to 20 a minute per link, uploads to 30 every 10 minutes, failed link
  attempts to 30 a minute, and each piece of work to 10 live links.
- **What's redacted or held back.**
  - All text a guest receives goes through the secret redactor (`redact.ts`): messages, streamed
    replies, progress lines, notes and files.
  - A file is served as it is only if it's an image, a PDF, an office document, an archive or
    media. Anything else must read as text (no NUL bytes, valid UTF-8), whatever its name: logs,
    YAML, JSON, scripts and Terraform files are redacted and sent as plain text. A binary of any
    other kind (a database, a keystore) can't be redacted, so it isn't served, and nor is text
    over 4 MB.
  - Files served as they are (PDFs, office documents, images) aren't redacted inside.
  - Streamed replies are redacted as a whole, not piece by piece.
  - Guests never get tool logs or prompts.
  - Files that look like credentials (`.env`, keys, `*credential*`, `*token*`…) are never listed or
    served.
  - A guest can open a file only if one of these is true:
    - it's one of the work's documents (what its tasks wrote, and everything in its shared folder);
    - the guest uploaded it;
    - you or an agent attached or named it in the work's conversation **and** it's inside this work's
      own folders (its shared folder or its tasks' worktrees), or it's an upload you attached;
    - it's an image a permitted Markdown document shows, from inside that document's folder.
  - A path a guest writes in a message never makes a file readable, however it's written.
  - A chat link can attach only files it uploaded itself.
- **Agents know.** While a link is live, every agent in the work is told who it's shared with, and never
  to put secrets in replies, documents or notes. A guest's message reaches the lead marked as theirs, not
  yours. Agents follow it for this work, but anything that is yours to decide (spending, access or
  secrets, irreversible changes, anything outside this work) still goes to you with `ask_owner`.
- **Only you share.**
  - The owner routes (`/api/sharing`, `/api/work/:id/shares`, `/api/shares/:id`) refuse the VM's local
    token, because agents could read it.
  - The phone gateway's allowlist doesn't include them.
  - The `ngrok` command is mapped to no role, so the integration guard refuses it to every agent.

**What it doesn't protect against:**
- A **chat** link lets the guest direct your agents in that work, and they act with the agents' access.
  Give chat links only to people you'd let do that, and prefer **read** links.
- TLS ends at ngrok's edge, so ngrok can see the traffic.
- In `ssh-tunnel` access mode, any local process counts as you, so agents could reach the owner routes.
  This is the same limit as for approvals; see `TRUSTED-AUTONOMY.md`.
- ngrok's free domains show a one-time "You are about to visit" page before the guest page.
