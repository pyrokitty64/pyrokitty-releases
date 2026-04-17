#!/bin/bash
# Package PyroKitty for distribution
# Run from electron-ui directory

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

# Viewer build output location
VIEWER_BUILD="$ROOT_DIR/firestorm/build-vc170-64/newview/Release"

# Staging directory for viewer files
VIEWER_STAGING="$ELECTRON_DIR/viewer"

# Parse arguments
SKIP_VIEWER_BUILD=false
SKIP_CONFIGURE=false
SKIP_UNREAL=false
NO_FIRESTORM=false
FORCE_REBUILD=false

OVERRIDE_VERSION=""

show_help() {
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  --skip-viewer     Skip building Firestorm (use existing build)"
    echo "  --no-firestorm    Exclude Firestorm entirely (no build, no staging)"
    echo "  --skip-unreal     Skip Unreal viewer cook/package step"
    echo "  --skip-configure  Skip autobuild configure step (just build)"
    echo "  --force           Force rebuild even if files are up to date"
    echo "  --version X.Y.Z   Set version explicitly (skip GitHub fetch)"
    echo "  --help            Show this help"
    echo ""
    echo "Examples:"
    echo "  $0                    Full build (configure + build viewer + package)"
    echo "  $0 --skip-configure   Rebuild viewer without reconfiguring"
    echo "  $0 --skip-viewer      Just package (viewer already built)"
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-viewer)
            SKIP_VIEWER_BUILD=true
            shift
            ;;
        --no-firestorm)
            NO_FIRESTORM=true
            SKIP_VIEWER_BUILD=true
            shift
            ;;
        --skip-unreal)
            SKIP_UNREAL=true
            shift
            ;;
        --skip-configure)
            SKIP_CONFIGURE=true
            shift
            ;;
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
        return 0  # Force rebuild
    fi

    if [ ! -e "$target" ]; then
        return 0  # Target doesn't exist, needs build
    fi

    # Check if any source files are newer than target
    if [ -n "$(find "$src_dir" -type f -name "$pattern" -newer "$target" 2>/dev/null | head -1)" ]; then
        return 0  # Source files are newer
    fi

    return 1  # Up to date
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
        # Strip leading 'v' for package.json (expects X.Y.Z not vX.Y.Z)
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
echo "=== PyroKitty Packaging Script ==="
echo ""

# Step 0: Build Firestorm viewer (unless skipped)
if [ "$SKIP_VIEWER_BUILD" = false ]; then
    echo "Step 0: Building Firestorm viewer..."
    cd "$ROOT_DIR"

    if [ "$SKIP_CONFIGURE" = false ]; then
        echo "  Configuring..."
        cd "$ROOT_DIR/firestorm"
        SKIP_NSIS=1 SKIP_SYMBOLS=1 autobuild configure -A 64 -c ReleaseFS_open -- \
            --chan PyroKitty --avx2 --fmodstudio --package \
            -DLL_TESTS:BOOL=FALSE
    fi

    echo "  Building (this may take a while)..."
    cd "$ROOT_DIR/firestorm/build-vc170-64"
    SKIP_NSIS=1 SKIP_SYMBOLS=1 bash -c 'source ../scripts/configure_firestorm.sh --build --platform windows --avx2 --fmodstudio --package'

    echo "  Viewer build complete."
    echo ""
fi

# Check if viewer build exists (skip when Firestorm excluded entirely)
if [ "$NO_FIRESTORM" = false ] && [ ! -f "$VIEWER_BUILD/firestorm-bin.exe" ]; then
    echo "ERROR: Viewer build not found at $VIEWER_BUILD"
    echo "Run without --skip-viewer to build, or build manually first."
    exit 1
fi

# Step 1: Build Electron app
echo "Step 1: Building Electron app..."
cd "$ELECTRON_DIR"

# 1a: Build node-metaverse (only if source changed)
echo "  Building node-metaverse..."
cd "$ELECTRON_DIR/node-metaverse" && npm install && cd "$ELECTRON_DIR"
npm run build:metaverse

# 1b: Build main process (only if source changed)
echo "  Building main process..."
npm run build:main

# 1c: Build renderer (only if source changed)
echo "  Building renderer..."
npm run build:renderer

# 1d: Build map renderer (only if source changed)
echo "  Building map renderer..."
npm run build:map

# 1e: Build GPU texture compressor (only if source changed)
echo "  Building GPU compressor..."
npm run build:gpu-compress

# 1f: Build sound player (only if source changed)
echo "  Building sound player..."
npm run build:sound-player

