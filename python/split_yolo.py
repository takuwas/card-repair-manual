"""YOLO データセットを train/val/test に分割.

使い方:
    python split_yolo.py \
        --source dataset/synthetic \
        --output dataset \
        --ratios 0.8 0.1 0.1
"""

from __future__ import annotations

import argparse
import random
import shutil
from pathlib import Path

from loguru import logger

from utils import CLASS_NAMES, ensure_dir, seed_everything, setup_logger


def split(
    source: Path,
    output: Path,
    ratios: tuple[float, float, float] = (0.8, 0.1, 0.1),
    seed: int = 42,
) -> None:
    seed_everything(seed)
    img_dir = source / "images"
    lbl_dir = source / "labels"
    if not img_dir.exists() or not lbl_dir.exists():
        raise FileNotFoundError(f"{source} に images/ と labels/ が必要")

    images = sorted(p for p in img_dir.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
    random.shuffle(images)

    n = len(images)
    n_train = int(n * ratios[0])
    n_val = int(n * ratios[1])
    splits = {
        "train": images[:n_train],
        "val": images[n_train:n_train + n_val],
        "test": images[n_train + n_val:],
    }

    for name, files in splits.items():
        out_img = ensure_dir(output / name / "images")
        out_lbl = ensure_dir(output / name / "labels")
        for img in files:
            shutil.copy2(img, out_img / img.name)
            lbl = lbl_dir / f"{img.stem}.txt"
            if lbl.exists():
                shutil.copy2(lbl, out_lbl / lbl.name)
        logger.info(f"{name}: {len(files)} 枚")

    # data.yaml 生成
    yaml_path = output / "data.yaml"
    yaml_path.write_text(
        f"path: {output.resolve().as_posix()}\n"
        f"train: train/images\n"
        f"val: val/images\n"
        f"test: test/images\n"
        f"nc: {len(CLASS_NAMES)}\n"
        f"names:\n" + "".join(f"  {i}: {n}\n" for i, n in enumerate(CLASS_NAMES)),
        encoding="utf-8",
    )
    logger.info(f"data.yaml: {yaml_path}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--source", type=str, required=True)
    p.add_argument("--output", type=str, required=True)
    p.add_argument("--ratios", type=float, nargs=3, default=[0.8, 0.1, 0.1])
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()
    setup_logger()
    split(Path(args.source), Path(args.output), tuple(args.ratios), args.seed)


if __name__ == "__main__":
    main()
