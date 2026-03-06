# Pixel Agents

Fork-style continuation of [pablodelucca/pixel-agents](https://github.com/pablodelucca/pixel-agents).

A pixel-art control room for your AI coding agents, available both as a VS Code extension and as a standalone macOS menubar app.

Each active Claude Code or Codex session can spawn a character that walks around, sits at desks, and visually reflects what the agent is doing — typing when writing code, reading when searching files, waiting when it needs your attention.

This repository contains the original [Pixel Agents extension for VS Code](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) plus a new standalone desktop host for people who want Pixel Agents running without an IDE.

If you mostly live in Terminal.app, iTerm, Warp, WezTerm, or a pile of shell windows instead of an IDE, this repo is the version built for that workflow.


![Pixel Agents screenshot](webview-ui/public/Screenshot.jpg)

## Fork Lineage

- Upstream project: [pablodelucca/pixel-agents](https://github.com/pablodelucca/pixel-agents)
- This repo keeps the original VS Code extension workflow, but extends it into a standalone macOS desktop app and terminal-first session manager
- GitHub does not currently show this repository as a native fork in the fork network, so the lineage is documented explicitly here and in the repository metadata

## What Changed From Upstream

- Added a standalone macOS menubar app so Pixel Agents can run without VS Code being open
- Added external terminal detection for Claude Code and Codex sessions launched outside the VS Code integrated terminal
- Added a desktop `Terminals` manager for focus, terminate, launch, rename, and reset-to-default session labels
- Default terminal labels now use the detected working directory name when available instead of raw process IDs
- Added richer office customization with room themes, floor/wall material presets, and furniture tint presets
- Added multiple built-in room layout templates, including non-rectangular room shapes
- Default layouts now give each agent a dedicated desk setup with a computer instead of clustering multiple agents around one shared desk
- Added direct dragging for characters so you can move them around the office or drop them onto empty seats
- Preserved the original VS Code extension behavior as the compatibility baseline

## Features

- **One agent, one character** — every active Claude Code or Codex session gets its own animated character
- **Live activity tracking** — characters animate based on what the agent is actually doing (writing, reading, running commands)
- **Standalone macOS menubar app** — run Pixel Agents without VS Code and keep it watching your terminal sessions from the menu bar
- **External terminal support on macOS** — detect Claude Code and Codex sessions running in normal terminal windows outside VS Code
- **Terminal session manager** — inspect detected terminal-backed shell/agent sessions, focus them, and end them from the desktop app
- **Human-readable terminal names** — detected sessions default to their working-folder name and can be renamed or reset from the desktop UI
- **Office layout editor** — design your office with floors, walls, and furniture using a built-in editor
- **Richer room themes** — bundled floor, wall, room, and furniture tint presets make the office easier to personalize quickly
- **Speech bubbles** — visual indicators when an agent is waiting for input or needs permission
- **Sound notifications** — optional chime when an agent finishes its turn
- **Sub-agent visualization** — Task tool sub-agents spawn as separate characters linked to their parent
- **Persistent layouts** — your office design is saved and shared across VS Code windows
- **Diverse characters** — 6 diverse characters. These are based on the amazing work of [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Pixel Agents characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and configured if you want Claude characters
- VS Code 1.109.0 or later if you want to use the extension host
- macOS is currently the only platform with external terminal process tracking

## Getting Started

If you want to hack on the project, run the extension locally, or use the new desktop host from source:

### Install from source

```bash
git clone https://github.com/J0YY/pixel-agents-menubar.git
cd pixel-agents-menubar
npm install
cd webview-ui && npm install && cd ..
npm run build
```

### Run the VS Code extension

Press **F5** in VS Code to launch the Extension Development Host.

### Run the standalone menubar app on macOS

```bash
npm run menubar
```

This starts Pixel Agents as a tray/menubar app with the same office UI, external agent detection, and layout persistence, but without VS Code.

To build a packaged `.app` bundle:

```bash
npm run menubar:pack
```

### Usage

### VS Code mode

1. Open the **Pixel Agents** panel (it appears in the bottom panel area alongside your terminal)
2. Click **+ Agent** to spawn a new Claude Code terminal and its character
3. Start coding with Claude and watch the character react in real time
4. On macOS, external Claude Code and Codex sessions launched from Terminal, iTerm, Warp, or other normal terminal apps will also appear automatically when external tracking is enabled
5. Click a character to select it, then click a seat to reassign it
6. Click **Layout** to open the office editor and customize your space

### Desktop mode

1. Launch `npm run menubar` or open the packaged Pixel Agents app
2. Click the tray/menubar icon to show the office
3. Use **+ Claude** or **+ Codex** to open new agent sessions in Terminal.app
4. Use **Terminals** to inspect detected terminal-backed sessions running on your Mac
5. Focus, rename, reset, or end detected shell/agent sessions directly from the desktop app
6. Close the window to send Pixel Agents back to the menu bar

## Standalone Menubar App

The new desktop host reuses the same agent registry and process/transcript tracking layers as the extension, but runs them under Electron instead of the VS Code extension host.

Desktop mode currently supports:

- Detecting external Claude Code and Codex sessions from ordinary macOS terminal apps
- Launching new Claude, Codex, or plain shell sessions from the menubar UI
- Showing one pixel character per active agent session even when VS Code is closed
- Listing terminal-backed shell/agent sessions in a terminal manager panel
- Focusing a detected session's terminal app
- Terminating a detected shell/agent process from the UI
- Naming sessions by folder by default, with optional custom labels and reset-to-default behavior

Desktop mode currently does **not** try to be a full terminal emulator or universal terminal automation layer. The first pass is a lightweight session manager.

## External Terminal Tracking

Pixel Agents now uses a provider-based agent registry. The existing VS Code Claude integration is still there, and both the extension and the standalone app can watch for external macOS processes and create characters for them.

- **Claude Code in VS Code terminals** — full terminal integration plus transcript watching
- **Claude Code in external macOS terminals** — process detection first, transcript correlation when the session transcript can be found
- **Codex in external macOS terminals** — process detection with a coarse running/idle model

### Settings

Use the standard VS Code settings UI or `settings.json`:

```json
{
  "pixelAgents.externalTracking.enabled": true,
  "pixelAgents.externalTracking.scanIntervalMs": 3000,
  "pixelAgents.externalTracking.enableClaude": true,
  "pixelAgents.externalTracking.enableCodex": true,
  "pixelAgents.externalTracking.enableTranscriptCorrelation": true,
  "pixelAgents.logging.debug": false
}
```

### Privacy Notes

- External tracking inspects the current user's process list on macOS to find likely Claude Code and Codex sessions.
- When transcript correlation is enabled, Pixel Agents may inspect Claude transcript file paths under `~/.claude/projects` to improve activity detection.
- Nothing is sent to a remote service by the extension or desktop app; this is still local observation only.

## Layout Editor

The built-in editor lets you design your office:

- **Floor** — Full HSB color control plus bundled material presets
- **Walls** — Auto-tiling walls with color customization and bundled wall materials
- **Themes** — Room-wide presets for faster office restyling
- **Room layouts** — Built-in layout templates with different room shapes
- **Furniture tints** — Quick tint presets for selected furniture pieces
- **Tools** — Select, paint, erase, place, eyedropper, pick
- **Undo/Redo** — 50 levels with Ctrl+Z / Ctrl+Y
- **Export/Import** — Share layouts as JSON files via the Settings modal

Characters can also be repositioned directly in the office view. Drag a person to an empty floor tile to move them, or drag them onto an empty chair to reassign their seat.
By default, the built-in layouts give each spawned agent a nearby desk and computer station to work at.

The grid is expandable up to 64×64 tiles. Click the ghost border outside the current grid to grow it.

### Office Assets

The office tileset used in this project and available via the extension is **[Office Interior Tileset (16x16)](https://donarg.itch.io/officetileset)** by **Donarg**, available on itch.io for **$2 USD**.

This is the only part of the project that is not freely available. The tileset is not included in this repository due to its license. To use Pixel Agents locally with the full set of office furniture and decorations, purchase the tileset and run the asset import pipeline:

```bash
npm run import-tileset
```

Fair warning: the import pipeline is not exactly straightforward — the out-of-the-box tileset assets aren't the easiest to work with, and while I've done my best to make the process as smooth as possible, it may require some manual tweaking. If you have experience creating pixel art office assets and would like to contribute freely usable tilesets for the community, that would be hugely appreciated.

The extension will still work without the tileset — you'll get the default characters and basic layout, but the full furniture catalog requires the imported assets.

## How It Works

Pixel Agents now has a provider-based backend:

- A **VS Code Claude provider** tracks integrated terminals, launches new Claude sessions, restores them on reload, and follows `/clear` transcript reassignments.
- An **agent registry** is the single source of truth for active visualized agents. It deduplicates overlapping observations, assigns stable visual IDs, and feeds the webview.
- **External Claude** and **external Codex** providers scan macOS processes and register external sessions even when they were not launched from VS Code.
- A reusable **Claude transcript watcher** parses JSONL transcripts for both VS Code and external Claude sessions when transcript files are available.

When a Claude session uses a tool (like writing a file or running a command), the transcript watcher updates the character's animation. Codex currently uses a simpler process-backed state model.

The webview runs a lightweight game loop with canvas rendering, BFS pathfinding, and a character state machine (idle → walk → type/read). Everything is pixel-perfect at integer zoom levels.

## Tech Stack

- **Extension**: TypeScript, VS Code Webview API, esbuild
- **Desktop app**: Electron, TypeScript
- **Webview**: React 19, TypeScript, Vite, Canvas 2D

## Known Limitations

- **Agent-terminal sync is still heuristic in places** — VS Code `/clear` reassignment and transcript discovery still rely on filesystem observation rather than a native Claude API.
- **External Codex observability is coarse** — the first pass only detects active process presence and a simple running/idle state. It does not yet parse Codex-specific logs or transcripts.
- **External Claude transcript correlation is best-effort** — richer external Claude state depends on being able to match a running process to a transcript file. Process counting works even when that correlation fails.
- **macOS-first external support** — external process tracking is currently implemented for macOS. VS Code terminal support remains cross-platform in principle, but the new non-VS-Code process detection path is not implemented for Linux or Windows yet.
- **Desktop terminal control is intentionally narrow** — the menubar app can launch, focus, and terminate detected shell/agent sessions, but it does not yet support generic keystroke injection, tab titles, or deep per-terminal-app controls.

## Roadmap

There are several areas where contributions would be very welcome:

- **Improve agent-terminal reliability** — more robust connection and sync between characters and Claude Code instances
- **Better status detection** — find or propose clearer signals for agent state transitions (waiting, done, permission needed)
- **Community assets** — freely usable pixel art tilesets or characters that anyone can use without purchasing third-party assets
- **Agent creation and definition** — define agents with custom skills, system prompts, names, and skins before launching them
- **Desks as directories** — click on a desk to select a working directory, drag and drop agents or click-to-assign to move them to specific desks/projects
- **Claude Code agent teams** — native support for [agent teams](https://code.claude.com/docs/en/agent-teams), visualizing multi-agent coordination and communication
- **Git worktree support** — agents working in different worktrees to avoid conflict from parallel work on the same files
- **Support for other agentic frameworks** — [OpenCode](https://github.com/nichochar/opencode), or really any kind of agentic experiment you'd want to run inside a pixel art interface (see [simile.ai](https://simile.ai/) for inspiration)

If any of these interest you, feel free to open an issue or submit a PR.

## Contributions

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for instructions on how to contribute to this project.

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Supporting the Project

If you find Pixel Agents useful, consider supporting its development:

<a href="https://github.com/sponsors/pablodelucca">
  <img src="https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github" alt="GitHub Sponsors">
</a>
<a href="https://ko-fi.com/pablodelucca">
  <img src="https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi" alt="Ko-fi">
</a>

## License

This project is licensed under the [MIT License](LICENSE).
