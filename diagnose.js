/**
 * 画像診断ページ — フロントエンドスクリプト
 * ============================================================
 *  - ファイルアップロード（D&D / クリック / カメラ / サンプル）
 *  - OpenCV.js による損傷検出（damage-detection-algorithms.md §4 移植）
 *  - 結果の Canvas 描画 + 損傷リスト生成
 *  - manual.md 該当章への別タブ遷移リンク生成
 *
 * 依存: OpenCV.js (CDN, 非同期ロード), DOMPurify (CDN)
 */

(function () {
  'use strict';

  // ============================================================
  // 損傷タイプ メタ情報
  // ============================================================
  const DAMAGE_TYPES = {
    crease:           { jp: '折れ目',           color: '#ff5252' },
    crease_severe:    { jp: '折れ目（重度）',   color: '#d32f2f' },
    crease_light:     { jp: '折れ目（軽度）',   color: '#ff8f52' },
    indent:           { jp: '凹み',             color: '#ff9800' },
    dent_severe:      { jp: '凹み（重度）',     color: '#e65100' },
    dent_light:       { jp: '凹み（軽度）',     color: '#ffb852' },
    warp:             { jp: '反り',             color: '#ffd152' },
    distortion:       { jp: '歪み',             color: '#a352ff' },
    corner_damage:    { jp: '角の損傷',         color: '#52d4ff' },
    corner_crush:     { jp: '角の潰れ',         color: '#0288d1' },
    corner_peel:      { jp: '角のめくれ',       color: '#5279ff' },
    edge_whitening:   { jp: 'エッジ白欠け',     color: '#52ffaa' },
    scratch_line:     { jp: '横線・小傷',       color: '#9c52ff' },
    holo_crease:      { jp: 'ホロ表面の折り目', color: '#ff52d4' },
    surface_dirt:     { jp: '表面汚れ',         color: '#a0a0a0' },
    print_line:       { jp: '製造由来の線(mur)', color: '#707070' },
    stain:            { jp: 'シミ',             color: '#5292ff' },
    stain_water:      { jp: '水シミ',           color: '#1976d2' },
    back_wrinkle:     { jp: '裏面シワ・鱗',     color: '#ff5292' },
    roller_line:      { jp: 'ローラー線',       color: '#d452ff' },
    heatpen_clouding: { jp: 'ヒートペン変色',   color: '#ff52ff' },
  };

  // 損傷タイプ × 重症度 → 推奨手法 + manual.md アンカー
  // diagnose-ux-design.md §2 の完全マッピング表に基づく
  const REPAIR_METHOD_MAP = {
    'crease.light':           [ { name: '加湿クランプ', chapter: '#section-6-1', summary: '軽度の折れ目には加湿クランプで充分なケースが多い。', priority: 1 } ],
    'crease.moderate':        [ { name: '強加湿クランプ + ヒートペン', chapter: '#section-6-2', summary: '中度の折れ目は強加湿で柔らかくしてからヒートペン仕上げ。', priority: 1 },
                                { name: 'ヒートペン単体', chapter: '#section-6-5', summary: 'ホロ層に対して直接アプローチ。', priority: 2 } ],
    'crease.severe':          [ { name: '強加湿クランプ + ヒートペン + ヒートプレス', chapter: '#section-6-2', summary: '重度の折れ目は強加湿→ヒートペン→ヒートプレスの3段構え。', priority: 1 },
                                { name: 'ヒートプレス（仕上げ）', chapter: '#section-6-7', summary: '最終仕上げに 57℃/30分のヒートプレス。', priority: 2 } ],
    'indent.light':           [ { name: 'ピンポイント滴下 / 手＋吐息', chapter: '#section-6-4', summary: '軽度の凹みはピンポイント滴下や手＋吐息加湿で改善。', priority: 1 },
                                { name: '加湿クランプ', chapter: '#section-6-1', summary: 'それでも残るなら加湿クランプ。', priority: 2 } ],
    'indent.moderate':        [ { name: '加湿クランプ', chapter: '#section-6-1', summary: '中度の凹みは加湿クランプで時間をかけて。', priority: 1 },
                                { name: 'ヒュミドール加湿', chapter: '#section-6-3', summary: '改善が遅い場合は 12〜24h のヒュミドール。', priority: 2 } ],
    'indent.severe':          [ { name: '強加湿クランプ + ヒートプレス', chapter: '#section-6-2', summary: '重度の凹みは強加湿でしっかり戻し、ヒートプレスで仕上げ。', priority: 1 },
                                { name: 'ヒートプレス', chapter: '#section-6-7', summary: '最終仕上げ。', priority: 2 } ],
    'warp.light':             [ { name: '加湿クランプ + 乾燥クランプ', chapter: '#section-6-1', summary: '軽度の反りは加湿→乾燥クランプで戻す。', priority: 1 } ],
    'warp.moderate':          [ { name: 'ヒュミドール + 乾燥クランプ', chapter: '#section-6-3', summary: '中度の反りはヒュミドールでじっくり。', priority: 1 },
                                { name: '乾燥クランプ', chapter: '#section-6-6', summary: '乾燥工程で平面化。', priority: 2 } ],
    'warp.severe':            [ { name: '強加湿クランプ + ヒートプレス', chapter: '#section-6-2', summary: '重度の反りは強加湿後にヒートプレスで矯正。', priority: 1 },
                                { name: 'ヒートプレス', chapter: '#section-6-7', summary: '57℃/30分で平面化。', priority: 2 } ],
    'corner_damage.light':    [ { name: '手＋吐息加湿', chapter: '#section-6-10', summary: '指温と吐息でじんわり加湿。', priority: 1 },
                                { name: 'ストロー加湿', chapter: '#section-6-9', summary: '改善が薄ければストロー加湿で局所湿気。', priority: 2 } ],
    'corner_damage.moderate': [ { name: 'ストロー加湿', chapter: '#section-6-9', summary: '中度の角は局所湿気＋指圧。', priority: 1 },
                                { name: '加湿クランプ', chapter: '#section-6-1', summary: '改善が薄ければ全体加湿クランプへ。', priority: 2 } ],
    'corner_damage.severe':   [ { name: '加湿クランプ', chapter: '#section-6-1', summary: '重度の角は無理せず加湿クランプで戻す。', priority: 1, warnings: ['完全には戻らない可能性あり'] } ],
    'stain.light':            [ { name: '吸取紙挟み + クランプ一晩', chapter: '#section-7-2', summary: '軽度の水シミは吸取紙＋クランプで一晩。', priority: 1 } ],
    'stain.moderate':         [ { name: '強加湿 + リカバリー', chapter: '#section-7-2', summary: '中度のシミは強加湿後リカバリー処理。', priority: 1 } ],
    'stain.severe':           [ { name: 'ヒートプレス', chapter: '#section-6-7', summary: '重度のシミはヒートプレスで仕上げ。', priority: 1, warnings: ['取れない場合は触らない判断も重要'] } ],
  };

  // 撮影サンプル URL（実体は後で配置。読込失敗時はインメモリ生成画像にフォールバック）
  const SAMPLES = [
    { label: '凹みあり',    url: 'samples/sample-dent.jpg',    fallbackType: 'dent' },
    { label: '折れ目あり',  url: 'samples/sample-crease.jpg',  fallbackType: 'crease' },
    { label: '健全カード',  url: 'samples/sample-healthy.jpg', fallbackType: 'healthy' },
  ];

  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
  const RECT_W = 750, RECT_H = 1050; // 正面化後のサイズ（damage-detection-algorithms.md §1.2）

  // ============================================================
  // DOM
  // ============================================================
  const $ = (id) => document.getElementById(id);
  const dropzone           = $('section-upload');
  const fileInput          = $('file-input');
  const cameraInput        = $('camera-input');
  const btnSelect          = $('btn-select');
  const btnCamera          = $('btn-camera');
  const btnSample          = $('btn-sample');
  const btnRedo            = $('btn-redo');
  const btnExport          = $('btn-export');
  const btnErrorRetry      = $('btn-error-retry');
  const analysisProgress   = $('analysis-progress');
  const progressLabel      = $('progress-label');
  const progressStep       = $('progress-step');
  const progressBarFill    = $('progress-bar-fill');
  const resultsPanel       = $('section-results');
  const detectionCount     = $('detection-count');
  const detectionList      = $('detection-list');
  const overallRecommendation = $('overall-recommendation');
  const primaryChapterLinks   = $('primary-chapter-links');
  const errorState         = $('error-state');
  const errorTitle         = $('error-title');
  const errorMessage       = $('error-message');
  const errorHints         = $('error-hints');
  const canvasBase         = $('canvas-base');
  const canvasOverlay      = $('canvas-overlay');
  const canvasTooltip      = $('canvas-tooltip');
  const demoBanner         = $('demo-banner');
  const themeToggle        = $('theme-toggle');
  const cvStatus           = $('cv-status');
  const sidebarToggle      = $('sidebar-toggle');
  const sidebarEl          = $('sidebar');
  const metaCount          = $('meta-count');
  const metaConfidence     = $('meta-confidence');
  const metaEngine         = $('meta-engine');

  // 状態
  let currentImage = null;        // HTMLImageElement
  let currentResult = null;       // 検出結果 JSON
  let currentDetections = [];     // 描画用（ピクセル座標）
  let cvReady = false;
  let cvLoadFailed = false;
  let cvReadyPromise = null;
  let pendingFile = null;         // OpenCV.js ロード前にユーザーがアップロードした場合の保留

  // ============================================================
  // テーマ（既存サイト script.js と localStorage を共有）
  // ============================================================
  function initTheme() {
    const saved = localStorage.getItem('cardrepair-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
    if (themeToggle) themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('cardrepair-theme', next);
      themeToggle.textContent = next === 'dark' ? '☀️' : '🌙';
    });
  }
  initTheme();

  // ============================================================
  // サイドバー（モバイル）
  // ============================================================
  if (sidebarToggle && sidebarEl) {
    sidebarToggle.addEventListener('click', () => {
      sidebarEl.classList.toggle('is-open');
    });
  }

  // ============================================================
  // デモバナー
  // ============================================================
  if (demoBanner) {
    const closeBtn = demoBanner.querySelector('.demo-banner-close');
    if (closeBtn) closeBtn.addEventListener('click', () => { demoBanner.hidden = true; });
  }

  // ============================================================
  // OpenCV.js のロード監視
  // ============================================================
  function setCvStatus(status, text) {
    if (!cvStatus) return;
    cvStatus.dataset.status = status;
    const t = cvStatus.querySelector('.cv-status-text');
    const i = cvStatus.querySelector('.cv-status-icon');
    if (t) t.textContent = text;
    if (i) {
      i.textContent = status === 'ready' ? '✅' : status === 'failed' ? '⚠️' : '⏳';
    }
    if (status === 'ready') {
      // 数秒後に隠す
      setTimeout(() => { if (cvStatus) cvStatus.hidden = true; }, 3000);
    }
  }

  // 複数のCDNを順番に試す（最初に成功したものを使う）
  const OPENCV_CDN_URLS = [
    'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
    'https://docs.opencv.org/4.10.0/opencv.js',
    'https://docs.opencv.org/4.x/opencv.js',
    'https://unpkg.com/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js'
  ];

  function loadScript(url, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.async = true;
      script.src = url;
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        script.remove();
        reject(new Error('timeout'));
      }, timeoutMs);
      script.onload = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(script);
      };
      script.onerror = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        script.remove();
        reject(new Error('script error'));
      };
      document.head.appendChild(script);
    });
  }

  function waitForOpenCVRuntime(timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      function check() {
        if (window.cv && typeof window.cv.Mat === 'function') {
          resolve(window.cv);
          return;
        }
        if (window.cv && window.cv.onRuntimeInitialized !== undefined) {
          const prev = window.cv.onRuntimeInitialized;
          window.cv.onRuntimeInitialized = () => {
            if (typeof prev === 'function') { try { prev(); } catch (_) {} }
            resolve(window.cv);
          };
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error('runtime init timeout'));
          return;
        }
        setTimeout(check, 200);
      }
      check();
    });
  }

  async function waitForOpenCV() {
    if (cvReadyPromise) return cvReadyPromise;
    cvReadyPromise = (async () => {
      // 既にロード済みの場合
      if (window.cv && typeof window.cv.Mat === 'function') {
        cvReady = true;
        setCvStatus('ready', '✅ 検出エンジン (OpenCV.js) の準備完了');
        return window.cv;
      }
      let lastErr = null;
      for (let i = 0; i < OPENCV_CDN_URLS.length; i++) {
        const url = OPENCV_CDN_URLS[i];
        const host = new URL(url).hostname;
        setCvStatus('loading', `⏳ 検出エンジン (OpenCV.js) を読み込み中… (${host})`);
        try {
          await loadScript(url, 30000);
          await waitForOpenCVRuntime(30000);
          cvReady = true;
          setCvStatus('ready', `✅ 検出エンジン (OpenCV.js) の準備完了 (${host})`);
          return window.cv;
        } catch (err) {
          lastErr = err;
          console.warn(`[diagnose] OpenCV CDN failed: ${host} (${err.message})`);
          // 次のCDNを試す前に window.cv をリセット
          if (window.cv && typeof window.cv.Mat !== 'function') {
            try { delete window.cv; } catch (_) { window.cv = undefined; }
          }
        }
      }
      cvLoadFailed = true;
      const msg = '⚠️ OpenCV.js の読み込みに失敗しました（全CDN応答なし）。ネットワーク・広告ブロッカー・拡張機能をご確認ください。';
      setCvStatus('failed', msg);
      throw lastErr || new Error('all CDNs failed');
    })();
    return cvReadyPromise;
  }
  // 即座にロードを開始
  waitForOpenCV().catch(err => console.warn('[diagnose] OpenCV load:', err.message));

  // ============================================================
  // アップロード関連
  // ============================================================
  function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }

  if (dropzone) {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => {
      dropzone.addEventListener(ev, preventDefaults);
    });
    ['dragenter', 'dragover'].forEach(ev => {
      dropzone.addEventListener(ev, () => dropzone.classList.add('is-dragover'));
    });
    ['dragleave', 'drop'].forEach(ev => {
      dropzone.addEventListener(ev, () => dropzone.classList.remove('is-dragover'));
    });
    dropzone.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) handleFile(files[0]);
    });
    dropzone.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      fileInput.click();
    });
    dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
  }

  if (btnSelect) btnSelect.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
  if (btnCamera) btnCamera.addEventListener('click', (e) => { e.stopPropagation(); cameraInput.click(); });
  if (btnSample) btnSample.addEventListener('click', (e) => { e.stopPropagation(); pickSample(); });

  if (fileInput)   fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  if (cameraInput) cameraInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });

  if (btnRedo) btnRedo.addEventListener('click', () => { hideResults(); fileInput.click(); });
  if (btnExport) btnExport.addEventListener('click', exportPNG);
  if (btnErrorRetry) btnErrorRetry.addEventListener('click', () => { hideError(); fileInput.click(); });

  // ============================================================
  // サンプル選択
  // ============================================================
  function pickSample() {
    const labels = SAMPLES.map((s, i) => `${i + 1}. ${s.label}`).join('\n');
    const ans = prompt(`サンプル番号を入力してください:\n${labels}`);
    if (ans === null) return;
    const idx = parseInt(ans, 10) - 1;
    if (!isFinite(idx) || idx < 0 || idx >= SAMPLES.length) {
      return showError({ code: 'invalid_input', message: 'サンプル番号が不正です。', hint: '1〜' + SAMPLES.length + ' の数字を入力してください。' });
    }
    const sample = SAMPLES[idx];

    fetch(sample.url)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
      .then(blob => new File([blob], sample.url.split('/').pop(), { type: blob.type || 'image/jpeg' }))
      .then(handleFile)
      .catch(err => {
        // 実体ファイル不在時はインメモリで合成サンプルを生成（PoC用）
        console.warn('[diagnose] sample fetch failed, generating fallback:', err.message);
        const file = generateSyntheticSample(sample.fallbackType);
        if (file) {
          handleFile(file);
        } else {
          showError({ code: 'sample_load_failed', message: 'サンプル画像の読み込みに失敗しました', hint: err.message });
        }
      });
  }

  // 合成サンプル画像を生成（実ファイルが存在しない場合のフォールバック）
  function generateSyntheticSample(type) {
    try {
      const cw = 750, ch = 1050;
      const canvas = document.createElement('canvas');
      canvas.width = cw + 200; canvas.height = ch + 200;
      const ctx = canvas.getContext('2d');
      // 背景（暗）
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // カード本体
      const cx = 100, cy = 100;
      const grad = ctx.createLinearGradient(cx, cy, cx + cw, cy + ch);
      grad.addColorStop(0, '#f8d97a');
      grad.addColorStop(0.5, '#e8b85a');
      grad.addColorStop(1, '#c89a3a');
      ctx.fillStyle = grad;
      ctx.fillRect(cx, cy, cw, ch);
      // 内側枠
      ctx.fillStyle = '#cfa54a';
      ctx.fillRect(cx + 30, cy + 30, cw - 60, ch - 60);
      // アート部分
      ctx.fillStyle = '#7fa5ce';
      ctx.fillRect(cx + 60, cy + 100, cw - 120, 400);
      // 下部テキスト枠
      ctx.fillStyle = '#fff8e0';
      ctx.fillRect(cx + 60, cy + 550, cw - 120, 350);

      // 損傷パターンを合成
      if (type === 'dent') {
        // 凹みっぽい暗い領域
        const ggrad = ctx.createRadialGradient(cx + 400, cy + 700, 0, cx + 400, cy + 700, 50);
        ggrad.addColorStop(0, 'rgba(0,0,0,0.5)');
        ggrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = ggrad;
        ctx.beginPath(); ctx.arc(cx + 400, cy + 700, 50, 0, Math.PI * 2); ctx.fill();
      } else if (type === 'crease') {
        // 折れ目: 横方向の暗い線 + 隣の明るい線
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(cx + 100, cy + 500);
        ctx.lineTo(cx + cw - 100, cy + 510);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx + 100, cy + 504);
        ctx.lineTo(cx + cw - 100, cy + 514);
        ctx.stroke();
      }
      // healthy はそのまま

      return new Promise((resolve) => {
        canvas.toBlob(b => {
          if (!b) return resolve(null);
          resolve(new File([b], `synthetic-${type}.jpg`, { type: 'image/jpeg' }));
        }, 'image/jpeg', 0.92);
      });
    } catch (e) {
      return null;
    }
  }

  // ============================================================
  // メイン: ファイル処理
  // ============================================================
  async function handleFile(file) {
    if (file && typeof file.then === 'function') {
      file = await file;
      if (!file) return;
    }
    hideError();

    // バリデーション
    if (!ALLOWED_MIME.includes(file.type)) {
      return showError({
        code: 'invalid_format',
        message: 'JPEG / PNG / WebP のみ対応しています。',
        hint: `受信した形式: ${file.type || '不明'}`,
      });
    }
    if (file.size > MAX_FILE_SIZE) {
      return showError({
        code: 'file_too_large',
        message: `画像サイズが ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB を超えています。`,
        hint: `現在のサイズ: ${(file.size / 1024 / 1024).toFixed(1)}MB`,
      });
    }

    // 画像読み込み
    showProgress(5, '画像を読み込み中', 1);
    try {
      currentImage = await loadImage(file);
    } catch (err) {
      return showError({ code: 'load_failed', message: '画像の読み込みに失敗しました', hint: err.message });
    }

    // OpenCV.js のロードを待機
    showProgress(15, '検出エンジン (OpenCV.js) の準備中', 2);
    try {
      await waitForOpenCV();
    } catch (err) {
      return showError({
        code: 'model_load_failed',
        message: '検出エンジン (OpenCV.js) の読み込みに失敗しました',
        hint: 'ページを再読み込みするか、ネットワーク接続をご確認ください。',
      });
    }

    // 解析実行
    showProgress(35, 'カードを検出・正面化中', 2);
    let result;
    try {
      result = await analyzeCardFromImage(currentImage, file);
    } catch (err) {
      console.error('[diagnose] analyze failed:', err);
      return showError({ code: 'internal_error', message: err.message || '解析中にエラーが発生しました', hint: 'お手数ですが別の画像で再度お試しください。' });
    }

    if (result.error === 'card_not_detected') {
      return showError({
        code: 'card_not_found',
        message: 'カードが認識できません',
        hint: '明るい背景・カード全体が枠内に収まるよう正面から撮影し、再度お試しください。',
        hints: [
          'カードの四隅が枠内にすべて収まっていますか？',
          '真上から撮影していますか？（斜め撮影は失敗の原因）',
          '背景とカードのコントラスト（黒い背景がおすすめ）',
          'ピントは合っていますか？',
        ],
      });
    }

    currentResult = result;
    showProgress(85, '結果を描画中', 4);
    renderResults(result);
    hideProgress();
    showResults();
    setTimeout(() => {
      resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('画像をデコードできませんでした'));
      img.src = url;
    });
  }

  // ============================================================
  // OpenCV.js による検出パイプライン
  //   damage-detection-algorithms.md §4 の関数群を移植
  // ============================================================

  /**
   * メインエントリ: 画像から損傷を検出して結果 JSON を返す
   */
  async function analyzeCardFromImage(img, file) {
    const cv = window.cv;
    // 入力を canvas に描く（cv.imread 用）
    const inputCanvas = document.createElement('canvas');
    // 大きすぎる画像は最大辺 1600px に縮小（処理速度のため）
    const MAX_DIM = 1600;
    let iw = img.naturalWidth, ih = img.naturalHeight;
    const maxSide = Math.max(iw, ih);
    let scale = 1;
    if (maxSide > MAX_DIM) {
      scale = MAX_DIM / maxSide;
      iw = Math.round(iw * scale);
      ih = Math.round(ih * scale);
    }
    inputCanvas.width = iw;
    inputCanvas.height = ih;
    inputCanvas.getContext('2d').drawImage(img, 0, 0, iw, ih);

    showProgress(45, 'カード境界を検出中', 2);
    await new Promise(r => setTimeout(r, 30)); // UI更新を許す

    let src = null, rect = null;
    try {
      src = cv.imread(inputCanvas);

      // 反り検出（正面化前の画像で行う）
      const warpResult = safeCall(() => detectWarp(src), 'detectWarp');

      // カード矩形検出 → 正面化
      const r = safeCall(() => rectifyCard(src), 'rectifyCard');
      if (!r) {
        src.delete();
        return { error: 'card_not_detected' };
      }
      rect = r.rect;

      showProgress(55, '照明を正規化中', 2);
      await new Promise(r2 => setTimeout(r2, 30));
      // 照明正規化
      safeCall(() => normalizeIllumination(rect), 'normalizeIllumination');

      // 各損傷を検出
      showProgress(60, '折れ目を検出中', 3);
      await new Promise(r2 => setTimeout(r2, 20));
      const creases = safeCall(() => detectCreases(rect), 'detectCreases') || [];

      showProgress(68, '凹みを検出中', 3);
      await new Promise(r2 => setTimeout(r2, 20));
      const indents = safeCall(() => detectIndents(rect), 'detectIndents') || [];

      showProgress(74, '角の損傷を検出中', 3);
      await new Promise(r2 => setTimeout(r2, 20));
      const corners = safeCall(() => detectCornerDamage(rect), 'detectCornerDamage') || [];

      showProgress(80, 'シミを検出中', 3);
      await new Promise(r2 => setTimeout(r2, 20));
      const stains = safeCall(() => detectStains(rect), 'detectStains') || [];

      const damages = [...creases, ...indents, ...corners, ...stains];
      if (warpResult && warpResult.severity) damages.push(warpResult);

      // ID 付与・ラベル整形
      damages.forEach((d, i) => {
        d.id = `d${i + 1}`;
        const meta = DAMAGE_TYPES[d.type] || { jp: d.type, color: '#888' };
        d.type_label_jp = meta.jp;
        d.severity_label_jp = severityLabel(d.severity);
        d.highlight_color = meta.color;
        d.label_short = `${meta.jp} (${d.severity_label_jp})`;
        // 推奨手法
        const key = `${d.type}.${d.severity}`;
        const methods = REPAIR_METHOD_MAP[key]
                     || REPAIR_METHOD_MAP[`${d.type}.moderate`]
                     || REPAIR_METHOD_MAP[`${d.type}.light`]
                     || [{ name: 'マニュアル本体で確認', chapter: '#chapter-1', summary: 'クイック診断チャートで詳細を確認', priority: 1 }];
        d.repair_methods = methods;
        // 説明文
        d.explanation = buildExplanation(d);
        // ピクセル座標の bbox（描画用）— 正面化後の rect 座標系を保持
        if (d.geom && d.geom.kind === 'bbox' && d.geom.norm) {
          const [nx1, ny1, nx2, ny2] = d.geom.norm;
          d.bbox_pixel = [nx1 * RECT_W, ny1 * RECT_H, nx2 * RECT_W, ny2 * RECT_H];
        } else if (d.geom && d.geom.kind === 'polyline' && d.geom.points_norm) {
          const xs = d.geom.points_norm.map(p => p[0] * RECT_W);
          const ys = d.geom.points_norm.map(p => p[1] * RECT_H);
          d.bbox_pixel = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        }
      });

      // 後始末
      src.delete(); rect.delete();
      src = null; rect = null;

      // 結果 JSON 構築
      return buildResultJSON(img, file, damages);
    } catch (err) {
      // エラー時はマット解放
      try { if (src) src.delete(); } catch (_) {}
      try { if (rect) rect.delete(); } catch (_) {}
      throw err;
    }
  }

  function safeCall(fn, name) {
    try { return fn(); }
    catch (e) {
      console.warn(`[diagnose] ${name} failed:`, e);
      return null;
    }
  }

  function buildExplanation(d) {
    const sev = d.severity_label_jp || severityLabel(d.severity);
    if (d.type === 'crease') {
      const len = d.length_mm ? d.length_mm.toFixed(1) : '?';
      return `折れ目候補（${sev}）を検出。推定長 ${len}mm。`;
    }
    if (d.type === 'indent') {
      const a = d.metrics && d.metrics.area_mm2 ? d.metrics.area_mm2.toFixed(1) : '?';
      return `凹み候補（${sev}）を検出。面積 ${a}mm²。`;
    }
    if (d.type === 'corner_damage') {
      const c = d.corner || '?';
      const r = d.metrics && d.metrics.missing_ratio ? (d.metrics.missing_ratio * 100).toFixed(1) : '?';
      return `${c} の角に欠損候補（${sev}）。欠損率 ${r}%。`;
    }
    if (d.type === 'stain') {
      const a = d.metrics && d.metrics.area_mm2 ? d.metrics.area_mm2.toFixed(1) : '?';
      return `シミ候補（${sev}）。面積 ${a}mm²。`;
    }
    if (d.type === 'warp') {
      const m = d.metrics && d.metrics.max_deviation_mm ? d.metrics.max_deviation_mm.toFixed(2) : '?';
      return `カード全体に反り（${sev}）。最大変位 ${m}mm。`;
    }
    return `${d.type_label_jp || d.type}（${sev}）を検出。`;
  }

  // ----- §4.1 カード境界検出 → 正面化 -----
  function rectifyCard(srcMat) {
    const cv = window.cv;
    const gray = new cv.Mat();
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

    const edges = new cv.Mat();
    cv.Canny(gray, edges, 50, 150);
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const candidates = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      candidates.push({ i, area: cv.contourArea(c), contour: c });
    }
    candidates.sort((a, b) => b.area - a.area);

    let cardQuad = null;
    for (const cand of candidates.slice(0, 8)) {
      const peri = cv.arcLength(cand.contour, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cand.contour, approx, 0.02 * peri, true);
      if (approx.rows === 4) {
        const pts = [];
        for (let j = 0; j < 4; j++) {
          pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
        }
        const sorted = sortQuadCorners(pts);
        const w = dist(sorted[0], sorted[1]);
        const h = dist(sorted[0], sorted[3]);
        const ratio = Math.min(w, h) / Math.max(w, h);
        if (Math.abs(ratio - 0.7159) < 0.15 && Math.min(w, h) > 50) {
          cardQuad = sorted;
          approx.delete();
          break;
        }
      }
      approx.delete();
    }

    gray.delete(); edges.delete(); kernel.delete();
    hierarchy.delete(); contours.delete();

    if (!cardQuad) return null;

    const W = RECT_W, H = RECT_H;
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      cardQuad[0].x, cardQuad[0].y,
      cardQuad[1].x, cardQuad[1].y,
      cardQuad[2].x, cardQuad[2].y,
      cardQuad[3].x, cardQuad[3].y,
    ]);
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W - 1, 0, W - 1, H - 1, 0, H - 1]);
    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    const rect = new cv.Mat();
    cv.warpPerspective(srcMat, rect, M, new cv.Size(W, H));

    srcPts.delete(); dstPts.delete(); M.delete();
    return { rect, quad: cardQuad };
  }

  function sortQuadCorners(pts) {
    const sums = pts.map(p => p.x + p.y);
    const diffs = pts.map(p => p.x - p.y);
    return [
      pts[sums.indexOf(Math.min(...sums))],   // TL
      pts[diffs.indexOf(Math.max(...diffs))], // TR
      pts[sums.indexOf(Math.max(...sums))],   // BR
      pts[diffs.indexOf(Math.min(...diffs))], // BL
    ];
  }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // ----- §4.2 CLAHE 照明正規化 -----
  function normalizeIllumination(rectMat) {
    const cv = window.cv;
    const lab = new cv.Mat();
    cv.cvtColor(rectMat, lab, cv.COLOR_RGBA2RGB);
    cv.cvtColor(lab, lab, cv.COLOR_RGB2Lab);

    const channels = new cv.MatVector();
    cv.split(lab, channels);
    const L = channels.get(0);

    const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
    clahe.apply(L, L);
    channels.set(0, L);
    cv.merge(channels, lab);
    cv.cvtColor(lab, lab, cv.COLOR_Lab2RGB);
    cv.cvtColor(lab, rectMat, cv.COLOR_RGB2RGBA);

    channels.delete(); lab.delete(); clahe.delete();
    return rectMat;
  }

  // ----- §4.3 折れ目検出 (HoughLinesP) -----
  function detectCreases(rectMat) {
    const cv = window.cv;
    const gray = new cv.Mat();
    cv.cvtColor(rectMat, gray, cv.COLOR_RGBA2GRAY);

    const filtered = new cv.Mat();
    cv.bilateralFilter(gray, filtered, 9, 75, 75);

    const edges = new cv.Mat();
    cv.Canny(filtered, edges, 30, 100);

    const lines = new cv.Mat();
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 50, 60, 10);

    const W = rectMat.cols, H = rectMat.rows;
    const PX_TO_MM = 63.0 / W;

    const results = [];
    for (let i = 0; i < lines.rows; i++) {
      const x1 = lines.data32S[i * 4 + 0];
      const y1 = lines.data32S[i * 4 + 1];
      const x2 = lines.data32S[i * 4 + 2];
      const y2 = lines.data32S[i * 4 + 3];
      const lengthPx = Math.hypot(x2 - x1, y2 - y1);
      const lengthMm = lengthPx * PX_TO_MM;

      // カード固有のテキスト枠（上部/下部）を除外
      const yMid = (y1 + y2) / 2 / H;
      if (yMid < 0.07 || yMid > 0.93) continue;

      let severity = 'light';
      if (lengthMm >= 30) severity = 'severe';
      else if (lengthMm >= 10) severity = 'moderate';

      const confidence = Math.min(1.0, lengthMm / 60);

      results.push({
        type: 'crease',
        x1, y1, x2, y2,
        length_mm: lengthMm,
        severity,
        confidence,
        geom: {
          kind: 'polyline',
          points_norm: [[x1 / W, y1 / H], [x2 / W, y2 / H]],
        },
      });
    }

    gray.delete(); filtered.delete(); edges.delete(); lines.delete();
    return mergeNearbyLines(results).slice(0, 10); // 表示上限
  }

  function mergeNearbyLines(lines) {
    const merged = [];
    const used = new Set();
    for (let i = 0; i < lines.length; i++) {
      if (used.has(i)) continue;
      let cur = { ...lines[i] };
      for (let j = i + 1; j < lines.length; j++) {
        if (used.has(j)) continue;
        if (areLinesSimilar(cur, lines[j])) {
          cur = mergeLinePair(cur, lines[j]);
          used.add(j);
        }
      }
      used.add(i);
      merged.push(cur);
    }
    return merged;
  }

  function areLinesSimilar(a, b) {
    const ang = (l) => Math.atan2(l.y2 - l.y1, l.x2 - l.x1);
    const dAng = Math.abs(ang(a) - ang(b)) % Math.PI;
    if (dAng > 0.087 && dAng < Math.PI - 0.087) return false;
    const minDist = Math.min(
      Math.hypot(a.x2 - b.x1, a.y2 - b.y1),
      Math.hypot(a.x1 - b.x2, a.y1 - b.y2),
      Math.hypot(a.x1 - b.x1, a.y1 - b.y1),
      Math.hypot(a.x2 - b.x2, a.y2 - b.y2),
    );
    return minDist < 15;
  }

  function mergeLinePair(a, b) {
    const pts = [
      { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 },
      { x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 },
    ];
    let maxD = 0, p1 = pts[0], p2 = pts[1];
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d > maxD) { maxD = d; p1 = pts[i]; p2 = pts[j]; }
    }
    return {
      ...a,
      x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
      length_mm: maxD * (63.0 / RECT_W),
      geom: {
        kind: 'polyline',
        points_norm: [[p1.x / RECT_W, p1.y / RECT_H], [p2.x / RECT_W, p2.y / RECT_H]],
      },
    };
  }

  // ----- §4.4 凹み検出 (背景輝度減算) -----
  function detectIndents(rectMat) {
    const cv = window.cv;
    const lab = new cv.Mat();
    cv.cvtColor(rectMat, lab, cv.COLOR_RGBA2RGB);
    cv.cvtColor(lab, lab, cv.COLOR_RGB2Lab);
    const channels = new cv.MatVector();
    cv.split(lab, channels);
    const L = channels.get(0);

    const Lf = new cv.Mat();
    cv.bilateralFilter(L, Lf, 7, 50, 50);

    const bg = new cv.Mat();
    cv.GaussianBlur(Lf, bg, new cv.Size(51, 51), 0);

    const diff = new cv.Mat();
    const mask0 = new cv.Mat();
    cv.subtract(Lf, bg, diff, mask0, cv.CV_16S);

    const dark = new cv.Mat();
    cv.threshold(diff, dark, -8, 255, cv.THRESH_BINARY_INV);
    dark.convertTo(dark, cv.CV_8U);

    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.morphologyEx(dark, dark, cv.MORPH_OPEN, k);

    const stats = new cv.Mat();
    const centroids = new cv.Mat();
    const labels = new cv.Mat();
    const num = cv.connectedComponentsWithStats(dark, labels, stats, centroids);

    const W = rectMat.cols, H = rectMat.rows;
    const PX_TO_MM = 63.0 / W;
    const cardAreaMm2 = 63 * 88;

    const results = [];
    for (let i = 1; i < num; i++) {
      const x = stats.intAt(i, cv.CC_STAT_LEFT);
      const y = stats.intAt(i, cv.CC_STAT_TOP);
      const w = stats.intAt(i, cv.CC_STAT_WIDTH);
      const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
      const area = stats.intAt(i, cv.CC_STAT_AREA);
      const areaMm2 = area * PX_TO_MM * PX_TO_MM;

      if (areaMm2 < 2) continue;
      if (areaMm2 > cardAreaMm2 * 0.3) continue;

      // 平均暗度（残差）を計算
      let darkSum = 0, count = 0;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          if (labels.intAt(yy, xx) === i) {
            darkSum += -diff.shortAt(yy, xx);
            count++;
          }
        }
      }
      const avgDark = count > 0 ? darkSum / count : 0;

      let severity = 'light';
      if (avgDark >= 30 || areaMm2 >= 150) severity = 'severe';
      else if (avgDark >= 15 || areaMm2 >= 30) severity = 'moderate';

      results.push({
        type: 'indent',
        severity,
        confidence: Math.min(1.0, avgDark / 40),
        bbox: { x, y, w, h },
        metrics: { area_mm2: areaMm2, avg_intensity: avgDark },
        geom: {
          kind: 'bbox',
          norm: [x / W, y / H, (x + w) / W, (y + h) / H],
        },
      });
    }

    channels.delete(); lab.delete(); Lf.delete(); bg.delete();
    diff.delete(); mask0.delete(); dark.delete(); k.delete();
    stats.delete(); centroids.delete(); labels.delete();

    // 強度上位だけ採用
    return results.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
  }

  // ----- §4.5 角の損傷検出 -----
  function detectCornerDamage(rectMat) {
    const cv = window.cv;
    const W = rectMat.cols, H = rectMat.rows;
    const ROI = 80;

    const corners = [
      { name: 'TL', x: 0,         y: 0 },
      { name: 'TR', x: W - ROI,   y: 0 },
      { name: 'BR', x: W - ROI,   y: H - ROI },
      { name: 'BL', x: 0,         y: H - ROI },
    ];

    const results = [];
    for (const c of corners) {
      const roi = rectMat.roi(new cv.Rect(c.x, c.y, ROI, ROI));
      const gray = new cv.Mat();
      cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);

      const fg = new cv.Mat();
      cv.threshold(gray, fg, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

      const ideal = cv.Mat.zeros(ROI, ROI, cv.CV_8U);
      ideal.setTo(new cv.Scalar(255));

      const xor = new cv.Mat();
      cv.bitwise_xor(fg, ideal, xor);
      const missingPx = cv.countNonZero(xor);
      const missingRatio = missingPx / (ROI * ROI);

      let severity = null;
      if (missingRatio > 0.15) severity = 'severe';
      else if (missingRatio > 0.05) severity = 'moderate';
      else if (missingRatio > 0.01) severity = 'light';

      if (severity) {
        results.push({
          type: 'corner_damage',
          corner: c.name,
          severity,
          confidence: Math.min(1.0, missingRatio * 5),
          metrics: { missing_ratio: missingRatio },
          geom: {
            kind: 'bbox',
            norm: [c.x / W, c.y / H, (c.x + ROI) / W, (c.y + ROI) / H],
          },
        });
      }

      roi.delete(); gray.delete(); fg.delete(); ideal.delete(); xor.delete();
    }
    return results;
  }

  // ----- §4.6 シミ検出 -----
  function detectStains(rectMat) {
    const cv = window.cv;
    const hsv = new cv.Mat();
    cv.cvtColor(rectMat, hsv, cv.COLOR_RGBA2RGB);
    cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

    const ch = new cv.MatVector();
    cv.split(hsv, ch);
    const S = ch.get(1);

    const lower = new cv.Mat(rectMat.rows, rectMat.cols, cv.CV_8UC3, new cv.Scalar(10, 40, 100));
    const upper = new cv.Mat(rectMat.rows, rectMat.cols, cv.CV_8UC3, new cv.Scalar(30, 180, 230));
    const mask = new cv.Mat();
    cv.inRange(hsv, lower, upper, mask);

    const Sf = new cv.Mat();
    cv.GaussianBlur(S, Sf, new cv.Size(31, 31), 0);
    const dullMask = new cv.Mat();
    cv.compare(S, Sf, dullMask, cv.CMP_LT);

    const combined = new cv.Mat();
    cv.bitwise_and(mask, dullMask, combined);

    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.morphologyEx(combined, combined, cv.MORPH_OPEN, k);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(combined, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const W = rectMat.cols, Ht = rectMat.rows;
    const PX_TO_MM = 63.0 / W;
    const results = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area < 50) continue;
      const r = cv.boundingRect(c);
      const areaMm2 = area * PX_TO_MM * PX_TO_MM;

      let severity = 'light';
      if (areaMm2 > 50) severity = 'severe';
      else if (areaMm2 > 15) severity = 'moderate';

      results.push({
        type: 'stain',
        severity,
        confidence: Math.min(1.0, areaMm2 / 100),
        metrics: { area_mm2: areaMm2 },
        geom: {
          kind: 'bbox',
          norm: [r.x / W, r.y / Ht, (r.x + r.width) / W, (r.y + r.height) / Ht],
        },
      });
    }

    ch.delete(); hsv.delete();
    lower.delete(); upper.delete(); mask.delete();
    Sf.delete(); dullMask.delete(); combined.delete();
    k.delete(); contours.delete(); hierarchy.delete();

    return results.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
  }

  // ----- §4.7 反り判定 -----
  function detectWarp(srcMat) {
    const cv = window.cv;
    const gray = new cv.Mat();
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const edges = new cv.Mat();
    cv.Canny(gray, edges, 50, 150);

    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

    let maxArea = 0, idx = -1;
    for (let i = 0; i < contours.size(); i++) {
      const a = cv.contourArea(contours.get(i));
      if (a > maxArea) { maxArea = a; idx = i; }
    }
    if (idx < 0) {
      gray.delete(); edges.delete(); contours.delete(); hier.delete();
      return null;
    }

    const cnt = contours.get(idx);
    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.01 * peri, true);

    let maxDevPx = 0;
    if (approx.rows >= 4) {
      const hull = new cv.Mat();
      cv.convexHull(cnt, hull);
      const hullArea = cv.contourArea(hull);
      const minRect = cv.minAreaRect(cnt);
      const rectArea = minRect.size.width * minRect.size.height;
      const fillRatio = rectArea > 0 ? hullArea / rectArea : 1;
      maxDevPx = Math.max(0, (1.0 - fillRatio) * minRect.size.width);
      hull.delete();
    }

    const PX_TO_MM = 63.0 / RECT_W;
    const warpMm = maxDevPx * PX_TO_MM;

    let severity = null;
    if (warpMm >= 1.5) severity = 'severe';
    else if (warpMm >= 0.5) severity = 'moderate';
    else if (warpMm >= 0.2) severity = 'light';

    approx.delete();
    gray.delete(); edges.delete(); contours.delete(); hier.delete();

    if (!severity) return null;
    return {
      type: 'warp',
      severity,
      confidence: Math.min(1.0, warpMm / 2),
      metrics: { max_deviation_mm: warpMm },
      geom: { kind: 'card_global' },
    };
  }

  function severityLabel(s) {
    return ({ mild: '軽微', light: '軽度', moderate: '中度', severe: '重度', critical: '深刻' })[s] || s;
  }

  // ============================================================
  // 結果 JSON 構築
  // ============================================================
  function buildResultJSON(img, file, detections) {
    const order = { mild: 0, light: 1, moderate: 2, severe: 3, critical: 4 };
    const highest = detections.reduce((acc, d) => order[d.severity] > order[acc] ? d.severity : acc, 'mild');
    const overall = detections.length ? avg(detections.map(d => d.confidence)) : 0;

    return {
      schema_version: '1.0',
      engine: { name: 'heuristic-cv', version: '0.1.0', is_demo: true, model_loaded_at: new Date().toISOString() },
      diagnosed_at: new Date().toISOString(),
      image: {
        filename: file.name, mime: file.type,
        width: img.naturalWidth, height: img.naturalHeight,
        card_bbox: null, card_corners: null,
        orientation: img.naturalWidth > img.naturalHeight ? 'landscape' : 'portrait',
        side: 'front',
      },
      detections,
      summary: {
        total_detections: detections.length,
        highest_severity: highest,
        overall_confidence: overall,
        overall_recommendation: detections.length === 0
          ? '✅ 明確な損傷は検出されませんでした。健全な状態の可能性が高いです。'
          : `${detections.length} 件の損傷候補を検出しました。各損傷カードの「詳細手順を見る」からマニュアル該当章をご確認ください。`,
        primary_chapter_links: [
          { label: 'クイック診断チャート', href: '#chapter-1' },
          { label: 'NGカードでないか確認', href: '#chapter-2' },
          { label: '修復手法カタログ', href: '#chapter-4' },
          { label: '標準サイクル', href: '#section-3-3' },
        ],
      },
      errors: [],
      warnings: detections.length === 0 ? [{ code: 'no_detections', message: '損傷は検出されませんでした。' }] : [],
    };
  }

  function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

  // ============================================================
  // 結果描画
  // ============================================================
  function renderResults(result) {
    currentDetections = result.detections;
    drawCanvas(currentImage, result.detections);

    if (metaCount)      metaCount.textContent = result.summary.total_detections;
    if (metaConfidence) metaConfidence.textContent = result.summary.total_detections
      ? Math.round(result.summary.overall_confidence * 100) + '%'
      : '—';
    if (metaEngine) metaEngine.textContent = `${result.engine.name} v${result.engine.version}`;

    if (detectionCount) detectionCount.textContent = `(${result.summary.total_detections} 件)`;
    if (detectionList) detectionList.innerHTML = '';

    if (result.detections.length === 0) {
      const html = `
        <div class="detection-empty">
          <p>✅ 明確な損傷は検出されませんでした</p>
          <p>念のため <a href="index.html#chapter-1" target="_blank" rel="noopener">クイック診断チャート</a> でご自身でも確認することをお勧めします。</p>
          <p>※ 検出器の精度には限界があります。違和感がある場合は撮影角度を変えて再診断してください。</p>
        </div>`;
      if (detectionList) detectionList.innerHTML = sanitize(html);
    } else {
      result.detections.forEach((d, i) => {
        if (detectionList) detectionList.appendChild(buildDetectionCard(d, i + 1));
      });
    }

    if (overallRecommendation) overallRecommendation.textContent = result.summary.overall_recommendation;
    if (primaryChapterLinks) {
      const html = (result.summary.primary_chapter_links || [])
        .map(l => `<li><a href="index.html${escapeAttr(l.href)}" target="_blank" rel="noopener">📖 ${escapeHTML(l.label)}</a></li>`)
        .join('');
      primaryChapterLinks.innerHTML = sanitize(html);
    }
  }

  function buildDetectionCard(d, num) {
    const article = document.createElement('article');
    article.className = 'detection-card';
    article.dataset.detectionId = d.id;
    article.dataset.severity = d.severity;
    article.tabIndex = 0;

    const methodsHTML = (d.repair_methods || []).map((m) => {
      const isPrimary = (m.priority || 1) === 1;
      const warningsHTML = (m.warnings && m.warnings.length)
        ? `<div class="method-warnings"><strong>⚠️ 注意:</strong><ul>${m.warnings.map(w => `<li>${escapeHTML(w)}</li>`).join('')}</ul></div>`
        : '';
      const inner = `
        <strong>${escapeHTML(m.name)}</strong>
        ${m.summary ? `<p>${escapeHTML(m.summary)}</p>` : ''}
        ${warningsHTML}
        <a class="method-link" href="index.html${escapeAttr(m.chapter)}" target="_blank" rel="noopener">📖 詳細手順を見る (${escapeHTML(m.chapter)}) →</a>
      `;
      return isPrimary
        ? `<li class="method method-primary">${inner}</li>`
        : `<li class="method method-fallback"><details><summary>うまくいかない場合: ${escapeHTML(m.name)}</summary>${inner}</details></li>`;
    }).join('');

    const metricsHTML = d.metrics
      ? `<div class="detection-metrics">${
          Object.entries(d.metrics).map(([k, v]) =>
            `<span class="detection-metric">${escapeHTML(k)}: ${typeof v === 'number' ? v.toFixed(2) : escapeHTML(String(v))}</span>`
          ).join('')
        }</div>`
      : '';

    const html = `
      <header class="detection-card-header">
        <span class="detection-badge" aria-hidden="true">${num}</span>
        <h3 class="detection-title">${escapeHTML(d.type_label_jp || d.type)}</h3>
        <span class="severity-pill severity-${escapeAttr(d.severity)}">${escapeHTML(d.severity_label_jp || severityLabel(d.severity))}</span>
      </header>
      <div class="confidence">
        <span class="confidence-label">信頼度</span>
        <div class="confidence-bar" role="progressbar" aria-valuenow="${Math.round(d.confidence * 100)}" aria-valuemin="0" aria-valuemax="100">
          <div class="confidence-fill" style="width:${(d.confidence * 100).toFixed(1)}%;"></div>
        </div>
        <span class="confidence-value">${Math.round(d.confidence * 100)}%</span>
      </div>
      ${d.explanation ? `<p class="detection-explanation">${escapeHTML(d.explanation)}</p>` : ''}
      ${metricsHTML}
      <div class="repair-methods">
        <h4>推奨修復手法</h4>
        <ol class="repair-method-list">${methodsHTML}</ol>
      </div>
    `;
    article.innerHTML = sanitize(html);

    article.addEventListener('click', (e) => {
      if (e.target.closest('a, button, summary')) return;
      highlightOnCanvas(d.id);
    });
    article.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (e.target.closest('a, button, summary')) return;
        e.preventDefault();
        highlightOnCanvas(d.id);
      }
    });
    return article;
  }

  // ============================================================
  // Canvas 描画
  // ============================================================
  function drawCanvas(img, detections) {
    if (!canvasBase || !canvasOverlay) return;
    const ctxBase = canvasBase.getContext('2d');
    const ctxOver = canvasOverlay.getContext('2d');

    // 表示用の論理ピクセル: 元画像サイズをそのまま使う（CSS で縮小）
    const cw = img.naturalWidth;
    const ch = img.naturalHeight;
    canvasBase.width = canvasOverlay.width = cw;
    canvasBase.height = canvasOverlay.height = ch;
    ctxBase.clearRect(0, 0, cw, ch);
    ctxBase.drawImage(img, 0, 0, cw, ch);
    ctxOver.clearRect(0, 0, cw, ch);

    // 検出結果は 750x1050 の正面化座標系 → 元画像座標系へは厳密には逆変換が必要だが
    // PoC では正面化矩形を元画像中央に等倍マッピングするのが視覚的に分かりやすいため、
    // 元画像全体に対する相対比で配置する（簡易マッピング）
    // → bbox_pixel は rect 座標系 (RECT_W x RECT_H)。元画像サイズへスケール
    const scaleX = cw / RECT_W;
    const scaleY = ch / RECT_H;

    detections.forEach((d, i) => {
      drawDetectionOnImage(ctxOver, d, i + 1, scaleX, scaleY);
    });

    setupCanvasInteraction(detections, scaleX, scaleY);
  }

  function drawDetectionOnImage(ctx, d, num, sx, sy) {
    const color = d.highlight_color || (DAMAGE_TYPES[d.type] || {}).color || '#ff5252';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color + '33';
    ctx.lineWidth = Math.max(3, ctx.canvas.width / 350);

    let bx = 0, by = 0;
    if (d.geom && d.geom.kind === 'polyline' && d.geom.points_norm) {
      ctx.beginPath();
      d.geom.points_norm.forEach((p, i) => {
        const x = p[0] * RECT_W * sx;
        const y = p[1] * RECT_H * sy;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        if (i === 0) { bx = x; by = y; }
      });
      ctx.stroke();
    } else if (d.geom && d.geom.kind === 'bbox' && d.geom.norm) {
      const [nx1, ny1, nx2, ny2] = d.geom.norm;
      const x1 = nx1 * RECT_W * sx;
      const y1 = ny1 * RECT_H * sy;
      const w = (nx2 - nx1) * RECT_W * sx;
      const h = (ny2 - ny1) * RECT_H * sy;
      ctx.fillRect(x1, y1, w, h);
      ctx.strokeRect(x1, y1, w, h);
      bx = x1; by = y1;
    } else if (d.geom && d.geom.kind === 'card_global') {
      // カード全体: 外枠を破線で
      ctx.setLineDash([10, 6]);
      ctx.strokeRect(8, 8, ctx.canvas.width - 16, ctx.canvas.height - 16);
      ctx.setLineDash([]);
      bx = 30; by = 30;
    }

    // 番号バッジ
    const badgeR = Math.max(20, ctx.canvas.width / 50);
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${badgeR * 1.1}px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), bx, by);

    // バッジ位置を保存（hit-test 用）
    d._badge_xy = [bx, by, badgeR];

    ctx.restore();
  }

  function setupCanvasInteraction(detections, sx, sy) {
    if (!canvasOverlay) return;
    canvasOverlay.onpointermove = (e) => {
      const pt = canvasPoint(e);
      const hit = detections.find(d => isHit(d, pt));
      if (hit) {
        if (canvasTooltip) {
          canvasTooltip.textContent = hit.label_short || hit.type_label_jp || hit.type;
          canvasTooltip.style.left = e.clientX + 'px';
          canvasTooltip.style.top = e.clientY + 'px';
          canvasTooltip.hidden = false;
        }
        canvasOverlay.style.cursor = 'pointer';
      } else {
        if (canvasTooltip) canvasTooltip.hidden = true;
        canvasOverlay.style.cursor = 'default';
      }
    };
    canvasOverlay.onpointerleave = () => {
      if (canvasTooltip) canvasTooltip.hidden = true;
    };
    canvasOverlay.onclick = (e) => {
      const pt = canvasPoint(e);
      const hit = detections.find(d => isHit(d, pt));
      if (hit) {
        const card = detectionList && detectionList.querySelector(`[data-detection-id="${hit.id}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.add('is-active');
          setTimeout(() => card.classList.remove('is-active'), 2000);
        }
      }
    };
  }

  function canvasPoint(e) {
    const rect = canvasOverlay.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvasOverlay.width / rect.width),
      y: (e.clientY - rect.top) * (canvasOverlay.height / rect.height),
    };
  }

  function isHit(d, pt) {
    // バッジ円のヒットテスト優先
    if (d._badge_xy) {
      const [bx, by, br] = d._badge_xy;
      if (Math.hypot(pt.x - bx, pt.y - by) < br * 1.6) return true;
    }
    // bbox ヒット
    if (d.geom && d.geom.kind === 'bbox' && d.geom.norm) {
      const [nx1, ny1, nx2, ny2] = d.geom.norm;
      const x1 = nx1 * RECT_W * (canvasOverlay.width / RECT_W);
      const y1 = ny1 * RECT_H * (canvasOverlay.height / RECT_H);
      const x2 = nx2 * RECT_W * (canvasOverlay.width / RECT_W);
      const y2 = ny2 * RECT_H * (canvasOverlay.height / RECT_H);
      return pt.x >= x1 && pt.x <= x2 && pt.y >= y1 && pt.y <= y2;
    }
    return false;
  }

  function highlightOnCanvas(detId) {
    if (!currentResult) return;
    const d = currentResult.detections.find(x => x.id === detId);
    if (!d) return;
    const ctx = canvasOverlay.getContext('2d');
    const cw = canvasOverlay.width, ch = canvasOverlay.height;
    const sx = cw / RECT_W, sy = ch / RECT_H;
    let pulses = 0;
    const id = setInterval(() => {
      ctx.clearRect(0, 0, cw, ch);
      currentResult.detections.forEach((dd, i) => {
        const isTarget = dd.id === detId;
        ctx.globalAlpha = isTarget ? (pulses % 2 === 0 ? 1 : 0.45) : 0.6;
        drawDetectionOnImage(ctx, dd, i + 1, sx, sy);
      });
      ctx.globalAlpha = 1;
      pulses++;
      if (pulses >= 6) clearInterval(id);
    }, 220);
  }

  // ============================================================
  // 進行表示 / 結果表示 / エラー
  // ============================================================
  function showProgress(pct, label, step) {
    if (!analysisProgress) return;
    analysisProgress.hidden = false;
    if (resultsPanel) resultsPanel.hidden = true;
    if (errorState) errorState.hidden = true;
    if (progressLabel) progressLabel.textContent = label;
    if (progressStep) progressStep.textContent = `ステップ ${step}/4: ${label}`;
    if (progressBarFill) progressBarFill.style.width = pct + '%';
    const bar = analysisProgress.querySelector('.progress-bar');
    if (bar) bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  }
  function hideProgress() { if (analysisProgress) analysisProgress.hidden = true; }
  function showResults() { if (resultsPanel) resultsPanel.hidden = false; }
  function hideResults() { if (resultsPanel) resultsPanel.hidden = true; }

  /**
   * エラー表示
   * @param {{code, message, hint?, hints?}} err
   */
  function showError(err) {
    hideProgress(); hideResults();
    if (!errorState) {
      console.error('[diagnose error]', err);
      alert(`${err.message}\n${err.hint || ''}`);
      return;
    }
    errorState.hidden = false;

    const titleByCode = {
      invalid_format:    '❌ 対応していない形式です',
      file_too_large:    '❌ ファイルサイズ超過',
      load_failed:       '❌ 画像を読み込めませんでした',
      card_not_found:    '❌ カードが認識できません',
      card_off_angle:    '❌ 撮影角度の問題',
      too_dark:          '⚠️ 画像が暗すぎます',
      too_bright:        '⚠️ 画像が明るすぎます',
      blurry:            '⚠️ ピントがずれています',
      model_load_failed: '❌ 検出エンジンの読み込みに失敗',
      sample_load_failed:'❌ サンプル画像の読み込みに失敗',
      no_detections:     'ℹ️ 損傷は検出されませんでした',
      internal_error:    '❌ 予期しないエラーが発生しました',
    };

    if (errorTitle) errorTitle.textContent = titleByCode[err.code] || 'エラーが発生しました';
    if (errorMessage) errorMessage.textContent = err.message || '';
    if (errorHints) {
      let hints = err.hints || (err.hint ? [err.hint] : []);
      errorHints.innerHTML = hints.length
        ? hints.map(h => `<li>${escapeHTML(h)}</li>`).join('')
        : '';
      errorHints.hidden = !hints.length;
    }
    errorState.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function hideError() { if (errorState) errorState.hidden = true; }

  // ============================================================
  // PNG 保存（html2canvas 遅延ロード）
  // ============================================================
  async function exportPNG() {
    try {
      if (!window.html2canvas) {
        await loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js');
      }
      const canvas = await window.html2canvas(resultsPanel, {
        backgroundColor: getComputedStyle(document.body).backgroundColor || '#fff',
        scale: 1.5,
      });
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `diagnose-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      showError({ code: 'internal_error', message: '保存に失敗しました', hint: err.message });
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('script load failed: ' + src));
      document.head.appendChild(s);
    });
  }

  // ============================================================
  // ユーティリティ: HTML エスケープ + DOMPurify
  // ============================================================
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function sanitize(html) {
    if (window.DOMPurify) {
      return window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
    }
    return html;
  }

  // ============================================================
  // 既存サイト index.html のヘッダーへ「📷 診断」リンク追加（同一オリジン）
  //   → このページからは触れないが、別ページで本スクリプトが読まれた時用
  // ============================================================
  // ※ 仕様により index.html 自体は触らない。本ページ専用。

  console.log('[diagnose] initialized.');
})();
