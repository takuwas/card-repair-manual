# カード損傷検出モデル 学習パイプライン

このディレクトリは **ポケモンカードの損傷を自動検出する深層学習モデル** を学習・エクスポートするための Python パイプラインです。

最終的に **ONNX (INT8)** を出力し、フロントエンドで `onnxruntime-web` から読み込んで使うことを想定しています。

## アーキテクチャ概要

`working/ml-architecture-research.md` で推奨されている **3 段スタック** を実装:

1. **EfficientAD** (`anomalib`) — 健全カードのみで学習する**異常検出**。ピクセル単位の異常マップを出力。
2. **YOLOv8n / YOLO11n** (`ultralytics`) — 17 クラス (D01〜D17) の**物体検出**。
3. **EfficientNet-B0 / MobileNetV3-small** (`torchvision`) — ROI **損傷タイプ分類**。

クラス定義 (D01〜D17) は `working/diagnose-ux-design.md §1` および `python/utils.py:DAMAGE_CLASSES` を参照。

---

## ファイル構成

```
python/
├── README.md                  この文書
├── requirements.txt           Python 依存
├── utils.py                   共通ユーティリティ (ロガー / 損傷クラス定義 / デコレータ)
│
├── synthesize_data.py         合成データ生成 (健全カードに損傷を注入)
├── train_anomaly.py           EfficientAD 学習
├── train_yolo.py              YOLOv8n 学習
├── train_classifier.py        EfficientNet-B0 学習
├── export_onnx.py             ONNX 化 + INT8 量子化
├── evaluate.py                mAP / F1 / 混同行列 評価
├── inference.py               学習済みモデルで 1 枚診断 (UX スキーマ準拠 JSON)
│
├── split_yolo.py              データ分割 (train/val/test)
├── crop_rois.py               分類器用に bbox から ROI を切り出し
│
└── dataset/
    └── README.md              データセット雛形
```

---

## 1. セットアップ

### Python 環境

Python 3.10 以上を推奨。

```bash
cd python
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
```

### GPU セットアップ (推奨)

CUDA 12.1 環境では PyTorch が自動でデフォルトを使います。
明示的にインストールしたい場合:

```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
```

CPU のみでも動きますが、学習はかなり時間がかかります。
**Google Colab (T4) や RTX 3060 以上を推奨**。

### 動作確認 (`--debug`)

各学習スクリプトには `--debug` フラグが用意されています。
小さいバッチ・少ないエポックで動作確認できます。

```bash
python synthesize_data.py --input dataset/healthy --output dataset/synthetic --debug
python train_yolo.py --data dataset/data.yaml --debug
```

---

## 2. データ準備

### 2.1 健全カードを撮影 (Day 1〜3)

- **iPhone マクロ** + **黒い台紙の上で拡散光**で 200 枚以上撮影
- `dataset/healthy/*.jpg` に配置 (フラットでよい)

### 2.2 (任意) 実損傷カードを撮影

