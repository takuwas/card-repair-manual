# ポケモンカード修復マニュアル【完全版】

CRSコミュニティ「ポケカリペア」での実践知見と公式マニュアルを統合した、ポケモンカード修復の網羅的ガイドです。

## 📂 リポジトリ構成

```
card-repair-manual/
├── manual.md          ← 公開用マニュアル本体（5934行 / 380KB / 11章）
├── source.md          ← Discord履歴の逐語ソース（文脈強化済み、参考用）
├── index.html         ← Webサイトのエントリポイント（SPA）
├── style.css          ← スタイルシート
├── script.js          ← フロントエンドスクリプト
├── README.md          ← このファイル
└── working/           ← 中間生成物（章別出力、検証レポート 等）
```

## 🌐 Webサイトとしての公開（GitHub + Cloudflare Pages）

このリポジトリをGitHubに公開し、Cloudflare Pagesで自動デプロイする手順。

### 仕組み

- `manual.md` を客側JavaScriptで取得して描画する **シングルページアプリ**
- ビルド工程は **不要**（静的ファイルをそのまま配信するだけ）
- `manual.md` を編集してgit pushすれば、Cloudflare Pagesが自動再デプロイ

### 機能

- **章リンク → 該当箇所にスムーズスクロール** + **黄色ハイライトアニメーション**
- 自動生成された **目次（TOC）** をサイドバーに表示
- スクロールに応じて **現在地をTOCで自動ハイライト**
- **検索機能**（タイトル + 本文、Ctrl+Kでフォーカス）
- **ダークモード**切替（システム設定に追従、手動切替も可、localStorageで記憶）
- **モバイル対応**（ハンバーガーメニュー）
- 注意ボックス（🚫 / ⚠️ / 📌 / 💡 / 💬）の **自動カラー分類**
- 外部リンクは新規ウィンドウで開く

### デプロイ手順

#### 1. GitHub にリポジトリを作成して push

```bash
cd /path/to/card-repair-manual
git init
git add index.html style.css script.js manual.md source.md README.md
git commit -m "Initial commit: pokeca repair manual"

# GitHub に新規リポジトリを作成（例: card-repair-manual）してから:
git remote add origin git@github.com:<your-username>/card-repair-manual.git
git branch -M main
git push -u origin main
```

> 📌 `working/` ディレクトリは中間生成物のため、`.gitignore` に追加するか個別コミット判断。

#### 2. Cloudflare Pages でプロジェクト作成

1. [Cloudflare Dashboard](https://dash.cloudflare.com/) にログイン
2. 左メニュー → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
3. GitHub と連携して、上記で作成したリポジトリを選択
4. ビルド設定:
   - **Production branch**: `main`
   - **Build command**: （空欄でOK、ビルド不要）
   - **Build output directory**: `/`（リポジトリルート）
5. **Save and Deploy** を押すと、数十秒後に `https://card-repair-manual.pages.dev` のような URL でアクセス可能に

#### 3. （任意）独自ドメインを設定

Cloudflare Pages のプロジェクト設定 → **Custom domains** で、自分のドメイン（例: `repair.example.com`）を追加。

### 編集 → 反映の流れ

```bash
# 1. manual.md を編集
$ vim manual.md

# 2. コミット & プッシュ
$ git add manual.md
$ git commit -m "Update: ヒートペン手順の補足"
$ git push

# 3. Cloudflare Pages が自動的に再デプロイ（1〜2分）
```

### ローカルでプレビュー

ブラウザで直接 `index.html` を開くと、CORS制約により `manual.md` のfetchが失敗する可能性があるため、簡易サーバーを起動してアクセス:

```bash
# Python 3
python -m http.server 8000
# ブラウザで http://localhost:8000 を開く

# または Node.js
npx serve .
```

## ⚙️ カスタマイズ

### 章リンクの形式

URL末尾の `#` の後に見出しIDを付けると該当箇所にジャンプ + 黄色ハイライト:
- `https://your-site.pages.dev/#chapter-1-クイック診断チャート`

見出しIDは Markdownの見出しテキストから自動生成されます（記号除去、空白→ハイフン）。

### 注意ボックスのカラー分類

`script.js` の `classifyCallouts()` 関数が blockquote の先頭絵文字を見て自動分類:

| 絵文字 | クラス | 色 |
|---|---|---|
| 🚫 | `callout-danger` | 赤 |
| ⚠️ | `callout-warning` | 黄 |
| 📌 | `callout-note` | 青 |
| 💡 | `callout-tip` | 紫 |
| 💬 | `callout-voice` | グレー（斜体） |
| 🔧 | `callout-tip` | 紫 |

色の調整は `style.css` の `.callout-*` 定義を編集。

### マニュアル本体の編集

`manual.md` のみを編集すれば反映されます。Markdownの構文は GitHub Flavored Markdown 準拠。

## 📚 出典

- **CRS Discord「ポケカリペア」コミュニティ**（2026/01/08〜2026/04/19）
- **Kurt's Card Care 製造元 Kurt** からの公式回答（2026/01/25）
- 公式マニュアル4種：加湿マニュアル / 乾燥マニュアル / ヒートペン修復マニュアル / ヒュミドール加湿マニュアル

## 📝 ライセンス

このマニュアルは内部参照用です。発信元のCRSコミュニティの方針に従って取り扱ってください。

「リペア裏技編」は CRS の方針により非公開のため、本マニュアルにも収録していません。
