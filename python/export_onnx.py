"""学習済みモデル → ONNX → INT8 量子化 エクスポートスクリプト.

参考: ml-architecture-research.md
- WebGPU/WASM 両対応 (opset 17, dynamic axes)
- INT8 量子化: onnxruntime.quantization.quantize_dynamic
- 出力サイズ目標: yolov8n ~3.5MB, efficientnet_b0 ~5MB, efficientad ~8MB

使い方:
    # YOLO
    python export_onnx.py --kind yolo --weights models/yolo/best.pt \
        --output models/onnx/yolov8n_int8.onnx --quantize

    # 分類器
    python export_onnx.py --kind classifier --weights models/classifier/best.pt \
        --output models/onnx/classifier_int8.onnx --quantize

    # EfficientAD
    python export_onnx.py --kind anomaly --weights models/efficientad/.../best.ckpt \
        --output models/onnx/efficientad_int8.onnx --quantize

    # 全部一気に
    python export_onnx.py --kind all --quantize
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
from loguru import logger

from train_classifier import build_model
from utils import auto_device, ensure_dir, setup_logger, timeit

DEFAULT_OPSET = 17  # WebGPU 対応 (ORT Web 1.18+)


# ---------------------------------------------------------------------------
# YOLO エクスポート
# ---------------------------------------------------------------------------


@timeit("export_yolo")
def export_yolo(weights: Path, output: Path, img_size: int = 640,
                quantize: bool = True) -> Path:
    from ultralytics import YOLO  # type: ignore

    logger.info(f"YOLO 重み: {weights}")
    model = YOLO(str(weights))
    # ultralytics の export を使う (opset, simplify, dynamic batch を制御)
    onnx_path = model.export(
        format="onnx",
        imgsz=img_size,
        opset=DEFAULT_OPSET,
        dynamic=True,
        simplify=True,
        nms=False,  # NMS はフロントで行う (ORT Web では NMS op の互換性に注意)
    )
    onnx_path = Path(onnx_path)
    logger.info(f"YOLO ONNX: {onnx_path}")

    output = ensure_dir(output.parent) / output.name
    if quantize:
        out = quantize_int8(onnx_path, output)
        return out
    else:
        import shutil

        shutil.copy2(onnx_path, output)
        return output


# ---------------------------------------------------------------------------
# 分類器エクスポート
# ---------------------------------------------------------------------------


@timeit("export_classifier")
def export_classifier(weights: Path, output: Path, quantize: bool = True) -> Path:
    ckpt = torch.load(str(weights), map_location="cpu", weights_only=False)
    backbone = ckpt.get("backbone", "efficientnet_b0")
    num_classes = ckpt.get("num_classes", 18)
    img_size = ckpt.get("img_size", 224)

    model = build_model(backbone, num_classes, pretrained=False)
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    output = ensure_dir(output.parent) / output.name
    fp32_path = output.with_suffix(".fp32.onnx")

    dummy = torch.randn(1, 3, img_size, img_size)
    torch.onnx.export(
        model,
        dummy,
        str(fp32_path),
        opset_version=DEFAULT_OPSET,
        input_names=["input"],
        output_names=["logits"],
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
    )
    logger.info(f"FP32 ONNX: {fp32_path}")
    _simplify(fp32_path)

    if quantize:
        return quantize_int8(fp32_path, output)
    else:
        fp32_path.replace(output)
        return output


# ---------------------------------------------------------------------------
# EfficientAD (anomalib) エクスポート
# ---------------------------------------------------------------------------


@timeit("export_anomaly")
def export_anomaly(weights: Path, output: Path, image_size: int = 256,
                   quantize: bool = True) -> Path:
    """Anomalib の EfficientAD を ONNX 化."""
    try:
        from anomalib.deploy import ExportType  # type: ignore
        from anomalib.engine import Engine  # type: ignore
        from anomalib.models import EfficientAd  # type: ignore
    except ImportError as e:
        raise ImportError("anomalib が必要です") from e

    output = ensure_dir(output.parent) / output.name
    model = EfficientAd.load_from_checkpoint(str(weights))
    model.eval()

    # anomalib 公式 export API
    engine = Engine()
    onnx_path = engine.export(
        model=model,
        export_type=ExportType.ONNX,
        export_root=output.parent,
        input_size=(image_size, image_size),
    )
    if onnx_path is None:
        raise RuntimeError("anomalib の ONNX エクスポートに失敗")
    onnx_path = Path(onnx_path)
    logger.info(f"Anomaly FP32 ONNX: {onnx_path}")
    _simplify(onnx_path)

    if quantize:
        return quantize_int8(onnx_path, output)
    else:
        import shutil

        shutil.copy2(onnx_path, output)
        return output


# ---------------------------------------------------------------------------
# 共通: simplify / quantize
# ---------------------------------------------------------------------------


def _simplify(onnx_path: Path) -> None:
    """onnxsim でグラフを簡略化 (失敗しても無視)."""
    try:
        import onnx  # type: ignore
        from onnxsim import simplify  # type: ignore

        m = onnx.load(str(onnx_path))
        simplified, ok = simplify(m)
        if ok:
            onnx.save(simplified, str(onnx_path))
            logger.info(f"onnxsim OK: {onnx_path}")
        else:
            logger.warning("onnxsim simplify に失敗")
    except Exception as e:
        logger.warning(f"onnxsim スキップ: {e}")


def quantize_int8(fp32_path: Path, output: Path) -> Path:
    """onnxruntime.quantization.quantize_dynamic で INT8 化."""
    from onnxruntime.quantization import QuantType, quantize_dynamic  # type: ignore

    output.parent.mkdir(parents=True, exist_ok=True)
    quantize_dynamic(
        model_input=str(fp32_path),
        model_output=str(output),
        weight_type=QuantType.QUInt8,
    )
    sz = output.stat().st_size / (1024 * 1024)
    logger.info(f"INT8 量子化済み: {output} ({sz:.2f} MB)")
    return output


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="ONNX エクスポート + INT8 量子化")
    p.add_argument("--kind", type=str, required=True,
                   choices=["yolo", "classifier", "anomaly", "all"])
    p.add_argument("--weights", type=str, default="",
                   help="個別エクスポート時の重みファイル")
    p.add_argument("--output", type=str, default="",
                   help="出力 ONNX パス. all の場合は無視")
    p.add_argument("--out-dir", type=str, default="models/onnx",
                   help="all モード時の出力ディレクトリ")
    p.add_argument("--img-size", type=int, default=640, help="YOLO 入力サイズ")
    p.add_argument("--anomaly-size", type=int, default=256,
                   help="EfficientAD 入力サイズ")
    p.add_argument("--quantize", action="store_true", help="INT8 量子化を実行")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    setup_logger()

    if args.kind == "all":
        out_dir = ensure_dir(Path(args.out_dir))
        # YOLO
        yolo_w = Path("models/yolo/best.pt")
        if yolo_w.exists():
            export_yolo(yolo_w, out_dir / "yolov8n_int8.onnx",
                        img_size=args.img_size, quantize=args.quantize)
        # classifier
        cls_w = Path("models/classifier/best.pt")
        if cls_w.exists():
            export_classifier(cls_w, out_dir / "classifier_int8.onnx",
                              quantize=args.quantize)
        # anomaly: 最新 ckpt を再帰検索
        anomaly_root = Path("models/efficientad")
        if anomaly_root.exists():
            ckpts = sorted(anomaly_root.rglob("*.ckpt"),
                           key=lambda p: p.stat().st_mtime, reverse=True)
            if ckpts:
                export_anomaly(ckpts[0], out_dir / "efficientad_int8.onnx",
                               image_size=args.anomaly_size, quantize=args.quantize)
        return

    weights = Path(args.weights)
    if not weights.exists():
        raise FileNotFoundError(f"--weights {weights} が見つかりません")
    output = Path(args.output)
    if not output.suffix:
        output = output / f"{args.kind}.onnx"

    if args.kind == "yolo":
        export_yolo(weights, output, img_size=args.img_size, quantize=args.quantize)
    elif args.kind == "classifier":
        export_classifier(weights, output, quantize=args.quantize)
    elif args.kind == "anomaly":
        export_anomaly(weights, output, image_size=args.anomaly_size, quantize=args.quantize)


if __name__ == "__main__":
    main()
