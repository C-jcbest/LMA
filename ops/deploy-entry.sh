#!/usr/bin/env bash
# authorized_keys 的强制入口，原始 SSH 命令仅作为单个参数交给部署脚本校验。
set -euo pipefail
exec sudo -n /usr/local/sbin/lma-deploy "${SSH_ORIGINAL_COMMAND:-}"
