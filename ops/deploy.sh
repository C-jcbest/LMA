#!/usr/bin/env bash
# 安装到 /usr/local/sbin/lma-deploy；由受限 SSH 密钥经 sudo 调用。
set -euo pipefail
umask 077

release_sha="${1:-}"
if [[ ! "$release_sha" =~ ^[a-f0-9]{40}$ ]]; then
    echo '部署拒绝：必须指定完整 Git commit SHA。' >&2
    exit 2
fi

deploy_root=/opt/lma
release_dir="$deploy_root/releases/$release_sha"
environment_file="$deploy_root/shared/.env"
install -d -m 700 "$deploy_root/incoming" "$deploy_root/shared/backups"
install -d -m 755 "$deploy_root/releases"
exec 9>"$deploy_root/deploy.lock"
flock -w 60 9

archive="$deploy_root/incoming/$release_sha.tar.gz"
cat > "$archive"
gzip -t "$archive"
python3 - "$archive" <<'PY'
import pathlib
import sys
import tarfile

with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for member in archive:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
            raise SystemExit('部署拒绝：归档包含越界路径、链接或特殊文件。')
PY
archive_hash="$(sha256sum "$archive" | cut -d ' ' -f 1)"
if [[ -d "$release_dir" ]]; then
    if [[ ! -f "$release_dir/.lma-archive-sha256" ]] || [[ "$(cat "$release_dir/.lma-archive-sha256")" != "$archive_hash" ]]; then
        echo '部署拒绝：已有版本目录与本次归档不一致或未完整解压。' >&2
        exit 2
    fi
else
    install -d -m 755 "$release_dir"
    tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$release_dir"
    printf '%s\n' "$archive_hash" > "$release_dir/.lma-archive-sha256"
fi

export LMA_ENV_FILE="$environment_file"
export LMA_RELEASE="$release_sha"
compose=(docker compose --project-name lma-cloud --env-file "$environment_file" --file "$release_dir/docker-compose.yml")

# 新镜像构建失败时，旧容器继续运行；构建不接触数据库。
"${compose[@]}" build
if [[ -L "$deploy_root/current" ]]; then
    previous_release="$(readlink -f "$deploy_root/current")"
    docker compose --project-name lma-cloud --env-file "$environment_file" \
        --file "$previous_release/docker-compose.yml" exec -T postgres \
        pg_dump -U lma -d lma -Fc > "$deploy_root/shared/backups/$release_sha.dump"
fi

"${compose[@]}" up --detach --wait --wait-timeout 180
curl --fail --silent --show-error http://127.0.0.1:8081/api/health
curl --fail --silent --show-error --output /dev/null http://127.0.0.1:8081/
ln -sfn "$release_dir" "$deploy_root/current"
printf '%s\n' "$release_sha" > "$deploy_root/shared/last-successful-release"
printf '\n部署完成：%s\n' "$release_sha"
