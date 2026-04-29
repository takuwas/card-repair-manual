"""損傷タイプ分類器 学習スクリプト.

EfficientNet-B0 (torchvision) で損傷 ROI を分類する。

ROI は YOLO で得た bbox を 224×224 にリサイズしたもの。
クラスは D01〜D17 + "no_damage" の 18 クラス。

ml-architecture-research.md では「角クロップに MobileNetV3-small」と
「ROI 全般に EfficientNet-B0」の両提案があるため、
本スクリプトは backbone を `--backbone` で切り替えられるようにする。

使い方:
    python train_classifier.py \
        --data data/classifier_dataset \
        --epochs 50 --batch 64 \
        --output models/classifier

データ形式 (ImageFolder 互換):
    data/classifier_dataset/
        train/
            dent_light/
            dent_severe/
            ... (CLASS_NAMES + no_damage)
        val/
            ...
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
import torch.optim as optim
from loguru import logger
from torch.utils.data import DataLoader
from torchvision import datasets, models, transforms
from tqdm import tqdm

from utils import (
    CLASS_NAMES,
    auto_device,
    ensure_dir,
    seed_everything,
    setup_logger,
    timeit,
)

# 分類器のクラス: 全損傷タイプ + 健全 (no_damage)
CLASSIFIER_CLASSES = CLASS_NAMES + ["no_damage"]


def build_model(backbone: str, num_classes: int, pretrained: bool = True) -> nn.Module:
    """モデル構築. backbone: efficientnet_b0 / mobilenet_v3_small"""
    if backbone == "efficientnet_b0":
        weights = models.EfficientNet_B0_Weights.IMAGENET1K_V1 if pretrained else None
        m = models.efficientnet_b0(weights=weights)
        in_features = m.classifier[1].in_features
        m.classifier[1] = nn.Linear(in_features, num_classes)
    elif backbone == "mobilenet_v3_small":
        weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None
        m = models.mobilenet_v3_small(weights=weights)
        in_features = m.classifier[3].in_features
        m.classifier[3] = nn.Linear(in_features, num_classes)
    else:
        raise ValueError(f"Unknown backbone: {backbone}")
    return m


def build_transforms(img_size: int = 224) -> tuple[transforms.Compose, transforms.Compose]:
    """学習・検証用の transform (ImageNet 統計)."""
    mean = [0.485, 0.456, 0.406]
    std = [0.229, 0.224, 0.225]
    train_tf = transforms.Compose([
        transforms.Resize((img_size + 16, img_size + 16)),
        transforms.RandomCrop(img_size),
        transforms.RandomHorizontalFlip(p=0.5),
        transforms.RandomRotation(10),
        transforms.ColorJitter(0.2, 0.2, 0.2, 0.05),
        transforms.ToTensor(),
        transforms.Normalize(mean, std),
    ])
    val_tf = transforms.Compose([
        transforms.Resize((img_size, img_size)),
        transforms.ToTensor(),
        transforms.Normalize(mean, std),
    ])
    return train_tf, val_tf


def evaluate(model: nn.Module, loader: DataLoader, device: torch.device) -> dict[str, float]:
    model.eval()
    correct = 0
    total = 0
    loss_sum = 0.0
    criterion = nn.CrossEntropyLoss()
    with torch.no_grad():
        for x, y in loader:
            x = x.to(device, non_blocking=True)
            y = y.to(device, non_blocking=True)
            logits = model(x)
            loss = criterion(logits, y)
            loss_sum += loss.item() * x.size(0)
            preds = logits.argmax(dim=1)
            correct += (preds == y).sum().item()
            total += x.size(0)
    return {
        "loss": loss_sum / max(1, total),
        "acc": correct / max(1, total),
    }


@timeit("train_classifier")
def train(
    data_dir: Path,
    output_dir: Path,
    backbone: str = "efficientnet_b0",
    epochs: int = 50,
    batch_size: int = 64,
    img_size: int = 224,
    lr: float = 1e-3,
    workers: int = 0,
    debug: bool = False,
) -> Path:
    if debug:
        epochs = min(epochs, 2)
        batch_size = min(batch_size, 8)
        logger.info(f"[debug] epochs={epochs}, batch={batch_size}")

    output_dir = ensure_dir(output_dir)
    device = auto_device()

    train_tf, val_tf = build_transforms(img_size)
    train_dir = data_dir / "train"
    val_dir = data_dir / "val"
    if not train_dir.exists() or not val_dir.exists():
        raise FileNotFoundError(
            f"{data_dir} に train/ と val/ サブディレクトリが必要です"
        )

    train_ds = datasets.ImageFolder(str(train_dir), transform=train_tf)
    val_ds = datasets.ImageFolder(str(val_dir), transform=val_tf)
    logger.info(f"クラス: {train_ds.classes}")
    logger.info(f"train={len(train_ds)} val={len(val_ds)}")

    # クラス順を CLASSIFIER_CLASSES に揃えるよう class_to_idx を保存
    (output_dir / "class_to_idx.json").write_text(
        json.dumps(train_ds.class_to_idx, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    train_loader = DataLoader(
        train_ds, batch_size=batch_size, shuffle=True,
        num_workers=workers, pin_memory=device.type == "cuda",
    )
    val_loader = DataLoader(
        val_ds, batch_size=batch_size, shuffle=False,
        num_workers=workers, pin_memory=device.type == "cuda",
    )

    num_classes = len(train_ds.classes)
    model = build_model(backbone, num_classes, pretrained=True).to(device)
    criterion = nn.CrossEntropyLoss()
    optimizer = optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)

    best_acc = 0.0
    history: list[dict[str, Any]] = []
    best_path = output_dir / "best.pt"

    for ep in range(1, epochs + 1):
        model.train()
        running_loss = 0.0
        running_correct = 0
        seen = 0
        pbar = tqdm(train_loader, desc=f"ep{ep:03d}", leave=False)
        for x, y in pbar:
            x = x.to(device, non_blocking=True)
            y = y.to(device, non_blocking=True)
            logits = model(x)
            loss = criterion(logits, y)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            running_loss += loss.item() * x.size(0)
            running_correct += (logits.argmax(1) == y).sum().item()
            seen += x.size(0)
            pbar.set_postfix(loss=running_loss / seen, acc=running_correct / seen)

        scheduler.step()
        train_metrics = {"loss": running_loss / seen, "acc": running_correct / seen}
        val_metrics = evaluate(model, val_loader, device)
        logger.info(
            f"epoch {ep}/{epochs} | "
            f"train loss={train_metrics['loss']:.4f} acc={train_metrics['acc']:.4f} | "
            f"val loss={val_metrics['loss']:.4f} acc={val_metrics['acc']:.4f}"
        )
        history.append({"epoch": ep, "train": train_metrics, "val": val_metrics})

        if val_metrics["acc"] > best_acc:
            best_acc = val_metrics["acc"]
            torch.save({
                "state_dict": model.state_dict(),
                "backbone": backbone,
                "num_classes": num_classes,
                "img_size": img_size,
                "class_to_idx": train_ds.class_to_idx,
            }, best_path)
            logger.info(f"new best: val acc={best_acc:.4f} → {best_path}")

    (output_dir / "history.json").write_text(
        json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    logger.info(f"学習完了: best val acc={best_acc:.4f}")
    return best_path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="EfficientNet-B0 ROI 分類器学習")
    p.add_argument("--data", type=str, required=True,
                   help="data/{train,val}/<class>/*.jpg 構造のディレクトリ")
    p.add_argument("--output", type=str, default="models/classifier")
    p.add_argument("--backbone", type=str, default="efficientnet_b0",
                   choices=["efficientnet_b0", "mobilenet_v3_small"])
    p.add_argument("--epochs", type=int, default=50)
    p.add_argument("--batch", type=int, default=64)
    p.add_argument("--img-size", type=int, default=224)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--workers", type=int, default=0)
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
        backbone=args.backbone,
        epochs=args.epochs,
        batch_size=args.batch,
        img_size=args.img_size,
        lr=args.lr,
        workers=args.workers,
        debug=args.debug,
    )


if __name__ == "__main__":
    main()
