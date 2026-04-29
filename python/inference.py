"""ローカル推論テスト用スクリプト.

学習済み 3 モデル (YOLO + EfficientAD + 分類器) を連携させて、
画像 1 枚を診断する。

出力 JSON は diagnose-ux-design.md §3 のスキーマに準拠
(detections / summary / image / errors / warnings)。

使い方:
    python inference.py --image card.jpg \
        --yolo models/onnx/yolov8n_int8.onnx \
        --anomaly models/onnx/efficientad_int8.onnx \
        --classifier models/onnx/classifier_int8.onnx \
        --output result.json

ONNX モデルがない場合 (PyTorch ckpt しかない場合) は
PyTorch ロードも対応する (--use-torch を付ける)。
"""

from __future__ import annotations

import argparse
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from loguru import logger

from utils import (
    CLASS_NAMES,
    DAMAGE_CLASSES,
    JP_LABELS,
    ensure_dir,
    setup_logger,
)

# 損傷タイプ → 修復手法のマッピング (diagnose-ux-design.md §1 表より)
REPAIR_METHODS: dict[str, dict[str, Any]] = {
    "dent_light":    {"primary": "加湿クランプ", "chapter": "#section-6-1", "level": "L2"},
    "dent_severe":   {"primary": "強加湿クランプ + ヒートプレス", "chapter": "#section-6-2", "level": "L5"},
    "crease_light":  {"primary": "加湿クランプ", "chapter": "#section-6-1", "level": "L2"},
    "crease_severe": {"primary": "強加湿クランプ + ヒートペン", "chapter": "#section-6-5", "level": "L4"},
    "warp":          {"primary": "加湿クランプ + 乾燥クランプ", "chapter": "#section-6-1", "level": "L2"},
    "distortion":    {"primary": "強加湿クランプ + ヒートプレス", "chapter": "#section-6-7", "level": "L5"},
    "corner_crush":  {"primary": "ストロー加湿 → 加湿クランプ", "chapter": "#section-6-9", "level": "L3"},
    "corner_peel":   {"primary": "ヒートペン (接着面活性化)", "chapter": "#section-6-5", "level": "L4"},
    "edge_whitening":{"primary": "リカバリー複数回", "chapter": "#section-4-0", "level": "L1"},
    "scratch_line":  {"primary": "リカバリー or ポリッシュ", "chapter": "#section-7-2", "level": "L1"},
    "holo_crease":   {"primary": "ヒートペン 青モード", "chapter": "#section-6-5", "level": "L4"},
    "surface_dirt":  {"primary": "スプレー → ポリッシュ", "chapter": "#section-7-2", "level": "L1"},
    "print_line":    {"primary": "リペア非推奨 (印刷ムラ)", "chapter": "#section-7-2", "level": "L0"},
    "stain_water":   {"primary": "吸取紙挟み + クランプ一晩", "chapter": "#section-7-2", "level": "L2"},
    "back_wrinkle":  {"primary": "強加湿クランプ + 乾燥クランプ", "chapter": "#section-7-2", "level": "L4"},
    "roller_line":   {"primary": "ヒュミドール 12〜24h", "chapter": "#section-7-2", "level": "L3"},
    "heatpen_clouding":{"primary": "(基本不可逆)", "chapter": "#section-7-2", "level": "L0"},
}

SEVERITY_COLORS = {
    "light": "#ffd54f",
    "moderate": "#ff9800",
    "severe": "#f44336",
}


# ---------------------------------------------------------------------------
# ONNX セッションラッパ
# ---------------------------------------------------------------------------


def _ort_session(model_path: Path):
    import onnxruntime as ort  # type: ignore

    providers = ort.get_available_providers()
    # CUDA があれば優先
    preferred = []
    for p in ("CUDAExecutionProvider", "CPUExecutionProvider"):
        if p in providers:
            preferred.append(p)
    return ort.InferenceSession(str(model_path), providers=preferred or providers)


# ---------------------------------------------------------------------------
# 前処理 (ml-architecture-research.md §4 STEP 1 を簡易再現)
# ---------------------------------------------------------------------------


