#!/bin/bash
# Package PyroKitty for Linux distribution
# Linux counterpart to package.sh — same step structure, Linux-specific adaptations:
#   - No Firestorm viewer (empty placeholder)
#   - Godot: Linux exe naming (no _console.exe, no .exe extension)
#   - Voice sidecar: linux-x64 dotnet publish
#   - electron-builder: --linux target

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"

# Switch to pinned Node version
_PREV_NODE=""
if [ -f "$ELECTRON_DIR/.nvmrc" ] && command -v nvm &>/dev/null; then
    _PREV_NODE="$(nvm current)"
    nvm install --silent
fi
ROOT_DIR="$(dirname "$ELECTRON_DIR")"

VIEWER_STAGING="$ELECTRON_DIR/viewer"

FORCE_REBUILD=false
OVERRIDE_VERSION=""

show_help() {
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  --force           Force rebuild even if files are up to date"
    echo "  --version X.Y.Z   Set version explicitly"
    echo "  --help            Show this help"
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --force)
            FORCE_REBUILD=true
            shift
            ;;
        --version)
            OVERRIDE_VERSION="$2"
            shift 2
            ;;
        --help|-h)
            show_help
            exit 0
            ;;
        *)
            shift
            ;;
    esac
done

# Helper: check if any source files are newer than target
needs_rebuild() {
    local src_dir="$1"
    local target="$2"
    local pattern="${3:-*}"

    if [ "$FORCE_REBUILD" = true ]; then
        return 0
    fi

    if [ ! -e "$target" ]; then
        return 0
    fi

    if [ -n "$(find "$src_dir" -type f -name "$pattern" -newer "$target" 2>/dev/null | head -1)" ]; then
        return 0
    fi

    return 1
}

# Sync version
if [ -n "$OVERRIDE_VERSION" ]; then
    VERSION="$OVERRIDE_VERSION"
    echo "Using provided version: $VERSION"
else
    echo "Fetching latest release version..."
    LATEST=$(gh release list --limit 1 --json tagName --repo pyrokitty64/pyrokitty-releases -q '.[0].tagName' 2>/dev/null || echo "")
    if [ -z "$LATEST" ]; then
        VERSION="0.1.0"
    else
        VERSION="${LATEST#v}"
    fi
fi

# Update package.json version
cd "$ELECTRON_DIR"
CURRENT_VERSION=$(node -p "require('./package.json').version")
if [ "$CURRENT_VERSION" != "$VERSION" ]; then
    echo "  Updating version: $CURRENT_VERSION -> $VERSION"
    npm version "$VERSION" --no-git-tag-version --allow-same-version
else
    echo "  Version already at $VERSION"
fi

echo ""
echo "=== PyroKitty Linux Packaging Script ==="
echo ""

# Step 0: No Firestorm on Linux — create empty viewer placeholder
echo "Step 0: Skipping Firestorm (not available on Linux)..."
mkdir -p "$VIEWER_STAGING"
echo "  Empty viewer placeholder created."

# Step 1: Build wasm-openjpeg package
echo ""
echo "Step 1: Building wasm-openjpeg..."
WASM_OPENJPEG_DIR="$ROOT_DIR/wasm-openjpeg/packages/2.5.4-decoder"
cd "$WASM_OPENJPEG_DIR"
npm install
npm run build
echo "  wasm-openjpeg built."

# Step 2: Build Electron app
echo ""
echo "Step 2: Building Electron app..."
cd "$ELECTRON_DIR"

# 1b: Build main process
echo "  Building main process..."
npm run build:main

# 1c: Build renderer
echo "  Building renderer..."
npm run build:renderer

# 1d: Build map renderer
echo "  Building map renderer..."
npm run build:map

# 1e: Build GPU texture compressor
echo "  Building GPU compressor..."
npm run build:gpu-compress

# 1f: Build sound player
echo "  Building sound player..."
npm run build:sound-player

# Step 2: No viewer staging on Linux
echo ""
echo "Step 2: Skipping viewer staging (no Firestorm on Linux)."

# Step 3: Stage Godot viewer
echo ""
echo "Step 3: Staging Godot viewer..."

GODOT_SRC="$ROOT_DIR/godot-viewer"
GODOT_STAGING="$ELECTRON_DIR/godot-viewer-staging"

