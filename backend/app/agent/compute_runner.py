"""compute 工具的子进程执行器：在只开放 pandas/numpy 的受限环境里运行模型写的计算代码。

本文件以 `python -I compute_runner.py` 独立运行，从 stdin 读取代码与数据，向 stdout 写 JSON 结果，
不导入 LMA 的其他模块。隔离依靠三层：语法树白名单（禁止导入、双下划线与文件/网络入口）、
受限内置函数、独立子进程加超时与资源上限。这能挡住常见误用和注入，但不等同于操作系统级沙箱。
"""

import ast
import datetime
import json
import math
import re
import statistics
import sys

MAX_ROWS = 200
MAX_CODE_LENGTH = 4000
MAX_PRINTED_CHARS = 4000

_BANNED_NAMES = {
    "eval", "exec", "compile", "open", "input", "breakpoint", "help", "exit", "quit",
    "globals", "locals", "vars", "dir", "getattr", "setattr", "delattr", "type", "object",
    "memoryview", "classmethod", "staticmethod", "property", "super",
}
# 文件、网络、进程与动态执行入口；pandas/numpy 的读写方法按名称前缀拦截。
_BANNED_ATTRIBUTES = {
    "eval", "query", "load", "loads", "save", "savez", "savez_compressed", "savetxt", "loadtxt",
    "genfromtxt", "fromfile", "tofile", "fromregex", "memmap", "DataSource", "ctypeslib", "ctypes",
    "f2py", "distutils", "testing", "os", "sys", "subprocess", "system", "popen", "lib", "io",
}
# 这些模块本来就已提供；模型习惯先写 import，放行可省去一次纠错往返。只接受模块本身，不接受子模块。
_PROVIDED_MODULES = {"pandas", "numpy", "math", "statistics"}
_IO_ATTRIBUTE = re.compile(
    r"^(read_\w+|to_(csv|pickle|parquet|excel|sql|hdf|feather|json|html|clipboard|xml|latex|stata|orc|markdown))$"
)


def validate_code(code: str) -> ast.Module:
    """不合规的代码在执行前拒绝，并给出可据以修改的说明。"""
    if len(code) > MAX_CODE_LENGTH:
        raise ValueError(f"代码不超过 {MAX_CODE_LENGTH} 字符，请只写必要的计算")
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as error:
        raise ValueError(f"代码语法错误：第 {error.lineno} 行 {error.msg}") from None
    for node in ast.walk(tree):
        if isinstance(node, ast.Import) and any(alias.name not in _PROVIDED_MODULES for alias in node.names):
            raise ValueError("不能导入模块；pd、np、math、statistics 已经可用")
        if isinstance(node, ast.ImportFrom):
            if node.module not in _PROVIDED_MODULES or node.level:
                raise ValueError("不能导入模块；pd、np、math、statistics 已经可用")
            for alias in node.names:
                if alias.name == "*" or alias.name.startswith("_") or alias.name in _BANNED_ATTRIBUTES or _IO_ATTRIBUTE.match(alias.name):
                    raise ValueError(f"不能导入 {alias.name}")
        if isinstance(node, (ast.Global, ast.Nonlocal, ast.ClassDef, ast.AsyncFunctionDef, ast.Await, ast.Yield, ast.YieldFrom)):
            raise ValueError("只支持普通计算语句和函数，不支持类、协程、生成器或全局变量声明")
        if isinstance(node, ast.Name) and (node.id in _BANNED_NAMES or node.id.startswith("_")):
            raise ValueError(f"不能使用 {node.id}")
        if isinstance(node, ast.Attribute):
            if node.attr.startswith("_") or node.attr in _BANNED_ATTRIBUTES or _IO_ATTRIBUTE.match(node.attr):
                raise ValueError(f"不能使用 .{node.attr}")
    return tree


# 解释器和 numpy/pandas 在执行用户代码时会按需导入内部模块（例如 Timestamp.strftime 需要 time，
# 归约运算需要 numpy._core._methods）。用户代码本身不能写 import 也不能引用 __import__，
# 这里只放行这些内部需要的模块。
_IMPLICIT_IMPORTS = {"time", "_strptime", "datetime", "calendar", "locale", "encodings", "numpy", "pandas", "math", "statistics"}


def _implicit_import(name, *args, **kwargs):
    import builtins

    if name.split(".")[0] not in _IMPLICIT_IMPORTS:
        raise ImportError("不能导入模块")
    return builtins.__import__(name, *args, **kwargs)


def _safe_builtins():
    import builtins

    allowed = (
        "abs", "all", "any", "bool", "dict", "enumerate", "filter", "float", "int", "isinstance", "len",
        "list", "map", "max", "min", "range", "reversed", "round", "set", "sorted", "str", "sum", "tuple",
        "zip", "Exception", "ValueError", "KeyError", "IndexError", "TypeError", "ZeroDivisionError",
    )
    return {**{name: getattr(builtins, name) for name in allowed}, "__import__": _implicit_import}


def _limit_resources():
    try:
        import resource
    except ImportError:
        # Windows 没有 resource 模块；开发环境只依赖父进程超时。
        return
    resource.setrlimit(resource.RLIMIT_AS, (1536 * 1024 * 1024, 1536 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))


