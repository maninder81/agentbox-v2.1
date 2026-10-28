# The agentbox command line

`agentbox` does from a terminal everything the portal does: start and follow work, chat with agents live,
run routines, run groups and crews, manage agents and skills, set things up, and decide approvals,
plans and reviews. It runs **on your own computer**, against any number of agentboxes (profiles), and
**on the VM**, where it's also the system tool (modules, config, updates).

The CLI calls the same API as the portal. A coverage test (`cli/test/portal.test.mjs`) fails the build if
the portal gains a route that has no command and no stated reason. That keeps "everything the GUI
does" true.

## Install (your computer)

You need Node 22 or newer.

```sh
cli/install-client.sh                 # installs its one dependency, links agentbox into /opt/homebrew/bin (or /usr/local/bin, ~/.local/bin)
agentbox login gcp --url https://<node>.<tailnet>.ts.net --default
agentbox login local --url http://localhost:8720 --lima agentbox-v2-test --lima-home /Volumes/External/lima
agentbox profiles
```

Profiles are kept in `~/.config/agentbox/profiles.json` (0600). Pick one per command with
`--profile <name>` (or `AGENTBOX_PROFILE`), or set the default with `agentbox use <name>`.

## Who you are to the portal

| Where | How it signs in | What it may do |
|---|---|---|
| Your computer, **tailscale** mode | Your tailnet identity (via `tailscale serve`), as in the browser. Your computer must be on the tailnet. | Everything, as the owner |
| Your computer, **ssh-tunnel** mode | The tunnel's localhost. A `--lima <vm>` profile opens the tunnel itself when the port is closed. | Everything, as the owner |
| **The VM** itself | The local token | Agent-level only. Agents share that machine and could read the token, so owner actions (approvals, reviews, plans, starting setup, purging…) are refused there. Run those from your computer. |

## Naming things

Tasks, agents, crews, groups and routines are named the way you'd say them:
- an instance name: `coder#3`
- a task's title or part of it: `"login retry"`
- an id or id prefix: `3a67cf`
- a group: `#code-quality`

An ambiguous name lists the matches. Most commands take `--json` for scripts.

## Commands

### Overview
| Command | |
|---|---|
| `agentbox` | Dashboard: needs you, in progress, live status, running routines, hosted links |
| `agentbox needs [--all]` · `needs seen <id>\|--all` | The "needs you" items (and unread replies) |
| `agentbox activity [--n 30]` · `graph` | Who did what; the delegation graph |
| `agentbox pause [--keep-running]` · `resume` · `control` | Pause all, resume, current state |
| `agentbox health` · `whoami` | VM health; which portal and identity |

### Work
| Command | |
|---|---|
| `agentbox task new [--crew c] [--to agent] [--title t] [--repo r]… [--link work]… [--plan-first] [-f file]… "text"` | Start work: the crew's lead by default. Text can be `-` for stdin; files of any type are attached |
| `agentbox work [--done]` · `show <task>` · `log <task>` | Work in progress or finished; one room (members, roadmap, links, notes, hosted links, latest messages); its conversation |
| `agentbox chat <task\|#group>` | **Live chat**: streams replies and progress, and sends what you type. `/stop /done /attach <file> /note <text> /notes /link <work> /show /roadmap /changes /quit`; end a line with `\` to continue it |
| `agentbox chat --to <crew\|agent> "first message"` | Start work and chat straight away |
| `agentbox watch <task\|#group>` | Follow live, read-only |
| `agentbox send <task\|#group> [-f file]… "text"` | One message |
| `agentbox stop <task>` · `done <task>` · `keep <task> [--off]` · `rename <task> <title>` | Stop what's running; finish the work; keep a finished room listed; rename |
| `agentbox notes <task>` · `note <task> "text"` · `note edit\|rm <id>` | The work's notebook |
| `agentbox links <task>` · `link <task> <other work>` · `link rm …` | Linked work (read-only access to other work) |
| `agentbox services [<task>]` · `services stop <name>` | What agents host, with links |
| `agentbox docs [<task\|#group>] [--q text]` · `open <path> [-o file]` | Documents; print one, or save any file |
| `agentbox share <task> [--edit] [--for 6h\|1d\|7d] [--name who]` · `shares <task> [--all]` · `share rm <id>` · `share status` | A link to this work for a guest outside your tailnet (read, or chat with `--edit`), shown once; the live links; turn one off; the ngrok tunnel (`docs/SHARING.md`) |