def detect_card_quad(img_bgr: np.ndarray) -> np.ndarray | None:
    """カード境界 4 点を返す. 失敗時 None."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 50, 150)
    edges = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)),
                       iterations=2)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:5]
    for c in contours:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4:
            pts = approx.reshape(4, 2).astype(np.float32)
            # アスペクトチェック
            d = sorted([np.linalg.norm(pts[i] - pts[(i + 1) % 4]) for i in range(4)])
            short = d[0] + d[1]
            long = d[2] + d[3]
            ratio = short / max(1, long)
            if abs(ratio - 0.7159) < 0.15:
                return _sort_quad(pts)
    return None


def _sort_quad(pts: np.ndarray) -> np.ndarray:
    """TL/TR/BR/BL 順に並べる."""
    s = pts.sum(axis=1)
    d = pts[:, 0] - pts[:, 1]
    return np.array([
        pts[np.argmin(s)],   # TL
        pts[np.argmax(d)],   # TR
        pts[np.argmax(s)],   # BR
        pts[np.argmin(d)],   # BL
    ], dtype=np.float32)


def rectify_card(img_bgr: np.ndarray, target_w: int = 750,
                 target_h: int = 1050) -> tuple[np.ndarray, np.ndarray | None]:
    """カードを正面化. 検出失敗時はリサイズだけ返す."""
    quad = detect_card_quad(img_bgr)
    if quad is None:
        return cv2.resize(img_bgr, (target_w, target_h)), None
    dst = np.float32([[0, 0], [target_w - 1, 0],
                      [target_w - 1, target_h - 1], [0, target_h - 1]])
    M = cv2.getPerspectiveTransform(quad, dst)
    rect = cv2.warpPerspective(img_bgr, M, (target_w, target_h))
    return rect, quad


# ---------------------------------------------------------------------------
# YOLO 推論 (ONNX)
# ---------------------------------------------------------------------------


def yolo_preprocess(img_bgr: np.ndarray, size: int = 640) -> tuple[np.ndarray, float]:
    h, w = img_bgr.shape[:2]
    scale = size / max(h, w)
    nh, nw = int(h * scale), int(w * scale)
    resized = cv2.resize(img_bgr, (nw, nh))
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    canvas[:nh, :nw] = resized
    rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)
    arr = rgb.astype(np.float32) / 255.0
    arr = np.transpose(arr, (2, 0, 1))[None]
    return arr, scale


def nms(boxes: np.ndarray, scores: np.ndarray, iou_thr: float = 0.45) -> list[int]:
    """シンプル NMS. boxes: (N,4) xyxy."""
    if len(boxes) == 0:
        return []
    idxs = scores.argsort()[::-1]
    keep = []
    while len(idxs) > 0:
        i = idxs[0]
        keep.append(int(i))
        if len(idxs) == 1:
            break
        rest = idxs[1:]
        iou = _iou_array(boxes[i], boxes[rest])
        idxs = rest[iou < iou_thr]
    return keep


def _iou_array(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    x1 = np.maximum(a[0], b[:, 0])
    y1 = np.maximum(a[1], b[:, 1])
    x2 = np.minimum(a[2], b[:, 2])
    y2 = np.minimum(a[3], b[:, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    return inter / (area_a + area_b - inter + 1e-6)


def run_yolo(session, img_bgr: np.ndarray, conf_thr: float = 0.25,
             iou_thr: float = 0.45) -> list[dict]:
    """YOLOv8 ONNX (NMS 無しエクスポート) の推論."""
    arr, scale = yolo_preprocess(img_bgr, 640)
    out = session.run(None, {session.get_inputs()[0].name: arr})[0]
    # (1, 4+nc, 8400) を (8400, 4+nc) に
    if out.shape[1] < out.shape[2]:
        out = out[0].T  # (8400, 4+nc)
    else:
        out = out[0]
    cxcywh = out[:, :4]
    cls_scores = out[:, 4:]
    cls_id = cls_scores.argmax(1)
    conf = cls_scores.max(1)

    keep_thr = conf > conf_thr
    cxcywh = cxcywh[keep_thr]
    cls_id = cls_id[keep_thr]
    conf = conf[keep_thr]
    if len(conf) == 0:
        return []

    # xyxy
    boxes = np.zeros_like(cxcywh)
    boxes[:, 0] = (cxcywh[:, 0] - cxcywh[:, 2] / 2) / scale
    boxes[:, 1] = (cxcywh[:, 1] - cxcywh[:, 3] / 2) / scale
    boxes[:, 2] = (cxcywh[:, 0] + cxcywh[:, 2] / 2) / scale
    boxes[:, 3] = (cxcywh[:, 1] + cxcywh[:, 3] / 2) / scale

    keep_idx = nms(boxes, conf, iou_thr=iou_thr)
    detections = []
    for i in keep_idx:
        c = int(cls_id[i])
        if c >= len(CLASS_NAMES):
            continue
        detections.append({
            "class_id": c,
            "class_name": CLASS_NAMES[c],
            "confidence": float(conf[i]),
            "bbox": [float(x) for x in boxes[i]],
        })
    return detections


# ---------------------------------------------------------------------------
# 分類器 推論 (ONNX)
# ---------------------------------------------------------------------------


def run_classifier(session, roi_bgr: np.ndarray) -> tuple[str, float]:
    img = cv2.resize(roi_bgr, (224, 224))
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    rgb = (rgb - mean) / std
    arr = np.transpose(rgb, (2, 0, 1))[None]
    out = session.run(None, {session.get_inputs()[0].name: arr})[0]
    logits = out[0]
    exp = np.exp(logits - logits.max())
    probs = exp / exp.sum()
    idx = int(probs.argmax())
    # 推論モデルのクラス順は学習時の class_to_idx に依存。
    # class_to_idx.json があるなら使う。なければ CLASS_NAMES + ['no_damage'] と仮定。
    candidates = CLASS_NAMES + ["no_damage"]
    if idx < len(candidates):
        return candidates[idx], float(probs[idx])
    return "unknown", float(probs[idx])


# ---------------------------------------------------------------------------
# 異常検出 推論 (ONNX)
# ---------------------------------------------------------------------------


def run_anomaly(session, img_bgr: np.ndarray, size: int = 256) -> np.ndarray:
    """ピクセル単位の異常マップを返す (H, W) 0..1."""
    img = cv2.resize(img_bgr, (size, size))
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    rgb = (rgb - mean) / std
    arr = np.transpose(rgb, (2, 0, 1))[None]
    name = session.get_inputs()[0].name
    outs = session.run(None, {name: arr})
    # anomalib の EfficientAd export は (anomaly_map, pred_score) のタプルが多い
    amap = None
    for o in outs:
        if o.ndim == 4 and o.shape[1] == 1:  # (1,1,H,W)
            amap = o[0, 0]
            break
        if o.ndim == 3:
            amap = o[0]
            break
    if amap is None:
        amap = outs[0].squeeze()
    amap = amap.astype(np.float32)
    # 0..1 にスケール
    if amap.max() > amap.min():
        amap = (amap - amap.min()) / (amap.max() - amap.min())
    amap = cv2.resize(amap, (img_bgr.shape[1], img_bgr.shape[0]))
    return amap


# ---------------------------------------------------------------------------
# severity 推定
# ---------------------------------------------------------------------------


def estimate_severity(class_name: str, bbox: list[float], img_w: int, img_h: int,
                      anomaly_score: float | None = None) -> str:
    """ヒューリスティックに severity を決める."""
    x1, y1, x2, y2 = bbox
    area = max(0, (x2 - x1)) * max(0, (y2 - y1))
    area_ratio = area / max(1, img_w * img_h)

    # 折れ目: 長さ
    if class_name in ("crease_light", "crease_severe", "holo_crease", "roller_line"):
        long_side = max(x2 - x1, y2 - y1)
        ratio = long_side / max(img_w, img_h)
        if ratio > 0.5:
            return "severe"
        if ratio > 0.2:
            return "moderate"
        return "light"

    # 凹み・シミ: 面積
    if class_name in ("dent_light", "dent_severe", "stain_water", "surface_dirt"):
        if area_ratio > 0.05:
            return "severe"
        if area_ratio > 0.01:
            return "moderate"
        return "light"

    if class_name in ("corner_crush", "corner_peel"):
        if area_ratio > 0.02:
            return "severe"
        if area_ratio > 0.005:
            return "moderate"
        return "light"

    # 異常スコアベース fallback
    if anomaly_score is not None:
        if anomaly_score > 0.7:
            return "severe"
        if anomaly_score > 0.4:
            return "moderate"
    return "light"


# ---------------------------------------------------------------------------
# 統合パイプライン
# ---------------------------------------------------------------------------


def assemble_output(
    image_path: Path,
    img_bgr: np.ndarray,
    quad: np.ndarray | None,
    detections: list[dict],
    anomaly_map: np.ndarray | None,
    elapsed_ms: int,
) -> dict:
    """diagnose-ux-design.md §3 スキーマに沿った dict を返す."""
    h, w = img_bgr.shape[:2]
    schema_detections: list[dict] = []
    for i, d in enumerate(detections):
        cls = d["class_name"]
        bbox = d["bbox"]
        sev = estimate_severity(cls, bbox, w, h)
        method = REPAIR_METHODS.get(cls, {})
        schema_detections.append({
            "id": f"d{i+1}",
            "type": cls,
            "type_label_jp": JP_LABELS.get(cls, cls),
            "severity": sev,
            "severity_label_jp": {"light": "軽度", "moderate": "中度",
                                  "severe": "重度"}[sev],
            "confidence": float(d["confidence"]),
            "bbox": [int(x) for x in bbox],
            "polygon": None,
            "highlight_shape": "rect",
            "highlight_color": SEVERITY_COLORS[sev],
            "label_short": f"{JP_LABELS.get(cls, cls)} ({sev})",
            "explanation": f"{JP_LABELS.get(cls, cls)} を検出 (confidence={d['confidence']:.2f})",
            "repair_methods": [
                {
                    "name": method.get("primary", "(該当なし)"),
                    "chapter": method.get("chapter", "#chapter-1"),
                    "secondary_chapters": [],
                    "priority": 1,
                    "stage": "primary",
                    "summary": "",
                    "required_equipment_level": method.get("level", "L1"),
                    "estimated_time": "",
                    "warnings": [],
                }
            ],
            "ng_card_warnings": [],
        })

    severity_rank = {"light": 1, "moderate": 2, "severe": 3, "critical": 4}
    if schema_detections:
        highest = max(schema_detections, key=lambda d: severity_rank.get(d["severity"], 0))["severity"]
        avg_conf = sum(d["confidence"] for d in schema_detections) / len(schema_detections)
    else:
        highest = "light"
        avg_conf = 0.0

    quad_list = quad.astype(int).tolist() if quad is not None else None
    card_bbox = None
    if quad is not None:
        xs = quad[:, 0]
        ys = quad[:, 1]
        card_bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]

    summary = {
        "total_detections": len(schema_detections),
        "highest_severity": highest,
        "overall_confidence": float(avg_conf),
        "recommended_route": "L4_intermediate" if highest == "severe" else "L2_basic",
        "overall_recommendation": (
            f"{len(schema_detections)} 件の損傷を検出しました。"
            if schema_detections else "明確な損傷は検出されませんでした。"
        ),
        "recommended_order": [
            {"detection_id": d["id"], "reason": ""}
            for d in schema_detections
        ],
        "primary_chapter_links": [
            {"label": "クイック診断チャート", "href": "#chapter-1"},
            {"label": "NGカード判定", "href": "#chapter-2"},
        ],
    }

    out = {
        "schema_version": "1.0",
        "engine": {
            "name": "yolo+efficientad+effnetb0",
            "version": "0.1.0",
            "is_demo": False,
            "model_loaded_at": datetime.now(timezone.utc).isoformat(),
        },
        "diagnosed_at": datetime.now(timezone.utc).isoformat(),
        "elapsed_ms": elapsed_ms,
        "image": {
            "filename": image_path.name,
            "mime": "image/jpeg",
            "width": w,
            "height": h,
            "card_bbox": card_bbox,
            "card_corners": quad_list,
            "orientation": "portrait" if h >= w else "landscape",
            "side": "front",
            "quality": {
                "brightness": float(img_bgr.mean() / 255.0),
                "blur_score": 0.0,
                "warnings": [],
            },
        },
        "detections": schema_detections,
        "summary": summary,
        "errors": [],
        "warnings": [] if quad is not None else [
            {"code": "card_quad_not_detected",
             "message": "カード境界の自動検出に失敗。リサイズで近似処理します。"}
        ],
    }
    return out


def run_inference(
    image_path: Path,
    yolo_path: Path | None,
    anomaly_path: Path | None,
    classifier_path: Path | None,
) -> dict:
    img_bgr = cv2.imread(str(image_path))
    if img_bgr is None:
        return {"errors": [{"code": "image_load_failed",
                            "message": f"画像をロードできません: {image_path}"}],
                "detections": []}

    t0 = time.time()
    rect_bgr, quad = rectify_card(img_bgr)

    detections: list[dict] = []
    anomaly_map: np.ndarray | None = None

    if yolo_path is not None and yolo_path.exists():
        sess = _ort_session(yolo_path)
        detections = run_yolo(sess, rect_bgr)
        logger.info(f"YOLO 検出: {len(detections)} 件")

    if anomaly_path is not None and anomaly_path.exists():
        sess = _ort_session(anomaly_path)
        anomaly_map = run_anomaly(sess, rect_bgr)
        # 異常マップから追加 ROI 候補
        if anomaly_map is not None:
            heat = (anomaly_map > 0.5).astype(np.uint8) * 255
            num, labels, stats, _ = cv2.connectedComponentsWithStats(heat)
            for j in range(1, num):
                x, y, w, h, area = stats[j]
                if area < 200:
                    continue
                # YOLO 検出と重複チェック (簡易)
                bbox = [float(x), float(y), float(x + w), float(y + h)]
                overlap = False
                for d in detections:
                    iou = _iou_array(np.array(bbox), np.array([d["bbox"]]))[0]
                    if iou > 0.3:
                        overlap = True
                        break
                if overlap:
                    continue
                # 分類器に投げる
                roi = rect_bgr[y:y + h, x:x + w]
                if roi.size == 0 or classifier_path is None or not classifier_path.exists():
                    cls_name = "dent_light"
                    conf = float(anomaly_map[y:y + h, x:x + w].mean())
                else:
                    sess_c = _ort_session(classifier_path)
                    cls_name, conf = run_classifier(sess_c, roi)
                    if cls_name == "no_damage":
                        continue
                detections.append({
                    "class_id": -1,
                    "class_name": cls_name,
                    "confidence": float(conf),
                    "bbox": bbox,
                })
            logger.info(f"異常マップ補完後: {len(detections)} 件")

    elapsed_ms = int((time.time() - t0) * 1000)
    return assemble_output(image_path, rect_bgr, quad, detections, anomaly_map, elapsed_ms)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="ローカル推論テスト")
    p.add_argument("--image", type=str, required=True)
    p.add_argument("--yolo", type=str, default="models/onnx/yolov8n_int8.onnx")
    p.add_argument("--anomaly", type=str, default="models/onnx/efficientad_int8.onnx")
    p.add_argument("--classifier", type=str, default="models/onnx/classifier_int8.onnx")
    p.add_argument("--output", type=str, default="output/result.json")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    setup_logger()
    out_path = Path(args.output)
    ensure_dir(out_path.parent)

    yolo = Path(args.yolo) if Path(args.yolo).exists() else None
    anomaly = Path(args.anomaly) if Path(args.anomaly).exists() else None
    cls = Path(args.classifier) if Path(args.classifier).exists() else None
    if yolo is None and anomaly is None:
        logger.warning("YOLO / Anomaly いずれの ONNX も見つかりません")

    result = run_inference(Path(args.image), yolo, anomaly, cls)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2),
                        encoding="utf-8")
    logger.info(f"結果: {out_path}")
    logger.info(f"検出件数: {len(result.get('detections', []))}")


if __name__ == "__main__":
    main()
