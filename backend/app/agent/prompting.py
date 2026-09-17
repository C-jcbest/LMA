"""加载随 backend 一起部署的静态提示词。"""

from pathlib import Path

_PROMPT_DIR = Path(__file__).with_name("prompts")
SYSTEM_PROMPT = (_PROMPT_DIR / "system.md").read_text(encoding="utf-8")
VISION_PROMPT = (_PROMPT_DIR / "vision.md").read_text(encoding="utf-8")
