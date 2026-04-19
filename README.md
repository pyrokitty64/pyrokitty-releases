# PyroKitty

Join us on the BonnieBots Discord at https://discord.gg/RRCUytaDH6

<img width="1501" height="809" alt="image" src="https://github.com/user-attachments/assets/c6062a1e-0b17-4f1d-aeaa-747915221fce" />

An experimental Second Life / OpenSim viewer that replaces the traditional monolithic C++ viewer architecture with a multi-process stack: **Electron** for account management and UI, **Godot** for 3D rendering, and a heavily modified **Firestorm** as an alternative renderer. Also includes an MCP server so AI coding agents can log in and interact with the virtual world directly.

<img width="1895" height="1001" alt="image" src="https://github.com/user-attachments/assets/5374815c-7b8f-43e0-9009-ada12c3b56ce" />

## I just want to run it

### Windows

Grab a release, unzip with something like [7-Zip](https://www.7-zip.org/download.html), and run.

### Linux

Grab a release, extract into a directory, run the `PyroKitty.sh` script. The script will identify missing dependencies and offer to install (currently only for Ubuntu/Debian/derivatives, Fedora/derivatives, and Arch/derivatives).

An example process:

```bash
# Adjust as needed
pyrodir="/opt/pyrokitty"

sudo mkdir -p "$pyrodir"
sudo chown -R $USER "$pyrodir"

# Optional; use only when upgrading
cd "$pyrodir"
rm -rf *
cd -

# Replace/set $pyrotar to the actual tarball name
tar xvf ~/Downloads/"$pyrotar" -C "$pyrodir" --strip-components=1

# IF AND ONLY IF (1) you have multiple users, and (2) all your users are members of the same $USER_GROUP
sudo chown -R :$USER_GROUP "$pyrodir"
sudo chmod -R g+wX "$pyrodir"
sudo find "$pyrodir" -type d -exec chmod g+s '{}' ';'

# Run -- this will also check for requirements
cd "$pyrodir"
./PyroKitty.sh
```


## I want to build it

There's no one-click build yet. The project has several independent pieces that each need to be built. See `electron-ui/scripts/package.sh` for how the release packaging works, or read on for the individual components.

### Prerequisites

- Node.js 18+
- [Godot 4.7-dev2 Mono](https://godotengine.org/) (version pinned in `godot-viewer/godot-version.txt`)
- .NET 8 SDK (for the voice sidecar)

### Electron UI

```bash
cd electron-ui
npm install
npm run build
npm start           # builds and launches
```

Set `AUTO_LOGIN=1` to skip the login screen during development.

### Godot Viewer

Open `godot-viewer/` in Godot. The engine version must match `godot-viewer/godot-version.txt`.

Place the Godot executable inside `godot-viewer/` in a subdirectory matching the version name. For example:

```
godot-viewer/
  Godot_v4.7-dev2_mono_win64/
    Godot_v4.7-dev2_mono_win64.exe
    Godot_v4.7-dev2_mono_win64_console.exe
    GodotSharp/
```

Run headless tests:

```bash
cd godot-viewer
GODOT=$(cat godot-version.txt | tr -d '[:space:]')
./$GODOT/${GODOT}_console.exe --headless --quit-after 5 --scene tests/test_prim_mesh.tscn
```

### Voice Sidecar

```bash
cd electron-ui/voice
dotnet build
```

WebRTC voice chat using SIPSorcery + Concentus Opus. See `docs/architecture/voice-system.md`.

### SL-MCP Server

```bash
cd sl-mcp
npm run build
```

No separate launch needed — Claude Code starts it automatically via `.mcp.json`.

## Debug Logging (PK_DEBUG)

Both Electron and Godot use tag-based debug logging controlled by the `PK_DEBUG` environment variable. Set it to a comma-separated list of tags, or `all` to enable everything:

```bash
# Enable specific tags
PK_DEBUG=alpha,camera,flexi npm start

# Enable all debug output
PK_DEBUG=all npm start
```

Available tags:

| Tag | Area |
|-----|------|
| `alpha` | Alpha/transparency sorting and material decisions |
| `animation` | Animation fetching, decoding, and batching |
| `animesh` | Animesh skeleton creation and rigged mesh binding |
| `attach` | Attachment point positioning |
| `avatar` | Avatar appearance, bake-on-mesh, shape data |
| `avatarshape` | Avatar shape deformation and body offsets |
| `avatarsit` | Avatar sitting and seat resolution |
| `bctex` | BC-compressed texture loading |
| `camera` | Camera movement, running, double-tap |
| `chat` | Chat message forwarding |
| `env` | Environment/EEP settings |
| `flexi` | Flexi prim simulation |
| `input` | Movement, sit, touch input handling |
| `ipc` | IPC message routing |
| `jointoverride` | Joint position override priority |
| `light` | Light and projector textures |
| `mesh` | Mesh readiness and delivery |
| `object` | Object creation and parenting |
| `selfavatar` | Self-avatar skeleton and animation eval |
| `terrain` | Terrain tile loading |
| `texture` | Texture decode pool scaling |
| `voice` | Voice PTT and sidecar |
| `water` | Water plane and wave parameters |

In Electron code, use `pkDebug(tag, msg)` from `pk-debug.ts`. In GDScript, use `DebugLog.debug(tag, msg)` (an autoload). Use `pkDebugEnabled(tag)` / `DebugLog.enabled(tag)` to guard expensive string formatting.

## What is in here

| Directory | What it does |
|-----------|-------------|
| `electron-ui/` | Electron app — account management, login, UI shell, and the client-side protocol backend (node-metaverse). The brains of the operation. |
| `godot-viewer/` | Godot 4.7 project — 3D rendering, avatar animation, prim meshing. Communicates with Electron over a local bridge. |
| `firestorm/` | Heavily modified Firestorm viewer. Runs in "external login" mode, handing off its session to the Electron/Godot stack. Very experimental. |
| `sl-mcp/` | MCP server that gives AI agents (like Claude) direct control of a Second Life bot — chat, navigation, object manipulation, and more. |
| `docs/` | Architecture docs, rendering notes, and research. |
| `icons/` | App icons. |

## Architecture

```
┌─────────────┐     WebSocket      ┌──────────────┐      WebSocket       ┌──────────────┐
│  Firestorm  │ <────────────────> │  Electron UI │ <──────────────────> │ Godot Viewer │
│  (C++ core) │                    │  (node-meta- │    (textures,        │  (3D render) │
│             │                    │    verse)    │     meshes, anims)   │              │
└─────────────┘                    └──────┬───────┘                      └──────────────┘
                                          │
                                    ┌─────┴──────┐
                                    │ Voice Side-│
                                    │ car (.NET) │
                                    └────────────┘
```

Electron handles the SL protocol via **node-metaverse** (a TypeScript SL client library, bundled with heavy modification). It decodes textures, builds mesh data, manages animations, and streams everything to Godot for rendering. Firestorm is optional — it can hand off an authenticated session so you get the benefit of its mature UDP protocol stack.

## SL-MCP: AI Bot Control

The `sl-mcp/` server exposes 36 tools across session management, chat, navigation, social, object manipulation, and even a minesweeper solver. Configure it in `.mcp.json` and any MCP-compatible agent can walk around, chat, rez prims, and interact with the world.

## License

See [LICENSE](LICENSE). (It's chill.)

