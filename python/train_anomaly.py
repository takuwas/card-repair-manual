"""異常検出モデル (EfficientAD) 学習スクリプト.

参考: ml-architecture-research.md §2-B (EfficientAD-S 推奨, Anomalib + Apache 2.0).

Anomalib の API を使う。健全カード画像のみで学習可能で、
ピクセル単位の異常マップ (heatmap) を出力する。

使い方:
    python train_anomaly.py \
        --data data/healthy --epochs 100 --batch 16 \
        --output models/efficientad
"""

from __future__ import annotations

import argparse
from pathlib import Path

from loguru import logger

from utils import auto_device, ensure_dir, seed_everything, setup_logger, timeit


# anomalib は重いので関数内 import する
def _import_anomalib():
    try:
        from anomalib.data import Folder  # type: ignore
        from anomalib.engine import Engine  # type: ignore
        from anomalib.models import EfficientAd  # type: ignore
        return Folder, Engine, EfficientAd
    except ImportError as e:
        raise ImportError(
            "anomalib がインストールされていません。"
            "`pip install anomalib>=2.0` を実行してください。"
        ) from e


@timeit("train_anomaly")
def train(
    data_dir: Path,
    output_dir: Path,
    epochs: int = 100,
    batch_size: int = 16,
    image_size: int = 256,
    debug: bool = False,
) -> Path:
    """EfficientAD を学習し、ckpt パスを返す."""
    Folder, Engine, EfficientAd = _import_anomalib()

    if debug:
        epochs = min(epochs, 2)
        batch_size = min(batch_size, 4)
        logger.info(f"[debug] epochs={epochs}, batch={batch_size}")

    output_dir = ensure_dir(output_dir)

    # Folder データセット: data_dir 配下の画像を normal として扱う.
    # 損傷画像が data/damaged にあれば abnormal_dir に渡すと validation に使える。
    abnormal = data_dir.parent / "damaged"
    abnormal_dir = str(abnormal) if abnormal.exists() else None

    datamodule = Folder(
        name="card_anomaly",
        root=str(data_dir.parent),
        normal_dir=data_dir.name,
        abnormal_dir=abnormal_dir,
        train_batch_size=batch_size,
        eval_batch_size=batch_size,
        num_workers=0,  # Windows での multiprocessing 問題回避
        image_size=(image_size, image_size),
    )

    model = EfficientAd()  # Apache 2.0, 数MB の軽量モデル

    device = auto_device()
    accelerator = "gpu" if device.type == "cuda" else (
        "mps" if device.type == "mps" else "cpu"
    )

    engine = Engine(
        max_epochs=epochs,
        accelerator=accelerator,
        devices=1,
        default_root_dir=str(output_dir),
        check_val_every_n_epoch=max(1, epochs // 10),
    )

    logger.info("EfficientAD の学習を開始します")
    engine.fit(model=model, datamodule=datamodule)

    # ベストチェックポイントを取得
    ckpt_path = engine.trainer.checkpoint_callback.best_model_path
    if ckpt_path:
        logger.info(f"ベストチェックポイント: {ckpt_path}")
    else:
        logger.warning("ベストチェックポイントが見つかりません")

    # テストも走らせる
    if abnormal_dir:
        logger.info("validation: テストセットで評価")
        try:
            engine.test(model=model, datamodule=datamodule)
        except Exception as e:
            logger.warning(f"テスト失敗 (続行): {e}")

    return Path(ckpt_path) if ckpt_path else output_dir


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="EfficientAD 異常検出学習")
    p.add_argument("--data", type=str, required=True, help="健全カード画像のディレクトリ")
    p.add_argument("--epochs", type=int, default=100)
    p.add_argument("--batch", type=int, default=16)
    p.add_argument("--image-size", type=int, default=256)
    p.add_argument("--output", type=str, default="models/efficientad")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--debug", action="store_true")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    setup_logger(log_file=Path(args.output) / "train.log")
    seed_everything(args.seed)
    train(
        data_dir=Path(args.data),
        output_dir=Path(args.output),
        epochs=args.epochs,
        batch_size=args.batch,
        image_size=args.image_size,
        debug=args.debug,
    )


if __name__ == "__main__":
    main()