- 50 枚以上あると validation/test 用に有効
- `dataset/damaged/images/*.jpg`, `dataset/damaged/labels/*.txt` (YOLO 形式)
- ラベリングツール: [Label Studio](https://labelstud.io) / [Roboflow](https://roboflow.com)

詳細は `dataset/README.md` を参照。

---

## 3. 合成データ生成

健全カードからプログラムで損傷を注入し、教師データを大量生成します。

```bash
python synthesize_data.py \
    --input dataset/healthy \
    --output dataset/synthetic \
    --count 5000 \
    --types all
```

オプション:
- `--types crease,dent,corner,scratch,stain,roller,warp` — 注入する損傷タイプ
- `--cutpaste` — CutPaste 法 (CVPR 2021) を有効化
- `--debug` — 32 枚だけ生成

出力:
- `dataset/synthetic/images/syn_NNNNNN.jpg` — 合成画像 (750×1050)
- `dataset/synthetic/labels/syn_NNNNNN.txt` — YOLO ラベル
- `dataset/synthetic/masks/syn_NNNNNN.png` — マスク (U-Net 用)
- `dataset/synthetic/meta.jsonl` — 詳細メタ
- `dataset/synthetic/data.yaml` — YOLO 用 data config

### 3.1 train/val/test に分割

```bash
python split_yolo.py \
    --source dataset/synthetic \
    --output dataset \
    --ratios 0.8 0.1 0.1
```

→ `dataset/{train,val,test}/{images,labels}/` と `dataset/data.yaml` が生成される。

### 3.2 (分類器用) ROI 切り出し

```bash
python crop_rois.py \
    --source dataset/synthetic \
    --output dataset/classifier \
    --val-ratio 0.1 \
    --no-damage-from dataset/healthy \
    --no-damage-count 1000
```

→ `dataset/classifier/{train,val}/<class_name>/*.jpg` 構造。

---

## 4. 学習

### 4.1 異常検出 (EfficientAD)

```bash
python train_anomaly.py \
    --data dataset/healthy \
    --epochs 100 \
    --batch 16 \
    --output models/efficientad
```

健全カードのみで学習可能。Google Colab T4 で 1 時間程度。
出力: `models/efficientad/.../best.ckpt`

### 4.2 物体検出 (YOLOv8n)

```bash
python train_yolo.py \
    --data dataset/data.yaml \
    --model yolov8n \
    --epochs 200 \
    --img 640 \
    --batch 16 \
    --output models/yolo
```

出力: `models/yolo/best.pt`
学習曲線・PR カーブは `models/yolo/train/` 配下に自動保存。

代替モデル: `yolo11n` (より新しい), `yolov8s` (高精度・大きい)。

### 4.3 ROI 分類器 (EfficientNet-B0)

```bash
python train_classifier.py \
    --data dataset/classifier \
    --backbone efficientnet_b0 \
    --epochs 50 \
    --batch 64 \
    --output models/classifier
```

軽量化重視なら `--backbone mobilenet_v3_small` (約半分のサイズ)。

出力: `models/classifier/best.pt`, `history.json`, `class_to_idx.json`

---

## 5. ONNX エクスポート + INT8 量子化

```bash
# 一括エクスポート (models/yolo, models/classifier, models/efficientad を自動検索)
python export_onnx.py --kind all --quantize

# 個別
python export_onnx.py --kind yolo \
    --weights models/yolo/best.pt \
    --output models/onnx/yolov8n_int8.onnx --quantize

python export_onnx.py --kind classifier \
    --weights models/classifier/best.pt \
    --output models/onnx/classifier_int8.onnx --quantize

python export_onnx.py --kind anomaly \
    --weights models/efficientad/.../best.ckpt \
    --output models/onnx/efficientad_int8.onnx --quantize
```

出力先:
- `models/onnx/yolov8n_int8.onnx` (~4-6MB)
- `models/onnx/classifier_int8.onnx` (~5MB)
- `models/onnx/efficientad_int8.onnx` (~8MB)

ONNX opset は `17` (WebGPU 対応, ORT Web 1.18+ で動作)。

---

## 6. 評価

```bash
python evaluate.py \
    --yolo-weights models/yolo/best.pt \
    --yolo-data dataset/data.yaml \
    --cls-weights models/classifier/best.pt \
    --cls-data dataset/classifier \
    --output output/eval
```

出力:
- `output/eval/yolo_metrics.json` — mAP / Precision / Recall (クラス別含む)
- `output/eval/classifier_metrics.json` — Accuracy / F1 (macro/weighted/per-class)
- `output/eval/confusion_matrix_classifier.png` — 混同行列
- `output/eval/eval_report.md` — Markdown サマリ

---

## 7. ローカル推論テスト

```bash
python inference.py \
    --image sample.jpg \
    --yolo models/onnx/yolov8n_int8.onnx \
    --anomaly models/onnx/efficientad_int8.onnx \
    --classifier models/onnx/classifier_int8.onnx \
    --output output/result.json
```

出力 JSON は `working/diagnose-ux-design.md §3` のスキーマに準拠。
フロントエンドで使う ONNX モデルとの動作対比に使えます。

---

## 8. フロントエンド統合手順

1. ONNX モデルを **Cloudflare R2 Public Bucket** にアップロード
   (理由: Cloudflare Pages の 25MiB/asset 制限を回避するため)
2. `public/models-manifest.json` に URL/sha256/size を記録
3. フロント `script.js` から `onnxruntime-web` で URL ロード

例 (R2):

```bash
aws s3 cp models/onnx/ s3://card-repair-models/v1/ --recursive \
    --endpoint-url https://<accountid>.r2.cloudflarestorage.com
```

manifest 例 (`ml-architecture-research.md §6-B` も参照):

```json
{
  "version": "1.0.0",
  "models": {
    "yolo":      { "url": "https://cdn.example.com/v1/yolov8n_int8.onnx",      "size_bytes": 5500000 },
    "anomaly":   { "url": "https://cdn.example.com/v1/efficientad_int8.onnx", "size_bytes": 8500000 },
    "classifier":{ "url": "https://cdn.example.com/v1/classifier_int8.onnx",  "size_bytes": 5200000 }
  }
}
```

`_headers` で CORS と COOP/COEP を設定 (WebGPU 用):

```
/models/*
  Access-Control-Allow-Origin: *
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cache-Control: public, max-age=31536000, immutable
```

---

## 9. 推奨ロードマップ

| フェーズ | データ要件 | 学習時間 (T4) | 期待精度 |
|---|---|---|---|
| **v0.5 PoC** | 合成 1000 枚 | 1〜2 時間 | 50〜60% |
| **v1.0 実用** | 健全 200 枚 + 損傷 50 枚 + 合成 5000〜10000 枚 | 6〜10 時間 | 75〜85% |
| **v2.0 本格** | + Stable Diffusion + LoRA で生成 10 万枚 | 20〜40 時間 | 90%+ |

詳細は `working/ml-architecture-research.md §5` を参照。

---

## 10. ライセンス上の注意

- **`ultralytics` (YOLOv8/v11) は AGPL-3.0**。本プロジェクトを公開する場合、ソース公開要件があります。
  クローズドソースで使うなら、**Ultralytics 商用ライセンス** を購入するか、
  Apache 2.0 系の **YOLOv5 (古いがライセンス緩い分岐あり)** や **RT-DETR / DETR** を検討してください。
- **`anomalib` (EfficientAD / PatchCore)**, **`torchvision`**, **`albumentations`**, **`onnxruntime`** は Apache 2.0 / MIT 系で問題ありません。
- 個人利用 (本パイプラインの想定) なら AGPL は問題なし。

---

## 11. トラブルシューティング

### `anomalib` の install で失敗する
`pip install anomalib==2.0.0` を試してください。
Windows では C++ ビルドツールが必要なケースがあります。

### YOLO 学習中に `RuntimeError: cuDNN error`
バッチサイズを下げる (`--batch 8` 等)、または `--workers 0` を指定。

### ONNX エクスポートが失敗する
- `onnxsim` が原因のことがあります。`pip install --upgrade onnxsim` を実行。
- それでも駄目なら `--quantize` を外して FP32 ONNX で出力 → 別途量子化。

### Windows で multiprocessing エラー
学習スクリプトはデフォルトで `--workers 0` です。
それでも問題が起きる場合、`if __name__ == "__main__":` ガードが入っているので、
そのままスクリプトとして実行してください (notebook 経由は避ける)。

### メモリ不足 (16GB RAM/8GB VRAM 環境)
- `--batch 8`, `--img 480` で軽量化
- EfficientAD は `--image-size 224` まで下げられる

---

## 参考資料

- 推奨スタック詳細: `working/ml-architecture-research.md`
- 損傷タイプ別アルゴリズム: `working/damage-detection-algorithms.md`
- 損傷タイプの一覧 / UX: `working/diagnose-ux-design.md`
- 修復マニュアル本体: `manual.md`
