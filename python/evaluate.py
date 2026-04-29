"""モデル評価スクリプト.

- YOLO: ultralytics の val() で mAP/Precision/Recall を取得
- 分類器: sklearn でクラス別 F1 / 混同行列を出力
- 異常検出: anomalib の test() で AUROC / pixel-AUROC

出力:
    output/eval_report.md   # Markdown 形式の評価表
    output/confusion_matrix_classifier.png
    output/yolo_metrics.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from loguru import logger
from torch.utils.data import DataLoader
from torchvision import datasets, transforms

from train_classifier import build_model, build_transforms
from utils import auto_device, ensure_dir, setup_logger, timeit


# ---------------------------------------------------------------------------
# YOLO
# ---------------------------------------------------------------------------


def evaluate_yolo(weights: Path, data_yaml: Path, output_dir: Path) -> dict:
    from ultralytics import YOLO  # type: ignore

    model = YOLO(str(weights))
    results = model.val(data=str(data_yaml), project=str(output_dir),
                        name="yolo_val", verbose=True)

    metrics = {
        "mAP50": float(results.box.map50),
        "mAP50-95": float(results.box.map),
        "precision": float(results.box.mp),
        "recall": float(results.box.mr),
    }
    # クラス別
    per_class = {}
    if hasattr(results.box, "ap_class_index") and results.names:
        for i, idx in enumerate(results.box.ap_class_index):
            name = results.names[int(idx)]
            per_class[name] = {
                "AP50": float(results.box.ap50[i]),
                "AP50-95": float(results.box.ap[i]),
            }
    metrics["per_class"] = per_class

    out_json = output_dir / "yolo_metrics.json"
    out_json.write_text(json.dumps(metrics, ensure_ascii=False, indent=2),
                        encoding="utf-8")
    logger.info(f"YOLO 評価指標を出力: {out_json}")
    return metrics


# ---------------------------------------------------------------------------
# 分類器
# ---------------------------------------------------------------------------


def evaluate_classifier(weights: Path, data_dir: Path, output_dir: Path,
                        batch: int = 64) -> dict:
    from sklearn.metrics import (
        classification_report,
        confusion_matrix,
        f1_score,
        precision_score,
        recall_score,
    )

    ckpt = torch.load(str(weights), map_location="cpu", weights_only=False)
    backbone = ckpt.get("backbone", "efficientnet_b0")
    num_classes = ckpt.get("num_classes")
    img_size = ckpt.get("img_size", 224)
    class_to_idx = ckpt.get("class_to_idx", {})

    model = build_model(backbone, num_classes, pretrained=False)
    model.load_state_dict(ckpt["state_dict"])
    device = auto_device()
    model = model.to(device).eval()

    _, val_tf = build_transforms(img_size)
    val_ds = datasets.ImageFolder(str(data_dir / "val"), transform=val_tf)
    val_loader = DataLoader(val_ds, batch_size=batch, shuffle=False, num_workers=0)

    all_y, all_p = [], []
    with torch.no_grad():
        for x, y in val_loader:
            x = x.to(device)
            logits = model(x)
            preds = logits.argmax(1).cpu().numpy()
            all_y.append(y.numpy())
            all_p.append(preds)

    y_true = np.concatenate(all_y)
    y_pred = np.concatenate(all_p)

    idx_to_class = {v: k for k, v in val_ds.class_to_idx.items()}
    target_names = [idx_to_class[i] for i in range(len(idx_to_class))]

    report_dict = classification_report(
        y_true, y_pred, target_names=target_names, output_dict=True, zero_division=0
    )
    metrics = {
        "f1_macro": float(f1_score(y_true, y_pred, average="macro", zero_division=0)),
        "f1_weighted": float(f1_score(y_true, y_pred, average="weighted", zero_division=0)),
        "precision_macro": float(precision_score(y_true, y_pred, average="macro", zero_division=0)),
        "recall_macro": float(recall_score(y_true, y_pred, average="macro", zero_division=0)),
        "accuracy": float((y_true == y_pred).mean()),
        "per_class": report_dict,
    }

    out_json = output_dir / "classifier_metrics.json"
    out_json.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"分類器評価指標: {out_json}")

    # 混同行列を画像で
    try:
        import matplotlib.pyplot as plt

        cm = confusion_matrix(y_true, y_pred)
        fig, ax = plt.subplots(figsize=(10, 8))
        im = ax.imshow(cm, cmap="Blues")
        ax.set_xticks(range(len(target_names)))
        ax.set_yticks(range(len(target_names)))
        ax.set_xticklabels(target_names, rotation=45, ha="right")
        ax.set_yticklabels(target_names)
        ax.set_xlabel("Predicted")
        ax.set_ylabel("True")
        ax.set_title("Confusion Matrix")
        for i in range(cm.shape[0]):
            for j in range(cm.shape[1]):
                ax.text(j, i, str(cm[i, j]), ha="center", va="center",
                        color="white" if cm[i, j] > cm.max() / 2 else "black",
                        fontsize=8)
        fig.colorbar(im)
        fig.tight_layout()
        cm_path = output_dir / "confusion_matrix_classifier.png"
        fig.savefig(cm_path, dpi=120)
        plt.close(fig)
        logger.info(f"混同行列を保存: {cm_path}")
    except Exception as e:
        logger.warning(f"混同行列描画失敗: {e}")

    return metrics


# ---------------------------------------------------------------------------
# Markdown レポート
# ---------------------------------------------------------------------------


def write_markdown_report(output_dir: Path, yolo_metrics: dict | None,
                          cls_metrics: dict | None) -> Path:
    md = ["# モデル評価レポート", ""]

    if yolo_metrics:
        md.append("## YOLO 物体検出")
        md.append("")
        md.append(f"- mAP@50: **{yolo_metrics['mAP50']:.4f}**")
        md.append(f"- mAP@50-95: **{yolo_metrics['mAP50-95']:.4f}**")
        md.append(f"- Precision: {yolo_metrics['precision']:.4f}")
        md.append(f"- Recall: {yolo_metrics['recall']:.4f}")
        md.append("")
        if yolo_metrics.get("per_class"):
            md.append("### クラス別 AP")
            md.append("")
            md.append("| クラス | AP@50 | AP@50-95 |")
            md.append("|---|---|---|")
            for name, m in yolo_metrics["per_class"].items():
                md.append(f"| {name} | {m['AP50']:.4f} | {m['AP50-95']:.4f} |")
            md.append("")

    if cls_metrics:
        md.append("## 分類器")
        md.append("")
        md.append(f"- Accuracy: **{cls_metrics['accuracy']:.4f}**")
        md.append(f"- F1 (macro): **{cls_metrics['f1_macro']:.4f}**")
        md.append(f"- F1 (weighted): {cls_metrics['f1_weighted']:.4f}")
        md.append("")
        md.append("### クラス別 F1")
        md.append("")
        md.append("| クラス | precision | recall | f1 | support |")
        md.append("|---|---|---|---|---|")
        for k, v in cls_metrics["per_class"].items():
            if not isinstance(v, dict) or "precision" not in v:
                continue
            md.append(
                f"| {k} | {v['precision']:.4f} | {v['recall']:.4f} | "
                f"{v['f1-score']:.4f} | {int(v['support'])} |"
            )
        md.append("")

    out = output_dir / "eval_report.md"
    out.write_text("\n".join(md), encoding="utf-8")
    logger.info(f"Markdown レポート: {out}")
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="モデル評価")
    p.add_argument("--yolo-weights", type=str, default="")
    p.add_argument("--yolo-data", type=str, default="")
    p.add_argument("--cls-weights", type=str, default="")
    p.add_argument("--cls-data", type=str, default="")
    p.add_argument("--output", type=str, default="output/eval")
    return p.parse_args()


@timeit("evaluate")
def main() -> None:
    args = parse_args()
    setup_logger()
    out = ensure_dir(args.output)

    yolo_metrics = None
    cls_metrics = None

    if args.yolo_weights and args.yolo_data:
        yolo_metrics = evaluate_yolo(Path(args.yolo_weights), Path(args.yolo_data), out)
    if args.cls_weights and args.cls_data:
        cls_metrics = evaluate_classifier(Path(args.cls_weights), Path(args.cls_data), out)

    write_markdown_report(out, yolo_metrics, cls_metrics)


if __name__ == "__main__":
    main()
