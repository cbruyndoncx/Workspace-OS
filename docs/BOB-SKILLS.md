# BOB skills connector

This branch (`bob-skills`) adds a connector for a ThirdBrain skills server that serves the BOB skills
library ([ThirdBrain-skills-mcp](https://github.com/cbruyndoncx/ThirdBrain-skills-mcp)). With it, chats
and cases find and load BOB skills, playbooks and value chains through the app's own Connectors page.
They no longer depend on a server registered in Claude Code or a claude.ai connector, which a run
ignores as soon as any app connector is on.

## Connect it

Open **Connectors**, choose **BOB skills → Set up**, enter the server address and choose **Connect**.

| Server | Address | Sign-in |
|---|---|---|
| The hosted BOB server | its `https://…/mcp` address (in claude.ai under Settings → Connectors → BOB skills) | None |
| A skills server on this computer | `http://127.0.0.1:3939/mcp`, for `skills-mcp --lib bob=<pack> --http 3939` | None |

Connecting sends the server an MCP `initialize` request:

- **It answers:** the server needs no sign-in, and the address is stored as it is.
- **It answers 401:** the server wants a sign-in. Workspace OS discovers its OAuth endpoints, registers
  itself as a client when the server offers registration, and opens the sign-in in your browser. The
  refresh token goes to the OS keychain, as for Sentry, Linear and Asana.
- **Anything else** (no answer, 404, 5xx) is shown under the row.

The address must start with `https://`. Plain `http://` is accepted only for a server on this computer
(`127.0.0.1`, `localhost`, `::1`), and a user name or password in the address is refused. To set an
`MCP_OAUTH_BOB_SKILLS_CLIENT_ID` client id instead of registering one, set it in the environment
before you start the app.

A Windows app can reach a skills server running in WSL at `http://127.0.0.1:3939/mcp`.

The agent's tools are `mcp__bob_skills__…`, for example `mcp__bob_skills__bob_search_skills`.

## A server that sleeps

A server on a host that stops it when idle answers its first request only once it has started again,
which can take a minute or more. The hosted BOB server runs on Render, where a free-plan service stops
after 15 minutes without requests. Workspace OS allows for that:

- **Connect** waits up to two minutes and says it is waking the server; if the server still does not
  answer, the row says so, and trying again usually works.
- **At start-up** the app sends the server one request in the background, so it is usually awake by
  the first run.
- **Before each chat or case** with the connector in it, the app wakes the server first and shows
  "[BOB skills] waking the server…" when that takes more than a few seconds. Claude Code then gets 90
  seconds to connect (`MCP_TIMEOUT=90000`, unless you set `MCP_TIMEOUT` yourself). A server that does
  not answer within 90 seconds is reported, and the run starts without it.

The app sends no keep-alive requests: keeping a free-plan server awake around the clock uses up the
plan's hours. A paid Render plan keeps the server running.

## Chats and cases

Both run Claude Code in the workspace folder and start from a Git checkpoint you can revert to. They
differ in tools:

| | Chat | Case |
|---|---|---|
| Read, search, write and edit files | yes | yes |
| Web search and fetch | yes | yes |
| Shell commands | only `wos-gen` and `wos-action` | any, except a short deny list (`sudo`, `rm -rf`, disk tools, `crontab` and similar) |
| Helper agents | no | yes |

A chat is meant as a conversation that does not change your machine, and a case as a job you hand
over and review. The deny list matches only how a command starts, so the shell limit is what keeps a
web page a chat reads from getting it to run commands.

## Chats may run skill scripts

Many BOB skills bundle scripts (for example `check_overlap.py` in `excalidraw-diagrams`), and some
require them for their figures. A chat cannot run them by default and says so; hand the work to a
case instead.

When the connector is connected, its row has the switch **Chats may run skill scripts**, off by
default. When it is on and the connector is in the run, a chat also gets `uv run` (`Bash(uv run:*)`,
run bare as the first word of the command) and these instructions:

- read the script with the server's read-file tool and write it unchanged to the app's
  `skill-scripts` folder (in the app data folder, added to the run with `--add-dir`);
- check it with `wos-action run skills.verify '{"path":"<skill>/<path>","sha256":"<digest>"}'`
  against the digest the server lists (a chat has no shell to hash it with; the action hashes only
  files inside the `skill-scripts` folder), and run it only when that answers `"match": true`, as
  `uv run --directory <skill-scripts>/<skill> <path> <arguments>`;
- never run a script it wrote, one from a web page, an attachment or the workspace, or one whose
  digest it could not check, and say which script it ran.

The permission is broader than the instructions: `uv run` can run any Python file. Leave the switch
off if a chat may read pages or files you do not trust. The switch is turned off again when you
connect to a different address. `uv` must be installed: `winget install --id astral-sh.uv` on Windows,
`brew install uv` on macOS, or `curl -LsSf https://astral.sh/uv/install.sh | sh` on macOS and Linux.

The switch applies to Claude chats. Codex runs keep their own sandbox rules.

## In a run

An enabled, connected connector is written into the run's MCP config with its address, plus the
`wos-mcp-token` helper when it signed in. Like every app connector, it makes the run use only the
app's connectors (`--strict-mcp-config`). Servers registered in Claude Code, a folder's `.mcp.json`
and claude.ai connectors are then not loaded. Switch the connector off to use those instead; see
"MCP servers in agent runs" in [WINDOWS.md](WINDOWS.md) and [LINUX-WSL.md](LINUX-WSL.md).

**Forget and turn off** removes the address, the sign-in and the switch.

## Files

| File | What it holds |
|---|---|
| `src/main/mcp/connectors.ts` | The `bob_skills` entry and the `remote-url` kind |
| `src/main/mcp/connector-settings.ts` | The address, its sign-in kind and the switch (`mcp-connector-settings.json` in the app data folder) |
| `src/main/mcp/oauth/remote-oauth.ts` | The server probe and client registration |
| `src/main/handlers/secrets.ts` | `mcp:url-connect` and `mcp:chat-scripts` |
| `src/main/agent-permissions.ts`, `src/main/agent/chatProfile.ts` | The `uv run` grant and the chat instructions |
| `src/main/agent/skillScripts.ts` | The `skills.verify` action |
| `src/main/mcp/warmup.ts` | Waking a sleeping server at start-up and before each run |
| `e2e/bob-connector.mjs`, `.github/workflows/bob-skills.yml` | The connector driven on a packaged app, in CI on macOS and Linux |