### Plans, changes, roadmaps
| Command | |
|---|---|
| `agentbox roadmap <task\|#group> [--archived]` · `roadmap archive <id> [--undo]` | Roadmaps as text (a group shows its workspaces' roadmap) |
| `agentbox plans <task>` · `plan <id> [show]` · `plan <id> approve\|changes\|reject [-m note]` | Plans and your decision |
| `agentbox plan-gate <task> on\|off` | "Approve a plan first" for that work |
| `agentbox changes <task> [--stat]` | The diff the work made in its repos (coloured, with commits) |
| `agentbox review <task> approve\|changes\|reject [-m note] [--comment path:line=text]…` | Your review, with line comments |

### Routines
| Command | |
|---|---|
| `agentbox routines` · `routine show <r>` | Routines, and one with its recent runs |
| `agentbox routine new --agent a --name n --cron "0 9 * * 1-5" [--tz zone] [--fresh] [--off] --prompt <text\|@file\|->` | Create one |
| `agentbox routine edit <r> [--name] [--cron] [--tz] [--prompt] [--agent] [--fresh\|--continue]` | Change it |
| `agentbox routine run\|enable\|disable\|compact\|fresh\|rm <r>` | Run now, switch it on or off, compact or reset its context, delete it |
| `agentbox routine runs [<r>] [--active]` · `routine run-show <id>` · `routine preview "<cron>" [--tz]` | Run history; one run; the next run times |
| `agentbox wakeups` · `wakeups cancel <id>` | One-time wake-ups agents set |

### Team
| Command | |
|---|---|
| `agentbox crews` · `crew new <name> [--summary] [--members a,b]` · `crew rename\|summary\|lead\|move\|rm …` | Crews: separate teams |
| `agentbox agents` · `tasks [--agent a]` | Agents (crew, model, live tasks); live tasks |
| `agentbox agent show <a> [--instructions]` · `agent edit <a>` | An agent; edit its job description in `$EDITOR` |
| `agentbox agent new --interview [--crew c]` | The hiring interview in the terminal: core questions, follow-ups, a drafted job description to review or edit |
| `agentbox agent new --name n --title t --from CLAUDE.md [--crew c] [--skills a,b] [--model m] [--lead]` | From a file |
| `agentbox agent set <a> [--title] [--summary] [--model] [--max-turns] [--replicas] [--lead\|--no-lead] [--crew c\|none]` | Settings |
| `agentbox agent skills <a> a,b` · `agent integrations <a> github,aws` · `agent reset <task>` · `agent rm <a>` | Skills, integrations, a fresh conversation, delete |
| `agentbox groups` · `group new <name> --members a,b [--lead a] [--purpose …]` · `group edit\|rm\|post\|continue\|workspaces …` | Groups, and the workspaces their lead launched |
| `agentbox skills [drafts]` · `skill show\|edit\|rm <name>` · `skill new <name> --description d --from SKILL.md [--agents a,b]` · `skill draft show\|approve\|reject <id>` | The skill library |

### Setup
| Command | |
|---|---|
| `agentbox helper "what you need"` | Ask the helper: a live chat |
| `agentbox helper terminal` | Attach to **your** setup terminal on the VM, where logins happen (like ssh; Ctrl-] detaches). From your computer only |
| `agentbox setup requests [--all]` · `setup start\|reject <id>` · `setup done\|failed <id> [-m note]` · `setup checklist` | Agents' setup requests; the helper's checklist |
| `agentbox approvals [--all]` · `approval show\|approve\|reject\|undo <id>` | The helper's team-change cards |
| `agentbox integrations` · `integration-roles <id> a,b` · `connect <id> [--reconnect\|--disconnect]` | The catalog and who may use each; have the helper connect one |
| `agentbox repos` · `repo-set <repo> [--mapper a\|helper] [--roles …] …` · `repo-admin add\|fetch\|map\|archive\|purge\|retry\|discard\|map-routine …` | Repos, who maps them, their rules |
| `agentbox memory [check]` | Repo memory trees |
| `agentbox devices [pair\|approve\|revoke\|test-push …]` · `screen [take\|release]` | Phones; the shared screen (opens it in your browser) |
| `agentbox api [-X METHOD] [-d JSON] <path>` | Any API route, raw |

On your computer, `agentbox repo …` means the portal's repo admin. On the VM, `repo`, `integration`,
`status`, `module`, `config`, `secret`, `update`, `start`, `stop` and `restart` are the system commands
(`agentbox help`). `agentbox stop <task>` with a task stops that task; plain `agentbox stop` stops the
VM's services.

## In the terminal instead of the browser
- **Screen:** `agentbox screen` opens it in your browser.
- **Voice:** not in the terminal.
- **Reader and PDF:** `open` prints text, or saves with `-o`.
- **Diff review:** line comments go with `--comment path:line=text`.
