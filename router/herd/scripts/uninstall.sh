#!/bin/sh
# This script uninstalls herd on Linux.
# It removes the binary, systemd service, config.yaml (optional), and herd user and group.

set -eu

red="$( (/usr/bin/tput bold || :; /usr/bin/tput setaf 1 || :) 2>&-)"
plain="$( (/usr/bin/tput sgr0 || :) 2>&-)"

status() { echo ">>> $*" >&2; }
error() { echo "${red}ERROR:${plain} $*"; exit 1; }
warning() { echo "${red}WARNING:${plain} $*"; }

available() { command -v $1 >/dev/null; }

SUDO=
if [ "$(id -u)" -ne 0 ]; then
    if ! available sudo; then
        error "This script requires superuser permissions. Please re-run as root."
    fi

    SUDO="sudo"
fi

configure_systemd() {
    status "Stopping herd service..."
    $SUDO systemctl stop herd

    status "Disabling herd service..."
    $SUDO systemctl disable herd
}
if available systemctl; then
    configure_systemd
fi

if available herd; then
    status "Removing herd binary..."
    $SUDO rm $(which herd)
fi

if [ -f "/usr/share/herd/config.yaml" ]; then
    while true; do
        printf "Delete config.yaml (/usr/share/herd/config.yaml)? [y/N] " >&2
        read answer
        case "$answer" in
            [Yy]* ) 
                $SUDO rm -r /usr/share/herd
                break
                ;;
            [Nn]* | "" ) 
                break
                ;;
            * ) 
                echo "Invalid input. Please enter y or n."
                ;;
        esac
    done
fi

if id herd >/dev/null 2>&1; then
    status "Removing herd user..."
    $SUDO userdel herd
fi

if getent group herd >/dev/null 2>&1; then
    status "Removing herd group..."
    $SUDO groupdel herd
fi
