#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# EditFlow AI - CEP Panel Installer for macOS/Linux
# Creates a symbolic link from the Adobe CEP extensions directory
# to the cep-panel folder in this repository.
#
# Usage:
#   chmod +x install_cep.sh
#   ./install_cep.sh          # Install
#   ./install_cep.sh uninstall # Uninstall
# ═══════════════════════════════════════════════════════════════

set -e

# Configuration
EXTENSION_ID="com.editflow.ai"
EXTENSION_NAME="EditFlow AI"

# Find script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CEP_PANEL_DIR="$SCRIPT_DIR/cep-panel"

# macOS Adobe CEP extensions directory
if [[ "$OSTYPE" == "darwin"* ]]; then
    ADOBE_CEP_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
else
    echo "This script is designed for macOS. For Windows, use install_cep_junction.ps1"
    exit 1
fi

TARGET_DIR="$ADOBE_CEP_DIR/$EXTENSION_ID"

echo "=== EditFlow AI - CEP Panel Installer ==="

# Validate
if [ ! -d "$CEP_PANEL_DIR" ]; then
    echo "ERROR: cep-panel directory not found at: $CEP_PANEL_DIR"
    exit 1
fi

if [ ! -f "$CEP_PANEL_DIR/CSXS/manifest.xml" ]; then
    echo "ERROR: manifest.xml not found at: $CEP_PANEL_DIR/CSXS/manifest.xml"
    exit 1
fi

# Uninstall
if [ "$1" = "uninstall" ]; then
    echo "Uninstalling $EXTENSION_NAME..."
    if [ -L "$TARGET_DIR" ]; then
        rm "$TARGET_DIR"
        echo "Removed symlink: $TARGET_DIR"
    elif [ -d "$TARGET_DIR" ]; then
        rm -rf "$TARGET_DIR"
        echo "Removed directory: $TARGET_DIR"
    else
        echo "Extension not installed."
    fi
    exit 0
fi

# Install
echo "Installing $EXTENSION_NAME..."

# Create CEP extensions directory
mkdir -p "$ADOBE_CEP_DIR"

# Remove existing
if [ -L "$TARGET_DIR" ]; then
    rm "$TARGET_DIR"
    echo "Removed existing symlink."
elif [ -d "$TARGET_DIR" ]; then
    rm -rf "$TARGET_DIR"
    echo "Removed existing directory."
fi

# Create symlink
ln -s "$CEP_PANEL_DIR" "$TARGET_DIR"
echo "Created symlink: $TARGET_DIR -> $CEP_PANEL_DIR"

# Enable unsigned extensions
echo ""
echo "Enabling unsigned CEP extensions..."

for version in 11 10 9; do
    defaults write com.adobe.CSXS.$version PlayerDebugMode 1 2>/dev/null && \
        echo "  Set PlayerDebugMode=1 for CSXS.$version" || true
done

echo ""
echo "=== Installation Complete! ==="
echo ""
echo "Next steps:"
echo "1. (Re)start Adobe Premiere Pro"
echo "2. Go to Window > Extensions > EditFlow AI"
echo "3. Make sure the Python backend is running: python run.py"
echo "4. The panel should connect to http://127.0.0.1:8765"
echo ""
echo "To uninstall: ./install_cep.sh uninstall"
