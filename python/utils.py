"""共通ユーティリティ.

- ロギング (loguru ベース)
- 実行時間計測デコレータ
- デバイス自動選択
- 損傷タイプの定義 (D01〜D17)
"""

from __future__ import annotations

import functools
import time
from pathlib import Path
from typing import Any, Callable

import torch
from loguru import logger

# ---------------------------------------------------------------------------
# 損傷タイプ定義 (diagnose-ux-design.md §1 と同期)
# ---------------------------------------------------------------------------

DAMAGE_CLASSES: list[tuple[str, str, str]] = [
    # (id, code, label_jp)
    ("D01", "dent_light", "軽度の凹み"),
    ("D02", "dent_severe", "重度の凹み"),
    ("D03", "crease_light", "軽度の折れ目"),
    ("D04", "crease_severe", "重度の折れ目"),
    ("D05", "warp", "反り"),
    ("D06", "distortion", "歪み"),
    ("D07", "corner_crush", "角の潰れ"),
    ("D08", "corner_peel", "角のめくれ"),
    ("D09", "edge_whitening", "エッジ白欠け"),
    ("D10", "scratch_line", "横線・小傷"),
    ("D11", "holo_crease", "ホロ表面の折り目"),
    ("D12", "surface_dirt", "表面汚れ"),
    ("D13", "print_line", "印刷時 mur 線"),
    ("D14", "stain_water", "水シミ"),
    ("D15", "back_wrinkle", "裏面シワ"),
    ("D16", "roller_line", "ローラー線"),
    ("D17", "heatpen_clouding", "ヒートペン変色"),
]

CLASS_NAMES: list[str] = [c[1] for c in DAMAGE_CLASSES]
NUM_CLASSES: int = len(CLASS_NAMES)
CLASS_NAME_TO_ID: dict[str, int] = {n: i for i, n in enumerate(CLASS_NAMES)}
ID_TO_CLASS_NAME: dict[int, str] = {i: n for i, n in enumerate(CLASS_NAMES)}
JP_LABELS: dict[str, str] = {c[1]: c[2] for c in DAMAGE_CLASSES}


# ---------------------------------------------------------------------------
# 実行時間ロギング
# ---------------------------------------------------------------------------


def timeit(label: str | None = None) -> Callable:
    """関数の実行時間を loguru で出力するデコレータ."""

    def decorator(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            tag = label or fn.__name__
            start = time.perf_counter()
            try:
                return fn(*args, **kwargs)
            finally:
                elapsed = time.perf_counter() - start
                if elapsed > 60:
                    logger.info(f"[timeit] {tag}: {elapsed/60:.2f} min")
                else:
                    logger.info(f"[timeit] {tag}: {elapsed:.2f} sec")

        return wrapper

    return decorator


# ---------------------------------------------------------------------------
# デバイス
# ---------------------------------------------------------------------------


def auto_device() -> torch.device:
    """利用可能なら CUDA, それ以外は CPU."""
    if torch.cuda.is_available():
        dev = torch.device("cuda:0")
        logger.info(f"Using CUDA: {torch.cuda.get_device_name(0)}")
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        dev = torch.device("mps")
        logger.info("Using Apple MPS")
    else:
        dev = torch.device("cpu")
        logger.warning("CUDA not available — falling back to CPU (training will be slow)")
    return dev


# ---------------------------------------------------------------------------
# パス / シード
# ---------------------------------------------------------------------------


def ensure_dir(path: str | Path) -> Path:
    """ディレクトリを作成して Path を返す."""
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def seed_everything(seed: int = 42) -> None:
    import random

    import numpy as np

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


# ---------------------------------------------------------------------------
# ログ初期化
# ---------------------------------------------------------------------------


def setup_logger(log_file: str | Path | None = None, level: str = "INFO") -> None:
    """loguru の標準フォーマットを上書き."""
    logger.remove()
    fmt = (
        "<green>{time:YYYY-MM-DD HH:mm:ss}</green> "
        "<level>{level: <8}</level> "
        "<cyan>{name}</cyan>:<cyan>{line}</cyan> | "
        "<level>{message}</level>"
    )
    logger.add(lambda m: print(m, end=""), format=fmt, level=level, colorize=True)
    if log_file:
        logger.add(str(log_file), format=fmt, level=level, rotation="50 MB")