# Step 2: Copy viewer to staging
echo ""
echo "Step 2: Copying viewer to staging area..."

if [ "$NO_FIRESTORM" = true ]; then
    echo "  Firestorm excluded (--no-firestorm), skipping viewer staging..."
    rm -rf "$VIEWER_STAGING"
else
    # Check if viewer staging needs update
    NEEDS_STAGING=false
    if [ "$FORCE_REBUILD" = true ]; then
        NEEDS_STAGING=true
    elif [ ! -f "$VIEWER_STAGING/firestorm-bin.exe" ]; then
        NEEDS_STAGING=true
    elif [ "$VIEWER_BUILD/firestorm-bin.exe" -nt "$VIEWER_STAGING/firestorm-bin.exe" ]; then
        NEEDS_STAGING=true
    fi

    if [ "$NEEDS_STAGING" = true ]; then
        rm -rf "$VIEWER_STAGING"
        mkdir -p "$VIEWER_STAGING"

        # Copy viewer executable and required files
        echo "  Copying executables and DLLs..."
        cp "$VIEWER_BUILD"/*.exe "$VIEWER_STAGING/"
        cp "$VIEWER_BUILD"/*.dll "$VIEWER_STAGING/" 2>/dev/null || true

        # Copy required directories
        for dir in app_settings character fonts skins llplugin; do
            if [ -d "$VIEWER_BUILD/$dir" ]; then
                echo "  Copying $dir/..."
                cp -r "$VIEWER_BUILD/$dir" "$VIEWER_STAGING/"
            fi
        done

        # Copy other required files
        for file in featuretable.txt gpu_table.txt ca-bundle.crt; do
            if [ -f "$VIEWER_BUILD/$file" ]; then
                cp "$VIEWER_BUILD/$file" "$VIEWER_STAGING/"
            fi
        done

        echo "  Viewer staging complete: $(du -sh "$VIEWER_STAGING" | cut -f1)"
    else
        echo "  Viewer staging up to date, skipping..."
    fi
fi

# Step 3: Stage Godot viewer
echo ""
echo "Step 3: Staging Godot viewer..."

GODOT_SRC="$ROOT_DIR/godot-viewer"
GODOT_STAGING="$ELECTRON_DIR/godot-viewer-staging"

if [ -d "$GODOT_SRC" ]; then
    rm -rf "$GODOT_STAGING"
    mkdir -p "$GODOT_STAGING"

        # Copy Godot engine
        echo "  Copying Godot engine..."
        GODOT_DIR=$(cat "$GODOT_SRC/godot-version.txt" | tr -d '[:space:]')
        cp -r "$GODOT_SRC/$GODOT_DIR" "$GODOT_STAGING/"

        # Copy version file (read at runtime by godot-bridge.ts to locate the exe)
        cp "$GODOT_SRC/godot-version.txt" "$GODOT_STAGING/"

        # Copy project files (not cache — cache lives in userData at runtime)
        echo "  Copying Godot project files..."
        cp "$GODOT_SRC/project.godot" "$GODOT_STAGING/"
        cp "$GODOT_SRC/main.tscn" "$GODOT_STAGING/"
        cp -r "$GODOT_SRC/src" "$GODOT_STAGING/"
        cp "$GODOT_SRC/PyroKitty 3D.csproj" "$GODOT_STAGING/"
        if [ -d "$GODOT_SRC/data" ]; then
            cp -r "$GODOT_SRC/data" "$GODOT_STAGING/"
        fi
        if [ -d "$GODOT_SRC/addons" ]; then
            cp -r "$GODOT_SRC/addons" "$GODOT_STAGING/"
        fi

        # Copy loose project files (icon, shaders, OpenXR action map)
        for f in splash.png splash.png.import icon.png icon.png.import openxr_action_map.tres override.vr.cfg; do
            if [ -f "$GODOT_SRC/$f" ]; then
                cp "$GODOT_SRC/$f" "$GODOT_STAGING/"
            fi
        done
        if [ -d "$GODOT_SRC/shaders" ]; then
            cp -r "$GODOT_SRC/shaders" "$GODOT_STAGING/"
        fi

        # Build C# assembly (must happen before Godot import)
        echo "  Building C# assembly..."
        cd "$GODOT_STAGING"
        dotnet build "PyroKitty 3D.csproj" -c Debug
        cd "$ELECTRON_DIR"

        # Run headless import so .godot/imported/ gets populated
        # (OceanFFT compute shaders need this to compile .glsl → SPIR-V)
        echo "  Running Godot import pass..."
        GODOT_EXE="$GODOT_STAGING/$GODOT_DIR/${GODOT_DIR}_console.exe"
        "$GODOT_EXE" --import --path "$GODOT_STAGING" || true
        printf '\033[0m'

        # Remove editor metadata (contains absolute dev paths)
        rm -rf "$GODOT_STAGING/.godot/editor"

    echo "  Godot staging complete: $(du -sh "$GODOT_STAGING" | cut -f1)"
else
    echo "  WARNING: Godot viewer not found at $GODOT_SRC, skipping..."
fi

# Step 3b: Package and stage Unreal viewer
echo ""
echo "Step 3b: Packaging Unreal viewer..."

UNREAL_SRC="$ROOT_DIR/unreal-viewer"
UNREAL_STAGING="$ELECTRON_DIR/unreal-viewer-staging"
UE_ROOT="C:/Program Files/Epic Games/UE_5.7"
RUNUAT="$UE_ROOT/Engine/Build/BatchFiles/RunUAT.bat"
UNREAL_ARCHIVE_DIR="$ROOT_DIR/../unreal-viewer-package"
UNREAL_PACKAGE_DIR="$UNREAL_ARCHIVE_DIR/Windows"

if [ "$SKIP_UNREAL" = true ]; then
    echo "  Skipped (--skip-unreal)"
elif [ ! -d "$UNREAL_SRC" ]; then
    echo "  WARNING: Unreal viewer not found at $UNREAL_SRC, skipping..."
elif [ ! -f "$RUNUAT" ]; then
    echo "  WARNING: UE5 not installed at $UE_ROOT, skipping Unreal packaging..."
else
    NEEDS_UNREAL_BUILD=false
    if [ "$FORCE_REBUILD" = true ]; then
        NEEDS_UNREAL_BUILD=true
    elif [ ! -f "$UNREAL_STAGING/UnrealViewer.exe" ]; then
        NEEDS_UNREAL_BUILD=true
    elif needs_rebuild "$UNREAL_SRC/Source" "$UNREAL_STAGING/UnrealViewer.exe" "*.cpp"; then
        NEEDS_UNREAL_BUILD=true
    elif needs_rebuild "$UNREAL_SRC/Source" "$UNREAL_STAGING/UnrealViewer.exe" "*.h"; then
        NEEDS_UNREAL_BUILD=true
    fi

    if [ "$NEEDS_UNREAL_BUILD" = true ]; then
        echo "  Cooking and packaging (Development, Win64)..."
        "$RUNUAT" BuildCookRun \
            -project="$(cygpath -w "$UNREAL_SRC/UnrealViewer.uproject")" \
            -noP4 \
            -platform=Win64 \
            -clientconfig=Development \
            -cook -allmaps -build -stage -pak -archive \
            -archivedirectory="$(cygpath -w "$UNREAL_ARCHIVE_DIR")" \
            -unattended -utf8output

        rm -rf "$UNREAL_STAGING"
        mkdir -p "$UNREAL_STAGING"
        cp -r "$UNREAL_PACKAGE_DIR/"* "$UNREAL_STAGING/"
        echo "  Unreal staging complete: $(du -sh "$UNREAL_STAGING" | cut -f1)"
    else
        echo "  Unreal staging up to date, skipping..."
    fi
fi

# Step 4: Stage voice sidecar
echo ""
echo "Step 4: Staging voice sidecar..."

VOICE_STAGING="$ELECTRON_DIR/voice-staging"

# Build voice sidecar (self-contained publish)
if needs_rebuild "$ELECTRON_DIR/voice" "$VOICE_STAGING/VoiceSidecar.exe" "*.cs"; then
    echo "  Building voice sidecar..."
    cd "$ELECTRON_DIR"
    npm run build:voice

    rm -rf "$VOICE_STAGING"
    mkdir -p "$VOICE_STAGING"
    cp -r "$ELECTRON_DIR/dist/voice/"* "$VOICE_STAGING/"
    echo "  Voice staging complete: $(du -sh "$VOICE_STAGING" | cut -f1)"
else
    echo "  Voice staging up to date, skipping..."
fi

# Step 5: Strip source maps
echo ""
echo "Step 5: Stripping source maps..."
find "$ELECTRON_DIR/dist" -name "*.map" -delete
echo "  Done."

# Step 6: Package with electron-builder
echo ""
echo "Step 6: Packaging with electron-builder..."
cd "$ELECTRON_DIR"
npm run dist

echo ""
echo "=== Packaging Complete ==="

# Restore previous Node version
if [ -n "$_PREV_NODE" ] && command -v nvm &>/dev/null; then
    nvm use "$_PREV_NODE" --silent
fi
