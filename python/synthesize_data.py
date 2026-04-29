"""合成データ生成スクリプト.

健全カード画像から、ルールベースで損傷を注入して
学習用の (画像, マスク, bbox, クラスラベル) を出力する。

参照:
- ml-architecture-research.md §3-B 「合成データ生成戦略 第1段階」
- damage-detection-algorithms.md §2 各損傷タイプの視覚特徴

実装される損傷タイプ:
    crease_light / crease_severe   (折れ目)
    dent_light / dent_severe       (凹み)
    corner_crush / corner_peel     (角の潰れ・めくれ)
    scratch_line                   (スレ)
    stain_water                    (シミ)
    holo_crease                    (ホロ折れ目, 単純な crease で代替)
    roller_line                    (ローラー線, 平行線多発)
    warp                           (反り, perspective warp)

使い方:
    python synthesize_data.py \
        --input data/healthy --output data/synthetic \
        --count 5000 \
        --types crease,dent,corner,scratch,stain,roller

CutPaste 法 (CVPR 2021) は --cutpaste フラグで有効化。
"""

from __future__ import annotations

import argparse
import json
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import cv2
import numpy as np
from loguru import logger
from tqdm import tqdm

from utils import (
    CLASS_NAME_TO_ID,
    CLASS_NAMES,
    ensure_dir,
    seed_everything,
    setup_logger,
    timeit,
)

# 出力する標準サイズ (damage-detection-algorithms.md §1.2)
TARGET_W, TARGET_H = 750, 1050


# ---------------------------------------------------------------------------
# 重症度 → 強度マップ
# ---------------------------------------------------------------------------

SEVERITY_LEVELS = ["light", "moderate", "severe"]


@dataclass
class DamageInstance:
    """1 枚の画像中に注入された 1 件の損傷."""

    class_name: str  # CLASS_NAMES のいずれか
    severity: str
    bbox_xyxy: tuple[int, int, int, int]  # ピクセル座標 (x1, y1, x2, y2)
    mask: np.ndarray  # uint8 0/255

    @property
    def class_id(self) -> int:
        return CLASS_NAME_TO_ID[self.class_name]


# ---------------------------------------------------------------------------
# Perlin noise (簡易実装、scipy 不要)
# ---------------------------------------------------------------------------


