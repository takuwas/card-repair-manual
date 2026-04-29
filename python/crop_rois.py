"""合成データの bbox から ROI を切り出して分類器学習用データセットを作る.

使い方:
    python crop_rois.py \
        --source dataset/synthetic \
        --output dataset/classifier \
        --val-ratio 0.1 \
        --no-damage-from dataset/healthy \
        --no-damage-count 1000
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import cv2
import numpy as np
from loguru import logger
from tqdm import tqdm

from utils import CLASS_NAMES, ensure_dir, seed_everything, setup_logger


def crop_with_padding(img: np.ndarray, bbox: tuple[int, int, int, int],
                      pad_ratio: float = 0.15) -> np.ndarray:
    h, w = img.shape[:2]
    x1, y1, x2, y2 = bbox
    bw = x2 - x1; bh = y2 - y1
    px = int(bw * pad_ratio); py = int(bh * pad_ratio)
    x1 = max(0, x1 - px); y1 = max(0, y1 - py)
    x2 = min(w, x2 + px); y2 = min(h, y2 + py)
    if x2 <= x1 or y2 <= y1:
        return img[0:1, 0:1]
    return img[y1:y2, x1:x2]


def crop_rois(
    source: Path,
    output: Path,
    val_ratio: float = 0.1,
    no_damage_dir: Path | None = None,
    no_damage_count: int = 1000,
    seed: int = 42,
) -> None:
    seed_everything(seed)
    rng = random.Random(seed)

    meta_path = source / "meta.jsonl"
    if not meta_path.exists():
        raise FileNotFoundError(f"{meta_path} が存在しません (synthesize_data.py で生成)")

    train_dir = ensure_dir(output / "train")
    val_dir = ensure_dir(output / "val")
    for cls in CLASS_NAMES + ["no_damage"]:
        ensure_dir(train_dir / cls)
        ensure_dir(val_dir / cls)

    counts: dict[str, int] = {c: 0 for c in CLASS_NAMES + ["no_damage"]}

    # 合成データから損傷 ROI 切り出し
    with open(meta_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    for line in tqdm(lines, desc="crop"):
        meta = json.loads(line)
        img_path = source / meta["image"]
        img = cv2.imread(str(img_path))
        if img is None:
            continue
        for j, dmg in enumerate(meta["damages"]):
            roi = crop_with_padding(img, tuple(dmg["bbox_xyxy"]))
            if roi.size == 0:
                continue
            cls = dmg["class_name"]
            target = (val_dir if rng.random() < val_ratio else train_dir) / cls
            out_name = f"{meta['id']}_{j}.jpg"
            cv2.imwrite(str(target / out_name), roi,
                        [cv2.IMWRITE_JPEG_QUALITY, 92])
            counts[cls] += 1

    # 健全領域を no_damage クラスに追加
    if no_damage_dir and no_damage_dir.exists():
        healthy = sorted([
            p for p in no_damage_dir.rglob("*")
            if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        ])
        target_count = no_damage_count
        n_added = 0
        with tqdm(total=target_count, desc="no_damage") as pbar:
            while n_added < target_count and healthy:
                img_path = healthy[n_added % len(healthy)]
                img = cv2.imread(str(img_path))
                if img is None:
                    n_added += 1
                    continue
                h, w = img.shape[:2]
                # ランダム ROI
                for _ in range(2):
                    if n_added >= target_count:
                        break
                    rw = rng.randint(80, min(300, w // 2))
                    rh = rng.randint(80, min(300, h // 2))
                    x = rng.randint(0, w - rw)
                    y = rng.randint(0, h - rh)
                    roi = img[y:y + rh, x:x + rw]
                    target = val_dir if rng.random() < val_ratio else train_dir
                    target /= "no_damage"
                    cv2.imwrite(str(target / f"healthy_{n_added:06d}.jpg"), roi,
                                [cv2.IMWRITE_JPEG_QUALITY, 92])
                    counts["no_damage"] += 1
                    n_added += 1
                    pbar.update(1)

    logger.info("ROI 切り出し完了:")
    for cls, n in counts.items():
        logger.info(f"  {cls}: {n}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--source", type=str, required=True)
    p.add_argument("--output", type=str, required=True)
    p.add_argument("--val-ratio", type=float, default=0.1)
    p.add_argument("--no-damage-from", type=str, default="")
    p.add_argument("--no-damage-count", type=int, default=1000)
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()
    setup_logger()
    crop_rois(
        source=Path(args.source),
        output=Path(args.output),
        val_ratio=args.val_ratio,
        no_damage_dir=Path(args.no_damage_from) if args.no_damage_from else None,
        no_damage_count=args.no_damage_count,
        seed=args.seed,
    )


if __name__ == "__main__":
    main()
