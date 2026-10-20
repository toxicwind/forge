#!/usr/bin/env python3
"""
Autonomous post-build subcommand -> macro generator for beellama vs turboquant llama-server.
Parses llama-server --help, extracts flags, and updates herd.yaml with generated macros.
"""

import os
import re
import subprocess
import sys
import yaml
import argparse

DEFAULT_SERVER_BIN = "/home/toxic/estate/engines/herd/beellama.cpp/build-cuda86/bin/llama-server"
DEFAULT_CONFIG_PATH = os.path.expanduser("/home/toxic/estate/config/herd.yaml")

def extract_flags(binary_path):
    if not os.path.exists(binary_path):
        print(f"Warning: Binary {binary_path} not found. Using fallback parsing.")
        return []
    
    try:
        res = subprocess.run([binary_path, "--help"], capture_output=True, text=True, timeout=5)
        output = res.stdout + res.stderr
    except Exception as e:
        print(f"Error running binary --help: {e}")
        return []

    flags = set()
    # Match flags like --some-flag, -s, etc.
    pattern = re.compile(r'(?:^|\s)(--?[a-zA-Z0-9_-]+)')
    for line in output.splitlines():
        for match in pattern.findall(line):
            flags.add(match)
    return sorted(list(flags))

def main():
    parser = argparse.ArgumentParser(description='Generate subcommand macros for llama-server and update herd.yaml')
    parser.add_argument('--binary', 
                        help='Path to llama-server binary (overrides BEELLAMA_BIN env var and default)',
                        default=os.environ.get('BEELLAMA_BIN', DEFAULT_SERVER_BIN))
    parser.add_argument('--config', 
                        help='Path to herd.yaml (overrides default)',
                        default=DEFAULT_CONFIG_PATH)
    
    args = parser.parse_args()
    
    binary_path = args.binary
    config_path = args.config
    
    print(f"Inspecting flags from: {binary_path}")
    flags = extract_flags(binary_path)
    print(f"Found {len(flags)} flags/subcommands.")

    # Generate macros: convert flag to ARG_<NAME>
    macros = {}
    for flag in flags:
        # Strip leading dashes
        stripped = flag.lstrip("-")
        # Skip if after stripping we have an empty string (e.g., flag was just '-' or '--')
        if not stripped:
            continue
        # Convert flag name to a clean macro name, e.g. --cache-type-k -> ARG_CACHE_TYPE_K
        clean_name = stripped.replace("-", "_").upper()
        macros[f"ARG_{clean_name}"] = flag

    print(f"Generated {len(macros)} subcommand/flag macros (after skipping empty).")

    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                config_data = yaml.safe_load(f) or {}
            
            # Ensure we have a dictionary
            if not isinstance(config_data, dict):
                config_data = {}
            
            # Add or update the AUTO_SUBCOMMAND_MACROS mapping
            config_data["AUTO_SUBCOMMAND_MACROS"] = macros
            
            # Write back to file
            with open(config_path, "w") as f:
                yaml.dump(config_data, f, default_flow_style=False, sort_keys=False)
            
            print(f"Successfully updated {config_path} with {len(macros)} generated macros.")
        except Exception as e:
            print(f"Error updating YAML config: {e}")
            sys.exit(1)
    else:
        print(f"Config file not found: {config_path}")
        sys.exit(1)

if __name__ == "__main__":
    main()