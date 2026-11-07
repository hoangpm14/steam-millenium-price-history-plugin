#!/usr/bin/env bash
set -euo pipefail

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
    printf '%s\n' 'Usage: bash build.sh [--install] [--plugins-dir PATH]' \
        'Build and check Price History. --install also copies it into Millennium:' \
        'if Steam is running it is closed gracefully, updated, and started again.' \
        'Use Git Bash on Windows or Bash on Linux.'
}

install=false
plugins_dir=''
while (($#)); do
    case "$1" in
        --install) install=true; shift ;;
        --plugins-dir)
            (($# >= 2)) && [[ -n "$2" ]] || die '--plugins-dir requires a path.'
            plugins_dir=$2; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "Unknown argument: $1" ;;
    esac
done
[[ -z "$plugins_dir" || "$install" == true ]] || die '--plugins-dir requires --install.'

case "$(uname -s)" in
    MINGW*|MSYS*) platform=windows ;;
    Linux*) platform=linux ;;
    *) die 'Supported platforms: Linux and Windows with Git Bash.' ;;
esac
command -v node >/dev/null || die 'Install Node.js and reopen your terminal.'
command -v npm >/dev/null || die 'Install npm with Node.js and reopen your terminal.'

# Steam folder from the Windows registry (Unix-style path), or empty.
windows_steam_path() {
    local p
    p=$(powershell.exe -NoProfile -NonInteractive -Command '(Get-ItemProperty -LiteralPath "HKCU:\Software\Valve\Steam" -ErrorAction SilentlyContinue).SteamPath')
    p=${p//$'\r'/}
    [[ -n "$p" ]] && cygpath -u "$p"
}

steam_running() {
    if [[ "$platform" == windows ]]; then
        local running
        running=$(powershell.exe -NoProfile -NonInteractive -Command 'if (Get-Process steam -ErrorAction SilentlyContinue) { "running" }')
        [[ "$running" == *running* ]]
    else
        local status=0
        pgrep -x steam >/dev/null || status=$?
        case "$status" in
            0) return 0 ;;
            1) return 1 ;;
            *) die 'Could not check whether Steam is running.' ;;
        esac
    fi
}

if "$install"; then
    if [[ "$platform" == windows ]]; then
        command -v powershell.exe >/dev/null || die 'PowerShell is needed to find and restart Steam.'
        steam_path=$(windows_steam_path) || true
        steam_cmd=()
        [[ -n "$steam_path" && -f "$steam_path/steam.exe" ]] && steam_cmd=("$steam_path/steam.exe")
        if [[ -z "$plugins_dir" ]]; then
            ((${#steam_cmd[@]})) || die 'Steam was not found in the Windows registry. Supply --plugins-dir PATH.'
            [[ -d "$steam_path/millennium" ]] || die 'Install Millennium into Steam first, or supply --plugins-dir PATH.'
            plugins_dir="$steam_path/millennium/plugins"
        else
            plugins_dir=$(cygpath -u "$plugins_dir")
        fi
    else
        command -v pgrep >/dev/null || die 'Install procps (pgrep) to check whether Steam is running.'
        # Native Steam, or the Flatpak (whose data lives under ~/.var/app).
        steam_cmd=()
        data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
        if command -v steam >/dev/null; then
            steam_cmd=("$(command -v steam)")
        elif command -v flatpak >/dev/null && flatpak info com.valvesoftware.Steam >/dev/null 2>&1; then
            steam_cmd=(flatpak run com.valvesoftware.Steam)
            data_home="$HOME/.var/app/com.valvesoftware.Steam/data"
        fi
        if [[ -z "$plugins_dir" ]]; then
            plugins_dir="$data_home/millennium/plugins"
            [[ -d "${plugins_dir%/plugins}" ]] || die 'Millennium data directory was not found. Install Millennium first, or supply --plugins-dir PATH.'
        fi
    fi
    # Resolve relative destinations before changing into the source folder.
    [[ "$plugins_dir" == /* ]] || plugins_dir="$PWD/$plugins_dir"
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ ! -d node_modules/@steambrew/starlight ]]; then
    npm install
fi
npm run typecheck
node tests/ffi_test.cjs
if command -v luajit >/dev/null; then
    luajit tests/backend_test.lua backend/main.lua
else
    printf 'Lua backend test skipped (LuaJIT not installed; see the main README).\n'
fi
npm run build
artifact="$PWD/dist/com.hoangpm14.price-history.star"
[[ -f "$artifact" ]] || die "Build output was not found: $artifact"
printf 'Built: %s\n' "$artifact"

"$install" || exit 0

was_running=false
if steam_running; then
    was_running=true
    ((${#steam_cmd[@]})) || die 'Steam is running but its executable was not found, so it cannot be restarted. Exit Steam and run this again.'
    printf 'Steam is running; closing it...\n'
    "${steam_cmd[@]}" -shutdown >/dev/null 2>&1 &
    for ((attempt=0; attempt<60; attempt++)); do
        sleep 1
        steam_running || break
    done
    steam_running && die 'Steam did not exit within 60 seconds. Close any games or Steam dialogs and retry. Plugin was not copied.'
else
    printf 'Steam is not running.\n'
fi

mkdir -p -- "$plugins_dir"
cp -- "$artifact" "$plugins_dir/"
printf 'Installed into: %s\n' "$plugins_dir"

if "$was_running"; then
    if [[ "$platform" == windows ]]; then
        PRICE_HISTORY_STEAM_EXE=$(cygpath -w "${steam_cmd[0]}") powershell.exe -NoProfile -NonInteractive -Command \
            '$ErrorActionPreference = "Stop"; Start-Process -FilePath $env:PRICE_HISTORY_STEAM_EXE'
    else
        nohup "${steam_cmd[@]}" >/dev/null 2>&1 </dev/null &
    fi
    printf 'Steam restarted with the updated plugin.\n'
else
    printf 'Start Steam to load the plugin.\n'
fi
