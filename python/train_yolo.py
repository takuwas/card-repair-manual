"""YOLOv8/v11 物体検出 学習スクリプト.

参考: ml-architecture-research.md §2-B (YOLOv8n / YOLO11n 推奨).

ultralytics ライブラリを使う (AGPL-3.0)。
17 クラス (D01〜D17) を物体検出として学習する。

使い方:
    python train_yolo.py \
        --data dataset/data.yaml --model yolov8n \
        --epochs 200 --img 640
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from loguru import logger

from utils import auto_device, ensure_dir, seed_everything, setup_logger, timeit


def _import_yolo():
    try:
        from ultralytics import YOLO  # type: ignore
        return YOLO
    except ImportError as e:
        raise ImportError(
            "ultralytics がインストールされていません。"
            "`pip install ultralytics>=8.3` を実行してください。"
        ) from e


@timeit("train_yolo")
def train(
    data_yaml: Path,
    model_name: str = "yolov8n",
    epochs: int = 200,
    img_size: int = 640,
    batch: int = 16,
    output_dir: Path = Path("models/yolo"),
    workers: int = 0,
    debug: bool = False,
) -> Path:
    YOLO = _import_yolo()
    if debug:
        epochs = min(epochs, 3)
        batch = min(batch, 4)
        logger.info(f"[debug] epochs={epochs}, batch={batch}")

    output_dir = ensure_dir(output_dir)
    device = auto_device()
    yolo_device = 0 if device.type == "cuda" else "cpu"

    # 事前学習済みからロード
    model = YOLO(f"{model_name}.pt")

    logger.info(f"YOLO 学習開始: model={model_name}, data={data_yaml}, epochs={epochs}")
    results = model.train(
        data=str(data_yaml),
        epochs=epochs,
        imgsz=img_size,
        batch=batch,
        device=yolo_device,
        project=str(output_dir),
        name="train",
        workers=workers,
        patience=max(10, epochs // 10),
        verbose=True,
    )

    # ベストモデルパス
    best = Path(results.save_dir) / "weights" / "best.pt"
    if best.exists():
        # output_dir 直下にもコピーしておくと export_onnx.py から探しやすい
        dst = output_dir / "best.pt"
        shutil.copy2(best, dst)
        logger.info(f"ベストモデル: {best} → {dst}")
        return dst
    return Path(results.save_dir)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="YOLOv8/v11 物体検出学習")
    p.add_argument("--data", type=str, required=True, help="data.yaml")
    p.add_argument("--model", type=str, default="yolov8n",
                   help="yolov8n / yolov8s / yolo11n など")
    p.add_argument("--epochs", type=int, default=200)
    p.add_argument("--img", type=int, default=640)
    p.add_argument("--batch", type=int, default=16)
    p.add_argument("--workers", type=int, default=0)
    p.add_argument("--output", type=str, default="models/yolo")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--debug", action="store_true")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    setup_logger(log_file=Path(args.output) / "train.log")
    seed_everything(args.seed)
    train(
        data_yaml=Path(args.data),
        model_name=args.model,
        epochs=args.epochs,
        img_size=args.img,
        batch=args.batch,
        output_dir=Path(args.output),
        workers=args.workers,
        debug=args.debug,
    )


if __name__ == "__main__":
    main()
