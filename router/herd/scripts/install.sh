#!/bin/sh
# This script installs herd on Linux.
# It detects the current operating system architecture and installs the appropriate version of herd.

set -eu

HERD_DEFAULT_ADDRESS=${HERD_DEFAULT_ADDRESS:-"127.0.0.1:8080"}

red="$( (/usr/bin/tput bold || :; /usr/bin/tput setaf 1 || :) 2>&-)"
plain="$( (/usr/bin/tput sgr0 || :) 2>&-)"

status() { echo ">>> $*" >&2; }
error() { echo "${red}ERROR:${plain} $*"; exit 1; }
warning() { echo "${red}WARNING:${plain} $*"; }

available() { command -v "$1" >/dev/null; }
require() {
    _MISSING=''
    for TOOL in "$@"; do
        if ! available "$TOOL"; then
            _MISSING="$_MISSING $TOOL"
        fi
    done

    echo "$_MISSING"
}

SUDO=
if [ "$(id -u)" -ne 0 ]; then
    if ! available sudo; then
        error "This script requires superuser permissions. Please re-run as root."
    fi

    SUDO="sudo"
fi

NEEDS=$(require tee tar python3 mktemp)
if [ -n "$NEEDS" ]; then
    status "ERROR: The following tools are required but missing:"
    for NEED in $NEEDS; do
        echo "  - $NEED"
    done
    exit 1
fi

[ "$(uname -s)" = "Linux" ] || error 'This script is intended to run on Linux only.'

ARCH=$(uname -m)
case "$ARCH" in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) error "Unsupported architecture: $ARCH" ;;
esac

IS_WSL2=false

KERN=$(uname -r)
case "$KERN" in
    *icrosoft*WSL2 | *icrosoft*wsl2) IS_WSL2=true;;
    *icrosoft) error "Microsoft WSL1 is not currently supported. Please use WSL2 with 'wsl --set-version <distro> 2'" ;;
    *) ;;
esac

download_binary() {
    ASSET_NAME="linux_$ARCH"

    TMPDIR=$(mktemp -d)
    trap 'rm -rf "${TMPDIR}"' EXIT INT TERM HUP
    PYTHON_SCRIPT=$(cat <<EOF
import os
import json
import sys
import urllib.request

ASSET_NAME = "${ASSET_NAME}"

with urllib.request.urlopen("https://api.github.com/repos/mostlygeek/herd/releases/latest") as resp:
    data = json.load(resp)
    for asset in data.get("assets", []):
        if ASSET_NAME in asset.get("name", ""):
            url = asset["browser_download_url"]
            break
    else:
        print("ERROR: Matching asset not found.", file=sys.stderr)
        exit(1)

print("Downloading:", url, file=sys.stderr)
output_path = os.path.join("${TMPDIR}", "herd.tar.gz")
urllib.request.urlretrieve(url, output_path)
print(output_path)
EOF
)

    TARFILE=$(python3 -c "$PYTHON_SCRIPT")
    if [ ! -f "$TARFILE" ]; then
        error "Failed to download binary."
    fi

    status "Extracting to /usr/local/bin"
    $SUDO tar -xzf "$TARFILE" -C /usr/local/bin herd
}
download_binary

configure_systemd() {
    if ! id herd >/dev/null 2>&1; then
        status "Creating herd user..."
        $SUDO useradd -r -s /bin/false -U -m -d /usr/share/herd herd
    fi
    if getent group render >/dev/null 2>&1; then
        status "Adding herd user to render group..."
        $SUDO usermod -a -G render herd
    fi
    if getent group video >/dev/null 2>&1; then
        status "Adding herd user to video group..."
        $SUDO usermod -a -G video herd
    fi
    if getent group docker >/dev/null 2>&1; then
        status "Adding herd user to docker group..."
        $SUDO usermod -a -G docker herd
    fi

    status "Adding current user to herd group..."
    $SUDO usermod -a -G herd "$(whoami)"

    if [ ! -f "/usr/share/herd/config.yaml" ]; then
        status "Creating default config.yaml..."
        cat <<EOF | $SUDO -u herd tee /usr/share/herd/config.yaml >/dev/null
# default 15s likely to fail for default models due to downloading models
healthCheckTimeout: 60

models:
  "qwen2.5":
    cmd: |
      docker run
        --rm
        -p \${PORT}:8080
        --name qwen2.5
      ghcr.io/ggml-org/llama.cpp:server
        -hf bartowski/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M
    cmdStop: docker stop qwen2.5

  "smollm2":
    cmd: |
      docker run
        --rm
        -p \${PORT}:8080
        --name smollm2
      ghcr.io/ggml-org/llama.cpp:server
        -hf bartowski/SmolLM2-135M-Instruct-GGUF:Q4_K_M
    cmdStop: docker stop smollm2
EOF
    fi

    status "Creating herd systemd service..."
    cat <<EOF | $SUDO tee /etc/systemd/system/herd.service >/dev/null
[Unit]
Description=herd
After=network.target

[Service]
User=herd
Group=herd

# set this to match your environment
ExecStart=/usr/local/bin/herd --config /usr/share/herd/config.yaml --watch-config -listen ${HERD_DEFAULT_ADDRESS}

Restart=on-failure
RestartSec=3
StartLimitBurst=3
StartLimitInterval=30

[Install]
WantedBy=multi-user.target
EOF
    SYSTEMCTL_RUNNING="$(systemctl is-system-running || true)"
    case $SYSTEMCTL_RUNNING in
        running|degraded)
            status "Enabling and starting herd service..."
            $SUDO systemctl daemon-reload
            $SUDO systemctl enable herd

            start_service() { $SUDO systemctl restart herd; }
            trap start_service EXIT
            ;;
        *)
            warning "systemd is not running"
            if [ "$IS_WSL2" = true ]; then
                warning "see https://learn.microsoft.com/en-us/windows/wsl/systemd#how-to-enable-systemd to enable it"
            fi
            ;;
    esac
}

if available systemctl; then
    configure_systemd
fi

install_success() {
    status "The herd API is now available at http://${HERD_DEFAULT_ADDRESS}"
    status 'Customize the config file at /usr/share/herd/config.yaml.'
    status 'Install complete.'
}

# WSL2 only supports GPUs via nvidia passthrough
# so check for nvidia-smi to determine if GPU is available
if [ "$IS_WSL2" = true ]; then
    if available nvidia-smi && [ -n "$(nvidia-smi | grep -o "CUDA Version: [0-9]*\.[0-9]*")" ]; then
        status "Nvidia GPU detected."
    fi
    exit 0
fi

install_success
