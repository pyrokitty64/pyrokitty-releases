## Godot

Version is set in `godot-viewer/godot-version.txt`.

Run all tests (headless, no window):

```bash
cd godot-viewer && for s in tests/test_*.tscn; do ./Godot_v4.7-dev2_mono_win64/Godot_v4.7-dev2_mono_win64_console.exe --headless --quit-after 5 --scene "$s" 2>&1 | grep -E "passed|failed"; done
```

Test run with window:
```bash
# Using saved account (first account in accounts.json)
cd electron-ui && AUTO_LOGIN=1 npm start &>/dev/null

# Using CLI credentials (--grid defaults to first configured grid)
cd electron-ui && npm start -- --login FirstName LastName password [--grid agni]
```

## Building Firestorm (Windows)

Firestorm source lives in `firestorm/` (indra, autobuild, build scripts).

Configure (with debug symbols for crash analysis)
`cd firestorm && SKIP_NSIS=1 autobuild configure -A 64 -c ReleaseFS_open -- --chan PyroKitty --avx2 --jobs 1 --fmodstudio --package -DLL_TESTS:BOOL=FALSE -DSKIP_DEBUG_SYMBOLS:BOOL=FALSE`

Build
`cd firestorm && SKIP_NSIS=1 SKIP_SYMBOLS=1 autobuild build -A 64 -c ReleaseFS_open --no-configure -- --chan PyroKitty --avx2 --jobs 1 --fmodstudio --package -DLL_TESTS:BOOL=FALSE`

Build with captured output (autobuild spawns a subprocess that bypasses stdout capture - use source instead)

```
cd firestorm/build-vc170-64 && SKIP_NSIS=1 SKIP_SYMBOLS=1 bash -c 'source ../scripts/configure_firestorm.sh --build --jobs 1 --platform windows --avx2 --fmodstudio --package'
```

Build errors are also written to: `firestorm/build-vc170-64/logs/FirestormBuild_win-64.err`

PDB output: `firestorm/build-vc170-64/newview/Release/firestorm-bin.pdb`
WER crash dumps: `%LOCALAPPDATA%\CrashDumps\`


## Compile node-metaverse

```bash
cd ./electron-ui/node-metaverse && npm run build
```

## Firestorm External Login Mode

Launch viewer in external login mode (waits for session handoff via WebSocket):

```bash
./firestorm/build-vc170-64/newview/Release/firestorm-bin.exe --external-login --set PKWebSocketPort 9001
```

Test the handoff with node_metaverse:

```bash
cd electron-ui && npx tsx scripts/test-viewer-handoff.ts
```

## Test Accounts

See `electron-ui/data/accounts.json` for login credentials (BonnieBelle81, BonnieBelle82, ostiabs).

## Architecture Docs

See `docs/architecture/` for system documentation and performance optimizations.

## Avatar Rendering Reference

See `docs/avatar-rendering.md` for skeleton architecture, animation system, shape deformation, coordinate systems, and known issues. **Update this file whenever making avatar rendering changes.**

## Logs

- **Firestorm Viewer**: `%APPDATA%\PyroKitty_x64\logs\PyroKitty.log`
- **Godot Viewer + Electron main process + voice sidecar**: `%APPDATA%\pyrokitty-ui\pyrokitty-<ISO-timestamp>.log` (e.g. `pyrokitty-2026-04-05T22-49-03-410.log`). New file per session. Voice lines prefixed `[VoiceSidecar]`.
- **Godot raw messages**: `%APPDATA%\pyrokitty-ui\godot-messages.log`

## Voice Sidecar

Build: `cd electron-ui/voice && dotnet build`

The voice sidecar (`electron-ui/voice/`) is a C# .NET 8 process using SIPSorcery + Concentus Opus for WebRTC voice. See `docs/architecture/voice-system.md` for architecture details.

## OpenSimulator Reference

Server source at `..\opensim` — useful for understanding server-side handling of agent control flags, physics, and protocol behavior.

## OpenJPEG WASM (J2K decoder)

Fork: `wasm-openjpeg` → `https://github.com/pyrokitty64/openjpeg`

Rebuild WASM (requires podman, uses Emscripten container):

```bash
cd wasm-openjpeg
rm -rf build
MSYS_NO_PATHCONV=1 podman run --rm -v "$(cygpath -w $(pwd)):/openjpegjs" -w /openjpegjs openjpegjsbuild bash -c "scripts/wasm-build.sh"
```

Then rebuild the npm package and reinstall:

```bash
cd wasm-openjpeg/packages/2.5.4-decoder && npm run build
cd electron-ui && npm install @abasb75/jpeg2000-decoder
```

**Gotchas:**

- WASM uses Emscripten's custom `binaryDecode` string encoding (NOT base64). Bundlers (esbuild, tsup) mangle it if they inline the file. The tsup config marks `openjpegjs.js` as external and copies it raw to `dist/`.
- `scripts/wasm-build.sh` line endings must be LF (not CRLF) or the container will fail with "bad interpreter". Fix with `sed -i 's/\r$//' scripts/wasm-build.sh`.
- The Dockerfile's `emscripten/emsdk:latest` base image already has user `emscripten` (UID 1000). Don't try to create another UID 1000.
- SIMD enabled via `-msimd128` on C and CXX flags. Produces ~1200 SIMD instructions in the wavelet/entropy loops.
