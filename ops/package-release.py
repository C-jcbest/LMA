"""CI 和人工发布共用的归档入口，只打包指定提交并禁用换行转换。"""

import argparse
from pathlib import Path
import subprocess


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="输出的 tar.gz 文件路径")
    parser.add_argument("--revision", default="HEAD", help="发布的 Git 提交，默认 HEAD")
    args = parser.parse_args()

    repository = Path(__file__).resolve().parents[1]
    commit_sha = subprocess.check_output(
        ["git", "rev-parse", "--verify", "--end-of-options", f"{args.revision}^{{commit}}"],
        cwd=repository,
        text=True,
    ).strip()
    archive = args.output.resolve()
    archive.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "git", "-c", "core.autocrlf=false", "archive",
            "--format=tar.gz", f"--output={archive}", commit_sha,
        ],
        cwd=repository,
        check=True,
    )
    print(f"已归档提交：{commit_sha}")
    print(f"归档文件：{archive}")


if __name__ == "__main__":
    main()
