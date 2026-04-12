#!/usr/bin/env bash
DIR="$(dirname "$(readlink -f "$0")")"

# Both Godot (.NET build) and the voice sidecar require .NET 8+.
function dotnet_vermaj() {
    local -a vermaj
    if command -v dotnet &> /dev/null; then
        vermaj=($(
            dotnet --list-runtimes 2> /dev/null |
            awk '$1 == "Microsoft.NETCore.App" {sub(/\..*/, "", $2) ; print $2}' |
            sort -nur
        ))
    fi
    echo "${vermaj[0]:-0}"
}

function check_dotnet() {
    if (( $(dotnet_vermaj) >= 8 )); then
        return 0
    fi

    local answer
    echo ""
    echo "PyroKitty requires the .NET 8+ runtime, which was not found on your system."
    echo ""
    echo "Install it with one of the following:"
    echo "  Ubuntu/Debian:  sudo apt install dotnet-runtime-10.0"
    echo "  Fedora:         sudo dnf install dotnet-runtime-10.0"
    echo "  Arch:           sudo pacman -S dotnet-runtime-10.0"
    echo "  Other:          https://dotnet.microsoft.com/download/dotnet/8.0"
    echo ""
    read -rp "Would you like to try installing now? [y/N] " answer
    if [[ ${answer^^} != Y* ]]; then
        echo "Please install the .NET 8+ runtime and try again."
        exit 1
    fi

    if command -v apt &>/dev/null; then
        sudo apt install -y dotnet-runtime-10.0
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y dotnet-runtime-10.0
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm dotnet-runtime-10.0
    else
        echo "Could not detect your package manager. Please install .NET 8+ manually."
        exit 1
    fi

    # Verify it installed successfully
    if (( $(dotnet_vermaj) < 8 )); then
        echo "Installation failed. Please install .NET 8+ manually and try again."
        exit 1
    fi

    echo ".NET 8+ runtime installed successfully."
    return 0
}

check_dotnet
exec "$DIR/pyrokitty-ui" --no-sandbox "$@"