if [ -d "$GODOT_SRC" ]; then
    rm -rf "$GODOT_STAGING"
    mkdir -p "$GODOT_STAGING"

    echo "  Copying Godot engine..."
    GODOT_DIR=$(cat "$GODOT_SRC/godot-version.txt" | tr -d '[:space:]')
    cp -r "$GODOT_SRC/$GODOT_DIR" "$GODOT_STAGING/"

    # Copy version file (read at runtime by godot-bridge.ts to locate the exe)
    cp "$GODOT_SRC/godot-version.txt" "$GODOT_STAGING/"

    echo "  Copying Godot project files..."
    cp "$GODOT_SRC/project.godot" "$GODOT_STAGING/"
    cp "$GODOT_SRC/main.tscn"     "$GODOT_STAGING/"
    cp -r "$GODOT_SRC/src"        "$GODOT_STAGING/"
    cp "$GODOT_SRC/PyroKitty 3D.csproj" "$GODOT_STAGING/"
    [ -d "$GODOT_SRC/data" ]    && cp -r "$GODOT_SRC/data"    "$GODOT_STAGING/"
    [ -d "$GODOT_SRC/addons" ]  && cp -r "$GODOT_SRC/addons"  "$GODOT_STAGING/"
    [ -d "$GODOT_SRC/shaders" ] && cp -r "$GODOT_SRC/shaders" "$GODOT_STAGING/"
    for f in splash.png splash.png.import icon.png icon.png.import openxr_action_map.tres override.vr.cfg; do
        [ -f "$GODOT_SRC/$f" ] && cp "$GODOT_SRC/$f" "$GODOT_STAGING/"
    done

    # Build C# assembly (must happen before Godot import)
    echo "  Building C# assembly..."
    cd "$GODOT_STAGING"
    dotnet build "PyroKitty 3D.csproj" -c Debug
    cd "$ELECTRON_DIR"

    # Run headless import so .godot/imported/ gets populated
    # (OceanFFT compute shaders need this to compile .glsl → SPIR-V)
    # Linux: no _console variant, no .exe — exe name uses .x86_64 suffix
    echo "  Running Godot import pass..."
    GODOT_EXE="$GODOT_STAGING/$GODOT_DIR/${GODOT_DIR/_x86_64/.x86_64}"
    "$GODOT_EXE" --headless --import --path "$GODOT_STAGING" || true
    printf '\033[0m'

    # Remove editor metadata (contains absolute dev paths)
    rm -rf "$GODOT_STAGING/.godot/editor"

    echo "  Godot staging complete: $(du -sh "$GODOT_STAGING" | cut -f1)"
else
    echo "  WARNING: Godot viewer not found at $GODOT_SRC, skipping..."
fi

# Step 4: Stage voice sidecar
echo ""
echo "Step 4: Staging voice sidecar..."

VOICE_STAGING="$ELECTRON_DIR/voice-staging"

if command -v dotnet &>/dev/null; then
    if needs_rebuild "$ELECTRON_DIR/voice" "$VOICE_STAGING/VoiceSidecar" "*.cs"; then
        echo "  Building voice sidecar (linux-x64)..."
        cd "$ELECTRON_DIR/voice"
        dotnet publish -c Release -r linux-x64 --no-self-contained -o "$ELECTRON_DIR/dist/voice"

        rm -rf "$VOICE_STAGING"
        mkdir -p "$VOICE_STAGING"
        cp -r "$ELECTRON_DIR/dist/voice/"* "$VOICE_STAGING/"
        echo "  Voice staging complete: $(du -sh "$VOICE_STAGING" | cut -f1)"
    else
        echo "  Voice staging up to date, skipping..."
    fi
else
    echo "  dotnet not found — creating empty voice-staging placeholder."
    mkdir -p "$VOICE_STAGING"
fi

# Step 5: Strip source maps
echo ""
echo "Step 5: Stripping source maps..."
find "$ELECTRON_DIR/dist" -name "*.map" -delete
echo "  Done."

# Step 6: Install linux-specific sharp binary and package
echo ""
echo "Step 6: Installing sharp linux binary..."
cd "$ELECTRON_DIR"
SHARP_VERSION=$(node -p "require('./node_modules/sharp/package.json').version")
npm install "@img/sharp-linux-x64@$SHARP_VERSION"

echo ""
echo "Step 6b: Packaging with electron-builder (Linux)..."
npx electron-builder --linux

# Step 7: Compress output directory
echo ""
echo "Step 7: Compressing..."
RELEASE_DIR="$ROOT_DIR/../pyrokitty-release"
chmod +x "$RELEASE_DIR/linux-unpacked/PyroKitty.sh"
ARCHIVE="$RELEASE_DIR/PyroKitty-Launcher-${VERSION}-linux.tar.gz"
rm -f "$ARCHIVE"
if command -v pigz &>/dev/null; then
    echo "  Using pigz (parallel)..."
    tar -cf - -C "$RELEASE_DIR" linux-unpacked | pigz -p "$(nproc)" > "$ARCHIVE"
else
    echo "  Using gzip -1 (fast)..."
    tar -czf "$ARCHIVE" --use-compress-program="gzip -1" -C "$RELEASE_DIR" linux-unpacked
fi
echo "  Done: $(du -sh "$ARCHIVE" | cut -f1)  →  $ARCHIVE"

echo ""
echo "=== Linux Packaging Complete ==="

# Restore previous Node version
if [ -n "$_PREV_NODE" ] && command -v nvm &>/dev/null; then
    nvm use "$_PREV_NODE" --silent
fi