def _dataset(pd, payload: dict):
    kind = payload["kind"]
    if kind == "gnss":
        frame = pd.DataFrame(payload["points"], columns=["time", "n", "e", "u"])
        frame["time"] = pd.to_datetime(frame["time"])
        frame = frame.set_index("time").astype(float)
        reference = payload["reference"]
        for axis in ("n", "e", "u"):
            base = reference.get(axis)
            frame[f"d{axis}"] = (frame[axis] - base) * 1000 if base is not None else float("nan")
        frame["dh"] = (frame["dn"] ** 2 + frame["de"] ** 2) ** 0.5
        frame["dd"] = (frame["dn"] ** 2 + frame["de"] ** 2 + frame["du"] ** 2) ** 0.5
        frame.attrs["station_name"] = payload["station_name"]
        return frame
    if kind == "weather":
        tables = {}
        for name, columns in payload["tables"].items():
            frame = pd.DataFrame(columns)
            frame["time"] = pd.to_datetime(frame["time"])
            tables[name] = frame.set_index("time")
        return tables
    return payload["value"]


class _Serializer:
    def __init__(self, pd, np):
        self.pd = pd
        self.np = np
        self.truncated = False

    def number(self, value):
        # 去掉二进制浮点噪声（如 0.99999999999），6 位小数远高于毫米级位移的有效精度。
        value = float(value)
        return round(value, 6) if math.isfinite(value) else None

    def __call__(self, value, depth=0):
        pd, np = self.pd, self.np
        if depth > 6:
            raise ValueError("结果嵌套过深，请返回更简单的结构")
        if isinstance(value, pd.DataFrame):
            # 默认整数行号对用户没有意义，只有带业务含义的索引（时间、分段名）才作为首列展示。
            frame = value if isinstance(value.index, pd.RangeIndex) else value.reset_index()
            if len(frame) > MAX_ROWS:
                self.truncated = True
                frame = frame.head(MAX_ROWS)
            return {
                "type": "table",
                "columns": [str(column) for column in frame.columns],
                "rows": [[self(item, depth + 1) for item in row] for row in frame.itertuples(index=False)],
                "row_count": int(len(value)),
            }
        if isinstance(value, pd.Series):
            series = value
            if len(series) > MAX_ROWS:
                self.truncated = True
                series = series.head(MAX_ROWS)
            return {
                "type": "series",
                "name": None if value.name is None else str(value.name),
                "index": [self(item, depth + 1) for item in series.index],
                "values": [self(item, depth + 1) for item in series.tolist()],
                "row_count": int(len(value)),
            }
        if isinstance(value, np.ndarray):
            return self(value.tolist(), depth + 1)
        if isinstance(value, (pd.Timestamp,)):
            return None if pd.isna(value) else value.strftime("%Y-%m-%d %H:%M:%S")
        if isinstance(value, pd.Timedelta):
            return None if pd.isna(value) else value.total_seconds() / 3600
        if isinstance(value, datetime.datetime):
            return value.strftime("%Y-%m-%d %H:%M:%S")
        if isinstance(value, datetime.date):
            return value.isoformat()
        if isinstance(value, (bool, np.bool_)):
            return bool(value)
        if isinstance(value, (int, np.integer)):
            return int(value)
        if isinstance(value, (float, np.floating)):
            return self.number(value)
        if value is None or isinstance(value, str):
            return value
        if isinstance(value, dict):
            return {str(key): self(item, depth + 1) for key, item in value.items()}
        if isinstance(value, (list, tuple, set)):
            items = list(value)
            if len(items) > MAX_ROWS:
                self.truncated = True
                items = items[:MAX_ROWS]
            return [self(item, depth + 1) for item in items]
        if pd.isna(value):
            return None
        raise ValueError(f"result 中有不支持的类型 {type(value).__name__}，请转换为数值、表格或字典")


def main():
    # -I 会忽略 PYTHONIOENCODING；Windows 默认按本地代码页读写，统一改为 UTF-8。
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    request = json.loads(sys.stdin.read())
    try:
        tree = validate_code(request["code"])
    except ValueError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return
    _limit_resources()
    import numpy as np
    import pandas as pd

    # 模型习惯用 print 查看中间值；收集起来随结果返回，而不是写到协议使用的 stdout。
    printed = []

    def collect_print(*values, sep=" ", end="\n"):
        printed.append(sep.join(str(value) for value in values) + end)

    data = {identifier: _dataset(pd, payload) for identifier, payload in request["datasets"].items()}
    builtins = {**_safe_builtins(), "print": collect_print}
    namespace = {"__builtins__": builtins, "pd": pd, "np": np, "math": math, "statistics": statistics, "data": data}
    if len(data) == 1:
        namespace["df"] = next(iter(data.values()))
    try:
        exec(compile(tree, "<compute>", "exec"), namespace)
        printed_text = "".join(printed)[:MAX_PRINTED_CHARS]
        if "result" not in namespace and not printed_text:
            raise ValueError("请把最终结果赋值给变量 result")
        serializer = _Serializer(pd, np)
        result = serializer(namespace["result"]) if "result" in namespace else printed_text
    except Exception as error:
        message = f"{type(error).__name__}: {error}"[:500]
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        return
    outcome = {"ok": True, "result": result, "truncated": serializer.truncated}
    if printed_text and "result" in namespace:
        outcome["printed"] = printed_text
    print(json.dumps(outcome, ensure_ascii=False))


if __name__ == "__main__":
    main()
