# agentbox features

agentbox is a self-hosted team of Claude agents that share one Linux computer: a cloud VM, or a Lima VM on
a Mac. The agents have a browser, a terminal and your dev tools. You run them from a web portal and an
Android app. They plan, code, review, test, deploy, design CAD parts and drive hardware, under rules you
set. You can also do everything from a terminal with the `agentbox` command line.

This document lists every feature, both what you see and what works underneath. Each entry says what it is,
how it behaves, and where it lives in the code (`server/src/…`, `web/src/…`, `setup/modules/…`). Design
documents with more depth are listed at the end.

**Markers**
- **[UI]** is something you see or click.
- **[Agent]** is a tool or rule the agents work with.
- **[Internal]** is a mechanism that runs underneath.

---

## Contents
1. [The computer and its setup](#1-the-computer-and-its-setup)
2. [Agents and the team](#2-agents-and-the-team)
3. [Crews](#3-crews)
4. [Working with agents: tasks and task rooms](#4-working-with-agents-tasks-and-task-rooms)
5. [Delegation and autonomy](#5-delegation-and-autonomy)
6. [Plans, reviews and roadmaps](#6-plans-reviews-and-roadmaps)
7. [Groups and group workspaces](#7-groups-and-group-workspaces)
8. [Routines and wake-ups](#8-routines-and-wake-ups)
9. [Repos, worktrees, maps and repo memory](#9-repos-worktrees-maps-and-repo-memory)
10. [Integrations and connectivity](#10-integrations-and-connectivity)
11. [The helper (setup agent)](#11-the-helper-setup-agent)
12. [The shared computer: screen, browser, terminals](#12-the-shared-computer-screen-browser-terminals)
13. [Hosting what agents build](#13-hosting-what-agents-build)
14. [Documents, notes and files](#14-documents-notes-and-files)
15. [Visibility: live progress, needs you, activity](#15-visibility-live-progress-needs-you-activity)
16. [Phone app, push and voice](#16-phone-app-push-and-voice)
17. [Access and security](#17-access-and-security)
18. [Internal mechanisms](#18-internal-mechanisms)
19. [The command line](#19-the-command-line)
20. [Further reading](#20-further-reading)

---

## 1. The computer and its setup

| Feature | What it does |
|---|---|
| **One shared VM** [Internal] | All agents work on one Linux computer (Ubuntu 24.04). It's a cloud VM (e.g. GCP `agentbox-mumbai`) or a Lima VM on a Mac (`agentbox-v2-test`). The work area is `/work`, agents' homes are `/agents`, secrets are `/secrets`, and all paths are configurable. |
| **Modular setup** [Internal] | Everything beyond the core is a **module** (`setup/modules/<name>/`): `install.sh`, `configure.sh`, `verify.sh` and `disable.sh`, plus a `module.yaml`. Base modules are core, claude, access, display, terminal, mobile, push and voice. Integration modules are github, gitlab, bitbucket, aws, gcp, azure, kubernetes, db-tunnel, env-files, bench and onshape; slack and teams are coming soon. |
| **System commands** [UI] | The `agentbox` command on the VM also runs the system: `status`, `restart`, `update` (pull, rebuild, restart; refuses while agents work unless forced), `module list/install/enable/disable/verify/check`, `integration list/connect/verify/disconnect/settings/status`, `repo list/add/status/fetch/remap/remove`, `config get/set`, `secret set` (hidden input, also in browser terminals), `guide`, and `api` (call the portal API with the local token). For everything else it does, see §19. |
| **Guided installer** [UI] | `agentbox guide` serves a one-time setup page. It shows a live roadmap of the install, a terminal and the setup agent, and survives restarts. Base-only first run: anything optional is set up later from Integrations. |
| **Config file** [Internal] | `config.yaml` holds paths, ports, enabled modules, the access mode and hosting ports, and is loaded at start (`server/src/config.ts`). `GET /api/config/public` exposes the non-secret parts to the portal. |
| **Start and stop** [UI] | Local Lima: `limactl start/stop` plus `agentbox-v21-web`. Cloud: a systemd unit (`agentbox-web`). Deploys wait until no agent is working. |

## 2. Agents and the team

| Feature | What it does |
|---|---|
| **Agents are roles** [UI] | Each agent (tech-lead, coder, devops, security, robotics-lead, cad…) has a **job description** (`CLAUDE.md`), a model (Opus/Sonnet/Haiku), skills, integrations, memory and a home folder (`/agents/<slug>`). |
| **Interview-based creation** [UI] | **New agent** works like a hiring interview: you pick a starting role (templates such as tech-lead or coder), answer core questions, then Claude asks role-specific follow-ups and drafts the job description for you to review. You also choose which **crew** it joins (`server/src/interview.ts`, `web/src/views/CreateAgent.tsx`). |
| **One instance per task** [UI][Internal] | Work runs on **instances** (`coder#3`, `tech-lead#2`): a fresh copy of the role for each task, with its own conversation. There are per-creator limits (5 by default, or the role's `max_replicas`) and a global cap of 40 live instances (`server/src/agents.ts`). |
| **Leads (planning agents)** [Agent] | A role marked "Plans and delegates" (`can_scale`, e.g. tech-lead or robotics-lead) orchestrates. It plans, delegates, reviews and merges, but **doesn't do hands-on edits or commits**; `orchestratorGuard` enforces this (`server/src/roleGuards.ts`). Each piece of work gets at most one lead of a role, reused for later handoffs. |
| **Instruction layers** [Internal] | An agent's system prompt is rebuilt **every turn** from layers: the job description, team rules, its crew roster, repos (with "you map it"), linked work, group-lead or workspace notes, the integrations it has, the shared computer, and privileges. A changed job description applies from the next turn (`server/src/runner.ts`). |
| **Skills** [UI][Agent] | A shared skill library (`/skills/<name>/SKILL.md` plus scripts, in Claude's skill format), assigned per agent. Seeded skills include `file-github-issue`, `open-pr`, `review-pr`, `run-epic`, `fix-vulnerability`, `onboard-repo`, `host-service`, `bench-hardware`, `onshape` and the CAD skills (`cad`, `dfm`, `step-parts`, `urdf`…). Agents **propose** new skills as drafts and you approve them (`server/src/skills.ts`, Skills page). |
| **Models and usage** [UI] | Agents run on your Claude subscription. A usage chip shows the 5-hour and weekly limits, and routines skip runs while rate-limited. |
| **Step limit continues** [Internal] | Reaching a turn's step limit (`max_turns`) isn't a failure: the turn carries on automatically in the same session, a bounded number of times. |
| **Start the conversation fresh** [UI] | On a task's panel: reset a long or off-track conversation. History and memory stay. |
| **Team rules** [Agent] | Team-wide documents in `/team` (GitHub issue rules, branching, reviews), shown to every agent. |

## 3. Crews

| Feature | What it does |
|---|---|
| **Crews: separate teams** [UI][Agent] | Robotics, Software engineering and so on. Each agent belongs to at most one crew, and its tasks go with it. Agents only **see, delegate to and message** agents in their own crew; tech-lead can't hand work to cad. Agents in no crew form a pool of their own. The helper works for every crew (`server/src/crews.ts`). |
| **Crews page** [UI] | Create, rename and delete crews, choose each crew's **lead**, and move agents between crews (`#/crews`, the icon next to Team). Deleting a crew leaves its agents in no crew. |
| **Crew-first New task** [UI] | New task asks **which crew** first, then **who** in it. It defaults to the crew's lead and remembers the last crew used. |
| **Sidebar by crew** [UI] | The Team list in the sidebar is grouped by crew. |
| **Enforced in every path** [Internal] | Delegation, messages, `list_agents`, `find_work` (search past tasks) and each agent's roster all filter by crew. Refusals name the other crew. |

## 4. Working with agents: tasks and task rooms

| Feature | What it does |
|---|---|
| **New task** [UI] | Pick a crew and an agent, describe the work, and optionally pick repos, ask to approve a plan first, link other work, attach files or dictate. Every task gets its own conversation. |
| **Task rooms** [UI] | A task and everything it starts (helpers, a lead) form one **room** with a merged timeline across all agents. It has a task filter, a members list and a **shared folder** (`/work/rooms/…`) for state, scripts and notes. Mark it **Done** to finish it all. Finished rooms stay listed for 24 h unless kept (`server/src/work.ts`, `web/src/views/Room.tsx`). |
| **Room panel tabs** [UI] | **Tasks · Documents · Notes · Services**: who's working, what they wrote, your notebook, and what's hosted. |
| **Attachments: any file** [UI][Agent] | Paste (⌘V), drop or attach (📎) images, PDFs, Markdown, Excel, Word, CSV, zip and more: up to 20 MB each, 10 per message. Images show as thumbnails and other files as chips and links that open in the reader. Agents get each path with how to open it: the Read tool for images, PDFs and text, Python for spreadsheets, Word and slides (`server/src/uploads.ts`). |
| **Linked work** [UI][Agent] | Link other work (often another crew's) to a task, when creating it or with the **Link** button. Every task in it can then **read** the linked work's progress and roadmap, conversation, documents and hosted links (`read_linked_work`). Linking is read-only and one-way; crews stay closed. A strip under the header shows "Reads …" and "Read by …" (`server/src/linkedWork.ts`). |
| **Share with a guest** [UI][Internal] | **Share** in a task room makes a link for someone outside your tailnet: **read** (follows the conversation, progress, roadmap, documents, notes and services live) or **chat** (can also message the agents, attach files and stop them), expiring after 6 hours, a day or a week. The guest gets a bare page with that one piece of work and nothing else. The link goes through an ngrok tunnel that runs only while a link is live, to a separate guest server. Only a hash of each token is stored; what the guest reads is redacted, credential-looking files are held back, and the agents are told the work is shared. Without ngrok, Share offers to have the helper set it up (`server/src/shares.ts`, `shareServer.ts`, `docs/SHARING.md`). |
| **Notes** [UI] | A notebook per piece of work. Select text in a chat and choose **Save to notes** (with an optional note of your own), or write a note in the **Notes** tab. Notes are plain text, links are clickable, and you can copy, edit or delete them. They're shared by the whole work and only you can see them (`server/src/notes.ts`). |
| **Stop, Esc, Pause all** [UI] | Esc or Stop ends the running turn. **Pause all** stops new turns everywhere and persists across restarts (`server/src/control.ts`). |
| **Rename, keep, finish** [UI] | Click a task's title to rename it. Done finishes the work; Keep holds a finished room in the list. |
| **Message links** [UI] | Roadmap steps and notifications link to the exact message, which is scrolled to and highlighted. |
| **Jump to latest** [UI] | Scrolled up in a conversation, a button takes you back to the newest message. It reads **New messages** when replies arrive meanwhile. |
| **Sidebar** [UI] | Overview, Activity, Tasks, Routines and Documents at the top, then Work, Team (by crew) and Groups. The less frequent pages sit in collapsed sections below: **Configure** (Setup, Integrations, Repos, Skills) and **Computer** (Screen, Terminal, System, Devices); a section opens itself when you're on one of its pages. |
| **Light, Dark or System theme** [UI] | A theme switch in the top bar. |

## 5. Delegation and autonomy

| Feature | What it does |
|---|---|
| **delegate_task / send_message** [Agent] | Agents hand tasks to crewmates. Delegating to an **agent** starts a fresh instance; to an **instance** (`coder#3`), it's a follow-up in that conversation. Reports come back **automatically** as the delegator's next turn (`server/src/team.ts`). |
| **Rework goes back to its author** [Internal] | Follow-up work on an issue or PR (matched by `#numbers`) goes to the instance that did it, which is reopened if it was closed. |
| **Limits** [Internal] | Delegation depth is 3, with at most 6 handoffs per turn, no handing work back to whoever gave it, and no delegating to yourself. |
| **Roadmap before delegation** [Agent] | A lead must create the work's roadmap before delegating, so you can follow it from the start. |
| **ask_owner** [Agent] | The one way to reach you: a "needs you" item, used for decisions that are yours (spend, breaking changes, direction, access). In a workspace a group launched, it reaches the **group's lead first**. |
| **Stalls go to the lead** [Internal] | A helper that looks stuck is reported to its lead, who checks on it, stops it or re-delegates. Only a lead's own stall reaches you (`server/src/attention.ts`). |
| **Lead merges routine PRs** [Agent] | When a repo allows it (on by default), the work's lead merges routine PRs into protected branches once CI is green with no breaking changes. Epics and risky changes go to you. |
| **stop_task, get_task, find_work, retire_instance** [Agent] | Manage helpers: stop one that's stuck, check a task's status, find who worked on an issue (within the crew), and close instances whose work is finished. |
| **Human out of the loop** [Internal] | By default nothing waits on you. Plans are shared rather than gated, and leads decide routine matters. Waiting on you is a per-task opt-in. |

## 6. Plans, reviews and roadmaps

| Feature | What it does |
|---|---|
| **Plans with a before/after diagram** [UI][Agent] | `submit_plan`: a short plan led by a simple before/after diagram. By default the plan is shared and work carries on. With **Approve a plan first** (per task), edits and commits wait for your approval. A helper's plan goes to its delegator (`decide_plan`), not to you (`server/src/plans.ts`). |
| **Diff review** [UI] | A task's **Changes** view shows what it changed in each repo worktree against where its branch left the default branch: committed, uncommitted and new files. You can add line comments and approve, request changes or reject, delivered as one message (`server/src/changes.ts`, `reviewRoutes.ts`). |
| **Roadmaps** [UI][Agent] | Leads keep live progress maps of big work: steps with phases, dependencies ("after"), owners, notes and links. They show as a **metro line** under the header and as a graph, with Now and Blocked at a glance. Steps open the message behind them or their link (PR, doc, workspace). You can archive one (`server/src/roadmaps.ts`, `web/src/components/Roadmap.tsx`). |

## 7. Groups and group workspaces

| Feature | What it does |
|---|---|
| **Group chats** [UI] | You and several agents in one thread, with a **lead** you choose. **@mentions** decide who replies; with no mention, the lead answers. Agents can stay silent (`NO_REPLY`). Each agent catches up on what it missed (`server/src/groups.ts`). |
| **Group workspaces** [UI][Agent] | You set direction in a group; its **lead launches a workspace per item** with `launch_workspace` (title, brief, lead from its crew, repos, order). Each is a task room under Work, marked "launched from #group" (`server/src/groupWork.ts`). |
| **The group's roadmap** [UI] | One step per workspace, shown at the top of the group and kept current automatically: launched is doing, a question waiting is blocked, finished is done. Steps open their workspace. |
| **Workspaces panel** [UI] | In the group header: each workspace's lead, state, roadmap progress and any question waiting. |
| **The lead oversees** [Agent] | Outside the group chat, the lead follows workspaces (`list_workspaces`, `read_linked_work`), steers them (`message_workspace`; replies come back to it), closes them (`finish_workspace`) and posts what you should know (`post_to_group`). At most 8 live workspaces per group. |
| **Questions go to the group lead first** [Agent] | `ask_owner` from inside a group's workspace goes to the group lead, whose reply is the answer. Only calls that are truly yours reach you. |

## 8. Routines and wake-ups

| Feature | What it does |
|---|---|
| **Routines** [UI] | Recurring jobs on a cron schedule with a timezone (e.g. "review Dependabot PRs daily at 10:00"), showing the next runs. You can run one now, enable or disable it. Each routine has its own instance (`server/src/routines.ts`). |
| **Context between runs** [UI] | **Continue** (the conversation carries over, compacted after 5 runs, 24 h or 100k tokens) or **Fresh**. **Compact now** and **Start fresh** buttons. |
| **Overlap and rate-limit protection** [Internal] | A run is skipped while the previous cycle, including its lead's work, is still going, or while the plan is rate-limited. |
| **Routine rules** [UI][Internal] | Standing orders for everyone in a routine: instructions plus switches for merge to main, deploy, GitHub issues and helpers at once. Merges, deploy workflows and issue creation are **checked before the command runs** (`server/src/rules.ts`). |
| **Run tracking** [UI] | **Running now**, run history (outcome, duration, one-line summary) and a page per run (`server/src/routineRuns.ts`). |
| **Wake-ups** [Agent] | `schedule_wakeup`: an agent asks to be woken later (check CI in 20 minutes, resume after a rate limit) instead of polling. Wake-ups survive restarts and show on the Routines page (`server/src/wakeups.ts`). |

## 9. Repos, worktrees, maps and repo memory

| Feature | What it does |
|---|---|
| **Repos page** [UI] | Add repos from a connected GitHub, GitLab or Bitbucket account or by URL, with an access check (a setup request if there's no access). Each repo has settings for the default and protected branches, which agents may use, merge and deploy rules, and the test command (`server/src/repos.ts`). |
| **Canonical clones** [Internal] | One read-only partial clone per repo (`/work/repos/<name>`), kept fetched. Agents never edit, build or check out there; `repoGuard` enforces this. |
| **Worktree per task** [Agent] | `use_repo(name)` gives each task its own worktree and branch off `origin/<default>`, reused for rework. Worktrees are cleaned up or **kept** when they hold unpushed work. |
| **Repo maps** [UI][Agent] | An onboarding run writes a high-level map (`ARCHITECTURE.md`, `FEATURE-MAP.md`) read-only, without installs or builds. Agents read it before exploring. An optional setting proposes it to the repo as a PR. |
| **Who maps a repo** [UI][Agent] | Each repo has a **"Mapped by"** agent, which you pick when adding it or on its card. Leave it to the helper and it takes a quick read-only look (README, files, languages), picks the **best-fitting crew lead** and records why (`choose_repo_mapper`). If only one crew lead can use the repo, that lead maps it directly. Re-map uses the mapper. |
| **Weekly map refresh** [UI] | One paused routine **per mapper**, each refreshing the repos it maps ("you map it" in its instructions). |
| **Repo memory tree** [Agent][Internal] | Per-repo notes that agents learn as they work (`/work/memory/<repo>/`). The agents own the layout and it has its own git history. Knowledge lands **only when work merges to main**: until then notes go to the task's draft folder and are folded in on merge, or discarded if the PR closes unmerged. Notes are **anchored to code**: when main changes the anchored code, a token-free re-hash marks them `stale:` and an agent re-verifies when it reads them. Writes are safe with many agents (`memory_write/move/delete/confirm`, serialized per repo; the tree is read-only to file tools) (`server/src/memory.ts`, `docs/TREE-MEMORY.md`). |
| **Branch and merge guards** [Internal] | Pushes to protected branches, PR merges into them and deploy workflows are refused unless the repo allows them (`server/src/repoGuard.ts`). |
| **Setup requests** [UI][Agent] | An agent missing an account, login, tool or access calls `request_setup`. You get a card and a "needs you" item with **Set up now** and **Reject**. When it's done, every waiting agent gets a new turn (`server/src/setupRequests.ts`). |

## 10. Integrations and connectivity

| Feature | What it does |
|---|---|
| **Integrations page** [UI] | A catalog with states (available, connecting, connected, error) and **Connect / Verify / Disconnect** buttons. Settings per integration; **role mapping** says which agents may use each one (`server/src/integrations.ts`). |
| **Integration guard** [Internal] | An integration's CLIs (`gh`, `aws`, `kubectl`, `gcloud`…) only run for roles mapped to it. Others are told who has it and to delegate (`integrationGuard`). |
| **Code hosting** | GitHub (`git` + `gh`), GitLab (`glab`), Bitbucket (REST helper). |
| **Clouds** | AWS (CLI v2 + Session Manager), GCP (`gcloud`), Azure (`az`). Credentials come from the VM's identity or your login. |
| **Kubernetes** | `kubectl` + kubeconfig, with rules for what agents may change. |
| **Database tunnels** | Named SSH or AWS SSM port forwards to private databases (`agentbox-tunnel`). |
| **Environment files** | Per-repo `.env` files kept in `/secrets/<repo>/` (0600), linked into worktrees and never printed. |
| **Device bridge (bench)** [UI][Agent] | Share your computer's USB serial devices (Arduino, ESP32…) with agents. A script on your computer dials **out** to the portal, so nothing listens on your computer. Boards appear in the VM as real-looking serial ports (`/dev/bench/<id>`, CUSE) or via RFC 2217, and `agentbox-avr-upload` flashes Uno and Nano boards from the VM (`server/src/bench.ts`, `docs/BENCH.md`). |
| **Onshape** [Agent] | Agents put the CAD models they make into your Onshape: one private document per part, a tab per version, for you to open, measure and comment on (`docs/ONSHAPE.md`). |
| **Share work (ngrok)** | The tunnel behind guest links (§4): the helper installs ngrok and you save its authtoken (and domain) in the VM's secrets. No agent may run `ngrok` (`setup/modules/ngrok/`). |
| **Coming soon** | Slack and Microsoft Teams. |

## 11. The helper (setup agent)

| Feature | What it does |
|---|---|
| **A built-in helper** [UI] | A permanent built-in agent for setup, integrations and the team. **Ask helper** (⌘K) from anywhere, or open the Helper workspace. Only you start its tasks, it's not part of any crew, and it can't be deleted (`server/src/setup.ts`). |
| **Setup workspace** [UI] | Chat, **your terminal** and a **self-ticking checklist** on one screen. Each step has instructions, commands to copy or insert, and a check that ticks itself when it passes (`server/src/setupPlan.ts`, `terminal.ts`). |
| **Reads your terminal, safely** [Internal] | The helper can read (never type into) your terminal, with secrets redacted first: keys, tokens, passwords, device codes (`server/src/redact.ts`). |
| **Temporary sudo** [Internal] | sudo is granted only while a helper turn runs, removed at start and swept every minute; other agents' sudo is denied meanwhile (`server/src/sudo.ts`). |
| **Team changes on approval** [UI] | The helper proposes new agents, changes to agents (job description, settings, skills, integrations, repos, crew), new or changed skills, and bundles of these as **approval cards**. Nothing applies until you approve, optionally after editing; every card has **Undo** (`server/src/teamAdmin.ts`, `approvals.ts`). |
| **Chooses who maps a repo** [Agent] | See §9. |

## 12. The shared computer: screen, browser, terminals

| Feature | What it does |
|---|---|
| **Shared screen** [UI] | The VM's display (Xvfb `:99`) live in the portal through noVNC. Watch it, **take control**, or use a picture-in-picture preview you can drag anywhere. |
| **Shared Chromium** [Agent] | One browser with your web logins, driven by agents through their browser tools (CDP). CLIs' "open a browser" requests (gh, aws sso, OAuth) open there. It uses software WebGL so 3D pages like Onshape work. |
| **Screen lock** [Internal] | One agent, or you, drives the screen at a time. Others are refused and work headless, and the lock is released when the turn ends (`server/src/control.ts`). |
| **Clipboard bridge** [UI] | ⌘V pastes your Mac's clipboard into the VM; copying in the VM (⌘C) lands on your clipboard; ⌘ acts as Ctrl inside the VM (`setup/modules/display/novnc/agentbox-clipboard.js`). |
| **Web terminal** [UI] | A shell in the VM in the portal (ttyd, `/term/`), behind the portal's auth with an Origin check. |

## 13. Hosting what agents build

| Feature | What it does |
|---|---|
| **host_start / host_stop / host_list / host_logs** [Agent] | Agents serve a static folder or a command (a dev server, an API) at a link you open, e.g. `https://<node>.ts.net:10000/<name>/`. Commands get `$PORT` and a clean environment, logs are kept, and a failed start returns its output (`server/src/hosting.ts`, skill `host-service`). |
| **Separate origin** [Internal] | Hosted apps are served on their own port and origin (via `tailscale serve`), so they can't use the portal's session. The portal cookie is stripped and only you can open them (tailnet identity). |
| **Lifecycle** [Internal] | The lead controls a work's services. **Everything a work hosted is stopped when the work is marked done**; services resume after a restart. |
| **Services tab and Overview list** [UI] | Every running service with its link and **Stop**, per room and across all work. |

## 14. Documents, notes and files

| Feature | What it does |
|---|---|
| **Documents** [UI] | Everything agents wrote, across all agents, newest first, with search and filters. Also per room and group (`server/src/documents.ts`). |
| **Document reader** [UI] | Click any file path in a chat, or an attachment link, to open it in the reader: Markdown rendered, code and text shown, **Download PDF** (headless Chromium) or the original (`server/src/pdf.ts`). |
| **Notes** [UI] | See §4. |
| **Safe file serving** [Internal] | Only files under the agents' homes, the work area and the repo maps are served. HTML and SVG are served sandboxed (no scripts against the portal). |

## 15. Visibility: live progress, needs you, activity

| Feature | What it does |
|---|---|
| **Live progress** [UI] | A status line per working agent saying what it's doing now ("Waiting on CI for PR #4984 · 17 min"), expandable to its step log. **Possibly stuck** after 10 minutes without progress, with Stop. Replies stream into the timeline (`server/src/progress.ts`). |
| **Needs you** [UI] | Questions, plans waiting, setup requests, failures and stalls on the Overview, with coloured dots on rooms and groups. Replies are shown as "unread", apart from needs-you. Opening a room marks its items seen (`server/src/attention.ts`). |
| **Overview** [UI] | Needs you, In progress, hosted services, routines running and recently finished work. |
| **Tasks board** [UI] | Every task, running and queued, across all agents. |
| **Activity** [UI] | A live feed and graph of who did what, built from what's recorded (`server/src/activity.ts`). |
| **System page** [UI] | Health of modules, integrations and tools (`server/src/health.ts`). |

## 16. Phone app, push and voice

| Feature | What it does |
|---|---|
| **Android app** [UI] | Overview, rooms and groups with a live timeline, members and documents; New task; routines (active, history, schedules); Pause all. Paired by one-time QR code plus your approval in the portal (Devices page) (`server/src/devices.ts`, `docs/MOBILE-SETUP.md`). |
| **Phone gateway** [Internal] | A separate gateway, tailnet-only, that checks an **Ed25519 signature** on every request within a ±60 s window with no replay, returns an empty 404 for anything else, enforces a route allowlist and keeps a per-device audit (`server/src/mobile.ts`, `signing.ts`). |
| **Push notifications** [UI] | "Needs you" pushes through Expo/FCM: content-free by default, optional details, at most one every 30 s per device (`server/src/push.ts`). |
| **Voice input** [UI] | A mic in every message box. Your device's own speech recognition does the dictation, then a GLM model tidies the text (fillers, jargon, self-corrections, `#1234`). You review it before sending; nothing is sent automatically (`server/src/voice.ts`). |

## 17. Access and security

| Feature | What it does |
|---|---|
| **Access modes** [Internal] | **ssh-tunnel** (localhost only), **tailscale** (your tailnet identity via `tailscale serve`) or **cloudflare** (Cloudflare Access JWT). One decision function judges every request; the remote modes use 8-hour server-side sessions (`server/src/access.ts`, `docs/ACCESS.md`). |
| **Request hardening** [Internal] | Host and Origin checks, JSON-only writes, cross-site requests refused (`Sec-Fetch-Site`), percent-encoded path tricks refused: protection against CSRF and DNS rebinding. |
| **No inbound ports** [Internal] | The portal, screen, terminal, gateway and hosting listen on 127.0.0.1 and are reached only through the access mode (tunnel or tailnet). |
| **Secrets** [Internal] | `/secrets` (0700/0600) can't be read by the portal or the phone, symlinks included. `agentbox secret set` stores values without echoing them, and redaction protects what the helper reads. |
| **Guardrails, not a sandbox** [Internal] | Integration and orchestrator guards, repo and memory guards, routine-rule checks, crew isolation and temporary sudo. All agents run as one unix user, so these are rules enforced before commands run, not OS isolation (`docs/TRUSTED-AUTONOMY.md`). |

## 18. Internal mechanisms

| Mechanism | What it does |
|---|---|
| **Runner** | Queues and runs turns through the Claude Agent SDK, one turn at a time per agent, in order. It builds the instruction layers, enables the assigned skills, wires the MCP tool servers (`team`, `setup`, browser), applies the PreToolUse guards, streams output, records steps, continues past the step limit and routes results back (`server/src/runner.ts`). |
| **Team tool server** | The `mcp__team__*` tools: delegation, messages, roadmaps, plans, repos, memory, setup requests, wake-ups, routines, hosting, linked work, group workspaces and skill proposals (`server/src/team.ts`). |
| **Event bus** | Every change (tasks, messages, steps, agents, crews, notes, links, workspaces, hosting…) is published once. The portal and the phone get it live over a WebSocket (`/api/events`), and lasting events become the activity log (`server/src/bus.ts`). |
| **Database** | SQLite (`node:sqlite`, WAL) with additive migrations at start; a backup is taken before risky migrations (`server/src/db.ts`, `migrate.ts`). |
| **Health and limits** | Cached health checks; capped room and step payloads so large rooms load fast; a tasks-by-thread index. |
| **Local token** | `x-agentbox-local-token` lets on-VM tools (the CLI, `agentbox api`) call the portal without a browser session. It counts as an agent, not as you: agents share the VM and could read it, so owner-only routes refuse it. |

## 19. The command line

`agentbox` is a terminal client for the portal, like the `claude` CLI is for Claude. It calls the same API as the
portal, so anything you can click you can also type (`cli/portal.mjs`, reference in `docs/CLI.md`).

| Feature | What it does |
|---|---|
| **Runs on your computer** [UI] | `cli/install-client.sh` links `agentbox` into your PATH (Node 22+). Run it on your Mac against the cloud VM, the local Lima VM, or both. |
| **Profiles** [UI] | One per agentbox: `agentbox login gcp --url https://<node>.ts.net --default`, `agentbox login local --url http://localhost:8720 --lima <vm>`. Switch with `--profile`, `AGENTBOX_PROFILE` or `agentbox use`. Kept in `~/.config/agentbox/profiles.json` (0600). |
| **Who you are** [Internal] | From your computer you are **the owner**, just like in the browser: your tailnet identity (tailscale mode) or the tunnel's localhost (ssh-tunnel mode). A Lima profile **opens the tunnel itself** when it's closed. On the VM the CLI uses the local token, so owner actions (approvals, reviews, plans, starting setup, purging) are refused there by design. |
| **Dashboard** [UI] | `agentbox` with no arguments: needs you, in progress with live status, running routines and hosted links. Also `needs`, `activity`, `graph`, `health`, `pause`, `resume`. |
| **Start and follow work** [UI] | `agentbox task new --crew software "…"` goes to the crew's lead by default; `--to`, `--repo`, `--link`, `--plan-first` and `-f <file>` (any type) match the New task form, and `-` reads the text from stdin. `work`, `show`, `log`, `send`, `stop`, `done`, `keep`, `rename`. |
| **Live chat** [UI] | `agentbox chat <task\|#group>`: replies stream in as the agent writes, with progress lines, and what you type is sent. Slash commands inside: `/stop /done /attach /note /notes /link /show /roadmap /changes /quit`. `agentbox chat --to <crew\|agent> "…"` starts work and chats straight away; `watch` follows read-only. |
| **Names, not ids** [UI] | Tasks, agents, crews, groups and routines are named the way you'd say them: `coder#3`, part of a title, an id prefix, `#code-quality`. An ambiguous name lists the matches. Most commands take `--json` for scripts. |
| **Review from the terminal** [UI] | `plans` and `plan <id> approve\|changes\|reject`, the per-task `plan-gate`, `changes` (a coloured diff with commits), and `review … --comment path:line=text` for line comments. `roadmap` prints a roadmap as text. |
| **Routines and wake-ups** [UI] | `routine new --cron "0 9 * * 1-5" --prompt @file`, edit, run now, enable or disable, compact or start fresh, run history, `routine preview` for the next run times; `wakeups`. |
| **Team** [UI] | Crews (create, lead, move agents), agents (show, settings, skills, integrations, delete), the **hiring interview** in the terminal (`agent new --interview`), editing a job description in `$EDITOR`, groups and their workspaces, and the skill library with drafts. |
| **Setup** [UI] | `helper "…"` chats with the helper; `helper terminal` **attaches to your setup terminal** on the VM (where logins happen; Ctrl-] detaches). Setup requests, approval cards, integrations and who may use them, repos and their mappers, memory trees, phones, the shared screen, and `api` for any route, raw. |
| **Notes, links, documents** [UI] | `notes`, `note`, `links`, `link`, `docs` (with search), `open <path>` prints a file or saves it with `-o`, `services`. |
| **Sharing** [UI] | `share <task> [--edit] [--for 6h\|1d\|7d] [--name who]` prints a guest link once; `shares <task>` lists them, `share rm <id>` turns one off, `share status` shows the tunnel. |
| **Kept in step with the portal** [Internal] | A test lists every API route the server registers and fails if one has no command. The few left out on purpose (voice, the PDF render, the device bridge's own endpoints, the setup checklist's buttons) are listed with a reason (`cli/test/portal.test.mjs`). |
| **Not in the terminal** | Voice input, and the shared screen itself (`agentbox screen` opens it in your browser). |

## 20. Further reading

| Document | About |
|---|---|
| `docs/V2-ARCHITECTURE.md` | The v2 architecture, setup workspace, integrations, repos and their changes |
| `docs/V2.1-PLAN.md` | Plans, diff review, who does what |
| `docs/TREE-MEMORY.md` | The repo memory tree |
| `docs/HOSTING.md` | Hosting design and security |
| `docs/BENCH.md` | The device bridge |
| `docs/ONSHAPE.md` | The Onshape integration |
| `docs/ACCESS.md` | Access modes and threat model |
| `docs/HELPER-AGENT.md`, `docs/GUIDE.md` | The helper and the guided setup |
| `docs/MODULES.md`, `docs/SETUP-PLAN.md` | Modules and the setup plan |
| `docs/CLI.md` | The agentbox command line |
| `docs/SHARING.md` | Sharing work with a guest: what they see and how it's secured |
| `docs/MOBILE-PROTOCOL.md`, `docs/MOBILE-SETUP.md` | The phone app's protocol and setup |
| `docs/CONTRACTS-v2.md` | API contracts (progress, needs you, voice, push, app, routine runs) |
| `docs/TRUSTED-AUTONOMY.md` | Autonomy research and the guardrail model |
| `docs/UI-DESIGN.md` | Portal design |
| `docs/BACKLOG.md`, `docs/ROADMAP.md` | What's next |