def _perlin_noise_2d(shape: tuple[int, int], scale: int = 32, seed: int | None = None) -> np.ndarray:
    """簡易 value noise. -1〜1 の float32 配列を返す."""
    if seed is not None:
        rng = np.random.default_rng(seed)
    else:
        rng = np.random.default_rng()
    h, w = shape
    nh = max(2, h // scale + 2)
    nw = max(2, w // scale + 2)
    coarse = rng.uniform(-1, 1, size=(nh, nw)).astype(np.float32)
    big = cv2.resize(coarse, (w, h), interpolation=cv2.INTER_CUBIC)
    return np.clip(big, -1.0, 1.0)


# ---------------------------------------------------------------------------
# 個別損傷インジェクタ
# ---------------------------------------------------------------------------


class DamageInjector:
    """各損傷の注入器. 全て (画像, セベリティ) -> (画像, DamageInstance) を返す."""

    def __init__(self, rng: random.Random | None = None) -> None:
        self.rng = rng or random.Random()

    # ------------------ 折れ目 (crease) ------------------

    def crease(self, img: np.ndarray, severity: str) -> tuple[np.ndarray, DamageInstance]:
        """直線パスに沿って明度差・shadow を注入."""
        h, w = img.shape[:2]
        out = img.copy()
        mask = np.zeros((h, w), dtype=np.uint8)

        # 直線パラメータ
        # severity に応じて長さを変える
        sev_to_len = {"light": (0.15, 0.30), "moderate": (0.30, 0.55), "severe": (0.55, 0.95)}
        lo, hi = sev_to_len[severity]
        length_ratio = self.rng.uniform(lo, hi)

        cx = self.rng.randint(int(w * 0.15), int(w * 0.85))
        cy = self.rng.randint(int(h * 0.15), int(h * 0.85))
        # 角度: 0/90 寄りに偏らせる (運搬・収納方向)
        angle = self.rng.choice([self.rng.gauss(0, 10), self.rng.gauss(90, 10),
                                 self.rng.uniform(0, 180)])
        angle_rad = math.radians(angle)
        L = int(length_ratio * min(w, h))
        x1 = int(cx - math.cos(angle_rad) * L / 2)
        y1 = int(cy - math.sin(angle_rad) * L / 2)
        x2 = int(cx + math.cos(angle_rad) * L / 2)
        y2 = int(cy + math.sin(angle_rad) * L / 2)
        x1 = max(0, min(w - 1, x1)); x2 = max(0, min(w - 1, x2))
        y1 = max(0, min(h - 1, y1)); y2 = max(0, min(h - 1, y2))

        # 線の太さと強度
        sev_to_strength = {"light": (8, 18), "moderate": (15, 30), "severe": (25, 60)}
        lo_s, hi_s = sev_to_strength[severity]
        strength = self.rng.randint(lo_s, hi_s)
        thickness = self.rng.randint(1, 3) if severity == "light" else self.rng.randint(2, 5)

        # シャドウ (暗い線)
        shadow = np.zeros_like(out)
        cv2.line(shadow, (x1, y1), (x2, y2), (strength, strength, strength), thickness)
        # ハイライト (明るい線, 折れ目稜線の反対側)
        offx = int(math.cos(angle_rad + math.pi / 2) * 2)
        offy = int(math.sin(angle_rad + math.pi / 2) * 2)
        highlight = np.zeros_like(out)
        cv2.line(highlight, (x1 + offx, y1 + offy), (x2 + offx, y2 + offy),
                 (strength // 2, strength // 2, strength // 2), max(1, thickness - 1))

        # Perlin で揺らぎを追加して直線感を緩和
        noise = (_perlin_noise_2d((h, w), scale=8) * 8).astype(np.int16)

        out_int = out.astype(np.int16)
        out_int -= shadow.astype(np.int16)
        out_int += highlight.astype(np.int16)
        out_int += noise[..., None]
        out = np.clip(out_int, 0, 255).astype(np.uint8)

        # マスク (太めに)
        cv2.line(mask, (x1, y1), (x2, y2), 255, thickness + 4)

        # bbox
        x_lo, x_hi = sorted([x1, x2])
        y_lo, y_hi = sorted([y1, y2])
        x_lo = max(0, x_lo - 6); y_lo = max(0, y_lo - 6)
        x_hi = min(w - 1, x_hi + 6); y_hi = min(h - 1, y_hi + 6)

        cls = "crease_severe" if severity == "severe" else "crease_light"
        return out, DamageInstance(cls, severity, (x_lo, y_lo, x_hi, y_hi), mask)

    # ------------------ 凹み (dent) ------------------

    def dent(self, img: np.ndarray, severity: str) -> tuple[np.ndarray, DamageInstance]:
        """楕円エリアの明度を局所的に下げる + 微妙な blur."""
        h, w = img.shape[:2]
        out = img.copy()
        mask = np.zeros((h, w), dtype=np.uint8)

        sev_to_radius = {"light": (8, 18), "moderate": (16, 35), "severe": (30, 70)}
        sev_to_dark = {"light": (5, 15), "moderate": (12, 28), "severe": (25, 55)}
        rmin, rmax = sev_to_radius[severity]
        dmin, dmax = sev_to_dark[severity]
        rx = self.rng.randint(rmin, rmax)
        ry = self.rng.randint(rmin, rmax)
        cx = self.rng.randint(rx + 5, w - rx - 5)
        cy = self.rng.randint(ry + 5, h - ry - 5)
        dark = self.rng.randint(dmin, dmax)

        # ガウシアンマスクで滑らかに
        circle = np.zeros((h, w), dtype=np.float32)
        cv2.ellipse(circle, (cx, cy), (rx, ry), 0, 0, 360, 1.0, -1)
        circle = cv2.GaussianBlur(circle, (0, 0), sigmaX=max(rx, ry) / 2.5)
        circle = circle / max(1e-6, circle.max())

        out_f = out.astype(np.float32)
        out_f -= (circle[..., None] * dark)
        out = np.clip(out_f, 0, 255).astype(np.uint8)

        # 軽いぼかし (凹み中央のテクスチャ流れ)
        if severity in ("moderate", "severe"):
            roi = out[max(0, cy - ry):cy + ry, max(0, cx - rx):cx + rx]
            if roi.size > 0:
                blurred = cv2.GaussianBlur(roi, (0, 0), sigmaX=1.2)
                out[max(0, cy - ry):cy + ry, max(0, cx - rx):cx + rx] = blurred

        # マスク (閾値で)
        mask[circle > 0.3] = 255

        x1 = max(0, cx - rx); y1 = max(0, cy - ry)
        x2 = min(w - 1, cx + rx); y2 = min(h - 1, cy + ry)
        cls = "dent_severe" if severity == "severe" else "dent_light"
        return out, DamageInstance(cls, severity, (x1, y1, x2, y2), mask)

    # ------------------ 角の潰れ (corner_crush) ------------------

    def corner_damage(self, img: np.ndarray, severity: str) -> tuple[np.ndarray, DamageInstance]:
        """コーナー領域を切り取って類似色で塗り潰す."""
        h, w = img.shape[:2]
        out = img.copy()
        mask = np.zeros((h, w), dtype=np.uint8)

        which = self.rng.choice(["TL", "TR", "BR", "BL"])
        sev_to_size = {"light": (10, 20), "moderate": (20, 40), "severe": (40, 80)}
        s_lo, s_hi = sev_to_size[severity]
        size = self.rng.randint(s_lo, s_hi)

        if which == "TL":
            x0, y0 = 0, 0
        elif which == "TR":
            x0, y0 = w - size, 0
        elif which == "BR":
            x0, y0 = w - size, h - size
        else:
            x0, y0 = 0, h - size

        # peel か crush か
        if self.rng.random() < 0.5:
            # crush: 角を内側にシフト + 白っぽい色で塗りつぶし (剥離した白い縁)
            color = (220, 220, 220)
            # 三角形マスク (角に向かって尖る)
            tri = np.array([[x0, y0], [x0 + size, y0], [x0, y0 + size]], dtype=np.int32)
            if which == "TR":
                tri = np.array([[x0 + size, y0], [x0, y0], [x0 + size, y0 + size]], dtype=np.int32)
            elif which == "BR":
                tri = np.array([[x0 + size, y0 + size], [x0, y0 + size],
                                [x0 + size, y0]], dtype=np.int32)
            elif which == "BL":
                tri = np.array([[x0, y0 + size], [x0 + size, y0 + size], [x0, y0]], dtype=np.int32)
            cv2.fillConvexPoly(out, tri, color)
            cv2.fillConvexPoly(mask, tri, 255)
            cls = "corner_crush"
        else:
            # peel: 段差陰影
            shadow = np.zeros_like(out)
            cv2.rectangle(shadow, (x0, y0), (x0 + size, y0 + size), (40, 40, 40), -1)
            shadow = cv2.GaussianBlur(shadow, (0, 0), sigmaX=size / 4.0)
            out = np.clip(out.astype(np.int16) - shadow.astype(np.int16) // 2, 0, 255).astype(np.uint8)
            # 白い縁のハイライト
            cv2.rectangle(out, (x0, y0), (x0 + size, y0 + size), (240, 240, 240), 2)
            cv2.rectangle(mask, (x0, y0), (x0 + size, y0 + size), 255, -1)
            cls = "corner_peel"

        return out, DamageInstance(cls, severity, (x0, y0, x0 + size, y0 + size), mask)

    # ------------------ スレ (scratch) ------------------

    def scratch(self, img: np.ndarray, severity: str) -> tuple[np.ndarray, DamageInstance]:
        """細い線を低コントラストで描画."""
        h, w = img.shape[:2]
        out = img.copy()
        mask = np.zeros((h, w), dtype=np.uint8)

        sev_to_count = {"light": (1, 3), "moderate": (3, 8), "severe": (8, 20)}
        n_lo, n_hi = sev_to_count[severity]
        n_lines = self.rng.randint(n_lo, n_hi)

        # 全てのスクラッチを包む bbox
        all_x: list[int] = []
        all_y: list[int] = []
        for _ in range(n_lines):
            length = self.rng.randint(20, 100)
            angle = self.rng.choice([0, 90]) + self.rng.gauss(0, 15)
            angle_rad = math.radians(angle)
            cx = self.rng.randint(20, w - 20)
            cy = self.rng.randint(20, h - 20)
            x1 = int(cx - math.cos(angle_rad) * length / 2)
            y1 = int(cy - math.sin(angle_rad) * length / 2)
            x2 = int(cx + math.cos(angle_rad) * length / 2)
            y2 = int(cy + math.sin(angle_rad) * length / 2)
            x1 = max(0, min(w - 1, x1)); x2 = max(0, min(w - 1, x2))
            y1 = max(0, min(h - 1, y1)); y2 = max(0, min(h - 1, y2))
            # 低コントラスト (薄め)
            intensity = self.rng.randint(8, 20)
            cv2.line(out, (x1, y1), (x2, y2),
                     (max(0, int(out[y1, x1, 0]) - intensity),
                      max(0, int(out[y1, x1, 1]) - intensity),
                      max(0, int(out[y1, x1, 2]) - intensity)), 1)
            cv2.line(mask, (x1, y1), (x2, y2), 255, 2)
            all_x += [x1, x2]; all_y += [y1, y2]

        x_lo, x_hi = max(0, min(all_x) - 4), min(w - 1, max(all_x) + 4)
        y_lo, y_hi = max(0, min(all_y) - 4), min(h - 1, max(all_y) + 4)
        return out, DamageInstance("scratch_line", severity, (x_lo, y_lo, x_hi, y_hi), mask)

    # ------------------ シミ (stain) ------------------

    def stain(self, img: np.ndarray, severity: str) -> tuple[np.ndarray, DamageInstance]:
        """不規則な形状の色相シフト (黄〜茶系)."""
        h, w = img.shape[:2]
        out = img.copy()
        mask = np.zeros((h, w), dtype=np.uint8)

        sev_to_radius = {"light": (12, 25), "moderate": (20, 50), "severe": (40, 90)}
        rmin, rmax = sev_to_radius[severity]
        rx = self.rng.randint(rmin, rmax)
        ry = self.rng.randint(rmin, rmax)
        cx = self.rng.randint(rx + 5, w - rx - 5)
        cy = self.rng.randint(ry + 5, h - ry - 5)

        # 不規則形状 (Perlin で楕円を歪める)
        blob = np.zeros((h, w), dtype=np.float32)
        cv2.ellipse(blob, (cx, cy), (rx, ry), self.rng.randint(0, 180), 0, 360, 1.0, -1)
        noise = _perlin_noise_2d((h, w), scale=12)
        blob = blob * (0.8 + 0.4 * noise)
        blob = cv2.GaussianBlur(np.clip(blob, 0, 1), (0, 0), sigmaX=4)
        blob = blob / max(1e-6, blob.max())

        # 黄〜茶系の色シフト
        hsv = cv2.cvtColor(out, cv2.COLOR_RGB2HSV).astype(np.float32)
        # H を 20 度近辺へ寄せる, S を上げる, V を少し下げる
        sev_to_alpha = {"light": 0.20, "moderate": 0.40, "severe": 0.65}
        a = sev_to_alpha[severity]
        target_h = self.rng.uniform(15, 30)
        target_s = self.rng.uniform(80, 160)
        target_v_delta = -self.rng.uniform(10, 30)
        hsv[..., 0] = (1 - a * blob) * hsv[..., 0] + a * blob * target_h
        hsv[..., 1] = (1 - a * blob) * hsv[..., 1] + a * blob * target_s
        hsv[..., 2] = hsv[..., 2] + a * blob * target_v_delta
        hsv = np.clip(hsv, 0, 255)
        out = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2RGB)

        mask[blob > 0.3] = 255
        x1 = max(0, cx - rx); y1 = max(0, cy - ry)
        x2 = min(w - 1, cx + rx); y2 = min(h - 1, cy + ry)
        return out, DamageInstance("stain_water", severity, (x1, y1, x2, y2), mask)

    # ------------------ ローラー線 (roller_line) ------------------

    def roller_line(self, img: np.ndarray, severity: str) -> tuple[np.ndarray, DamageInstance]:
        """平行な複数本の細線 (3〜6 本)."""
        h, w = img.shape[:2]
        out = img.copy()
        mask = np.zeros((h, w), dtype=np.uint8)

        n = self.rng.randint(3, 6)
        spacing = self.rng.randint(8, 18)
        angle = self.rng.choice([0, 90]) + self.rng.gauss(0, 5)
        angle_rad = math.radians(angle)
        # 中央位置
        cx = self.rng.randint(int(w * 0.2), int(w * 0.8))
        cy = self.rng.randint(int(h * 0.2), int(h * 0.8))
        L = int(min(w, h) * self.rng.uniform(0.3, 0.7))

        # 線の方向と垂直方向
        dx = math.cos(angle_rad); dy = math.sin(angle_rad)
        px = -dy; py = dx

        sev_to_intensity = {"light": (5, 12), "moderate": (10, 22), "severe": (18, 35)}
        lo, hi = sev_to_intensity[severity]
        intensity = self.rng.randint(lo, hi)

        all_x: list[int] = []
        all_y: list[int] = []
        for i in range(n):
            offs = (i - (n - 1) / 2) * spacing
            ox = cx + px * offs
            oy = cy + py * offs
            x1 = int(ox - dx * L / 2); y1 = int(oy - dy * L / 2)
            x2 = int(ox + dx * L / 2); y2 = int(oy + dy * L / 2)
            x1 = max(0, min(w - 1, x1)); x2 = max(0, min(w - 1, x2))
            y1 = max(0, min(h - 1, y1)); y2 = max(0, min(h - 1, y2))
            shadow = np.zeros_like(out)
            cv2.line(shadow, (x1, y1), (x2, y2), (intensity, intensity, intensity), 1)
            out = np.clip(out.astype(np.int16) - shadow.astype(np.int16), 0, 255).astype(np.uint8)
            cv2.line(mask, (x1, y1), (x2, y2), 255, 2)
            all_x += [x1, x2]; all_y += [y1, y2]

        x_lo, x_hi = max(0, min(all_x) - 4), min(w - 1, max(all_x) + 4)
        y_lo, y_hi = max(0, min(all_y) - 4), min(h - 1, max(all_y) + 4)
        return out, DamageInstance("roller_line", severity, (x_lo, y_lo, x_hi, y_hi), mask)

    # ------------------ 反り (warp) ------------------

    def warp(self, img: np.ndarray, severity: str) -> tuple[np.ndarray, DamageInstance]:
        """perspective warp で全体を弓形に変形."""
        h, w = img.shape[:2]
        sev_to_amp = {"light": 4, "moderate": 10, "severe": 20}
        amp = sev_to_amp[severity]

        src = np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
        # 上下を内側に引っ込ませる弓形
        d1 = self.rng.randint(amp // 2, amp)
        d2 = self.rng.randint(amp // 2, amp)
        dst = np.float32([
            [d1, 0], [w - 1 - d1, 0],
            [w - 1 - d2, h - 1], [d2, h - 1]
        ])
        M = cv2.getPerspectiveTransform(src, dst)
        out = cv2.warpPerspective(img, M, (w, h), borderValue=(20, 20, 20))

        # warp は「全体属性」なので bbox はカード全体, mask は全面薄く
        mask = np.full((h, w), 64, dtype=np.uint8)
        return out, DamageInstance("warp", severity, (0, 0, w - 1, h - 1), mask)


# ---------------------------------------------------------------------------
# CutPaste 法 (CVPR 2021)
# ---------------------------------------------------------------------------


def cutpaste_augment(img: np.ndarray, rng: random.Random) -> tuple[np.ndarray, np.ndarray]:
    """画像内のパッチをランダムな別の場所に貼り付ける.

    自己教師あり異常検出用. ラベルは「異常」として使う。
    """
    h, w = img.shape[:2]
    pw = rng.randint(int(w * 0.05), int(w * 0.20))
    ph = rng.randint(int(h * 0.05), int(h * 0.20))
    sx = rng.randint(0, w - pw - 1)
    sy = rng.randint(0, h - ph - 1)
    patch = img[sy:sy + ph, sx:sx + pw].copy()
    # 色変換
    patch = (patch.astype(np.int16) + rng.randint(-30, 30)).clip(0, 255).astype(np.uint8)
    # 回転
    M = cv2.getRotationMatrix2D((pw / 2, ph / 2), rng.uniform(0, 180), 1.0)
    patch = cv2.warpAffine(patch, M, (pw, ph), borderValue=(0, 0, 0))
    # 別の場所に貼る
    dx = rng.randint(0, w - pw - 1)
    dy = rng.randint(0, h - ph - 1)
    out = img.copy()
    out[dy:dy + ph, dx:dx + pw] = patch
    mask = np.zeros((h, w), dtype=np.uint8)
    mask[dy:dy + ph, dx:dx + pw] = 255
    return out, mask


# ---------------------------------------------------------------------------
# データ拡張 (健全画像に対して)
# ---------------------------------------------------------------------------


def base_augment(img: np.ndarray, rng: random.Random) -> np.ndarray:
    """軽い色・明度ジッターのみ. 損傷を消さないため弱めに."""
    out = img.copy()
    # 明度・コントラスト
    alpha = 1.0 + rng.uniform(-0.1, 0.1)
    beta = rng.uniform(-10, 10)
    out = np.clip(alpha * out + beta, 0, 255).astype(np.uint8)
    # 軽い回転
    if rng.random() < 0.3:
        angle = rng.uniform(-3, 3)
        h, w = out.shape[:2]
        M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        out = cv2.warpAffine(out, M, (w, h), borderValue=(0, 0, 0))
    return out


# ---------------------------------------------------------------------------
# YOLO ラベル形式
# ---------------------------------------------------------------------------


def to_yolo_label(d: DamageInstance, img_w: int, img_h: int) -> str:
    """YOLO 形式の 1 行 (class cx cy w h, normalized)."""
    x1, y1, x2, y2 = d.bbox_xyxy
    cx = (x1 + x2) / 2 / img_w
    cy = (y1 + y2) / 2 / img_h
    bw = (x2 - x1) / img_w
    bh = (y2 - y1) / img_h
    return f"{d.class_id} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}"


# ---------------------------------------------------------------------------
# メイン処理
# ---------------------------------------------------------------------------

# ユーザ入力 (--types) → メソッド名 マップ
TYPE_GROUP_TO_METHODS: dict[str, list[str]] = {
    "crease": ["crease"],
    "dent": ["dent"],
    "indent": ["dent"],
    "corner": ["corner_damage"],
    "corner_damage": ["corner_damage"],
    "scratch": ["scratch"],
    "stain": ["stain"],
    "roller": ["roller_line"],
    "warp": ["warp"],
    "all": ["crease", "dent", "corner_damage", "scratch", "stain", "roller_line", "warp"],
}


@timeit("synthesize")
def synthesize(
    input_dir: Path,
    output_dir: Path,
    count: int,
    types: list[str],
    cutpaste: bool = False,
    seed: int = 42,
    debug: bool = False,
) -> None:
    """合成データ生成のメインループ."""
    seed_everything(seed)
    rng = random.Random(seed)
    np_rng = np.random.default_rng(seed)

    # 入力画像収集
    imgs = sorted([
        p for p in input_dir.rglob("*")
        if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    ])
    if not imgs:
        raise FileNotFoundError(f"入力ディレクトリ {input_dir} に画像がありません")
    logger.info(f"入力健全画像 {len(imgs)} 枚を発見")

    # 注入器
    injector = DamageInjector(rng=rng)

    # 出力先 (YOLO 形式 + マスク)
    img_dir = ensure_dir(output_dir / "images")
    lbl_dir = ensure_dir(output_dir / "labels")
    mask_dir = ensure_dir(output_dir / "masks")
    meta_path = output_dir / "meta.jsonl"

    # 注入する手法を method 名のフラットリストに展開
    methods: list[str] = []
    for t in types:
        if t not in TYPE_GROUP_TO_METHODS:
            logger.warning(f"未知の type: {t} → 無視")
            continue
        methods.extend(TYPE_GROUP_TO_METHODS[t])
    methods = sorted(set(methods))
    if not methods:
        raise ValueError("有効な --types 指定がありません")
    logger.info(f"注入する損傷手法: {methods}")

    if debug:
        count = min(count, 32)
        logger.info(f"[debug] count={count} に縮小")

    meta_f = open(meta_path, "w", encoding="utf-8")
    try:
        for i in tqdm(range(count), desc="synthesize"):
            base = cv2.imread(str(imgs[i % len(imgs)]))
            if base is None:
                continue
            base = cv2.cvtColor(base, cv2.COLOR_BGR2RGB)
            base = cv2.resize(base, (TARGET_W, TARGET_H), interpolation=cv2.INTER_AREA)
            base = base_augment(base, rng)

            # 1〜3 件ランダムに損傷を注入
            n_dmgs = rng.choices([1, 2, 3], weights=[0.6, 0.3, 0.1])[0]
            instances: list[DamageInstance] = []
            cur = base.copy()
            for _ in range(n_dmgs):
                method = rng.choice(methods)
                severity = rng.choices(SEVERITY_LEVELS, weights=[0.45, 0.35, 0.20])[0]
                fn = getattr(injector, method)
                cur, inst = fn(cur, severity)
                instances.append(inst)

            # CutPaste オプション (異常検出用にラベル無し画像を別途出力したい場合は別ディレクトリ推奨)
            if cutpaste and rng.random() < 0.3:
                cur, _ = cutpaste_augment(cur, rng)

            # 保存
            stem = f"syn_{i:06d}"
            img_path = img_dir / f"{stem}.jpg"
            cv2.imwrite(str(img_path), cv2.cvtColor(cur, cv2.COLOR_RGB2BGR),
                        [cv2.IMWRITE_JPEG_QUALITY, 92])

            # 統合マスク
            union_mask = np.zeros((TARGET_H, TARGET_W), dtype=np.uint8)
            for inst in instances:
                union_mask = cv2.max(union_mask, inst.mask)
            cv2.imwrite(str(mask_dir / f"{stem}.png"), union_mask)

            # YOLO ラベル
            yolo_lines = [to_yolo_label(inst, TARGET_W, TARGET_H) for inst in instances]
            (lbl_dir / f"{stem}.txt").write_text("\n".join(yolo_lines), encoding="utf-8")

            # メタ
            meta_f.write(json.dumps({
                "id": stem,
                "image": str(img_path.relative_to(output_dir)),
                "label": str((lbl_dir / f"{stem}.txt").relative_to(output_dir)),
                "mask": str((mask_dir / f"{stem}.png").relative_to(output_dir)),
                "damages": [
                    {
                        "class_name": inst.class_name,
                        "class_id": inst.class_id,
                        "severity": inst.severity,
                        "bbox_xyxy": list(inst.bbox_xyxy),
                    }
                    for inst in instances
                ],
            }, ensure_ascii=False) + "\n")
    finally:
        meta_f.close()

    logger.info(f"合成完了: {count} 枚 → {output_dir}")
    # data.yaml も書き出し
    write_yolo_yaml(output_dir)


def write_yolo_yaml(output_dir: Path) -> None:
    """YOLO 用の data.yaml を出力."""
    yaml_path = output_dir / "data.yaml"
    content = (
        f"# 合成データセット用 YOLO data.yaml\n"
        f"# synthesize_data.py で自動生成\n"
        f"path: {output_dir.resolve().as_posix()}\n"
        f"train: images\n"
        f"val: images\n"  # 学習スクリプトでスプリット
        f"nc: {len(CLASS_NAMES)}\n"
        f"names:\n"
    )
    for i, n in enumerate(CLASS_NAMES):
        content += f"  {i}: {n}\n"
    yaml_path.write_text(content, encoding="utf-8")
    logger.info(f"YOLO data.yaml を出力: {yaml_path}")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="カード損傷の合成データ生成")
    p.add_argument("--input", type=str, required=True, help="健全カード画像ディレクトリ")
    p.add_argument("--output", type=str, required=True, help="出力先")
    p.add_argument("--count", type=int, default=5000, help="生成枚数")
    p.add_argument(
        "--types",
        type=str,
        default="all",
        help="カンマ区切り (crease,dent,corner,scratch,stain,roller,warp,all)",
    )
    p.add_argument("--cutpaste", action="store_true", help="CutPaste 法を有効化")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--debug", action="store_true", help="32 枚だけ生成して動作確認")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    setup_logger()
    types = [t.strip() for t in args.types.split(",") if t.strip()]
    synthesize(
        input_dir=Path(args.input),
        output_dir=Path(args.output),
        count=args.count,
        types=types,
        cutpaste=args.cutpaste,
        seed=args.seed,
        debug=args.debug,
    )


if __name__ == "__main__":
    main()
