#!/usr/bin/env bash
set -euo pipefail
exec sudo -n /usr/local/sbin/lma-deploy "${SSH_ORIGINAL_COMMAND:-}"
