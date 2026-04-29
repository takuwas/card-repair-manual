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
  const PX_TO_MM_DEFAULT = 63.0 / RECT_W;

  // ============================================================
  // 検出パラメータ（精度向上用の閾値）
  // ============================================================
  const DETECT_PARAMS = {
    // テキスト密度の高い領域（信頼度を減衰させる）
    textZones: [
      { name: 'top_text',    y1: 0.00, y2: 0.18 },  // ポケモン名・HP
      { name: 'bottom_text', y1: 0.62, y2: 0.95 },  // わざ・効果テキスト
      { name: 'footer',      y1: 0.93, y2: 1.00 },  // 弱点・コレクター情報
    ],
    artworkZone: { y1: 0.18, y2: 0.55 },  // アートワーク中央
    confidenceFloor: 0.12,  // これ未満は棄却（baseline検出の最低品質）
    nmsIoU: 0.5,
  };

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
  let currentCenteringOverlayEnabled = true;
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
  // CVステータスの表示制御:
  // - userIsWaiting=false (ページロード直後): UIには出さない（バックグラウンドで静かに進行）
  // - userIsWaiting=true (ユーザーがアップロード→解析待ち中): UIに出す
  // - 失敗時は常に出す（ユーザーが再操作する判断材料になるため）
  let userIsWaiting = false;
  function setCvStatus(status, text) {
    if (!cvStatus) return;
    cvStatus.dataset.status = status;
    const t = cvStatus.querySelector('.cv-status-text');
    const i = cvStatus.querySelector('.cv-status-icon');
    if (t) t.textContent = text;
    if (i) {
      i.textContent = status === 'ready' ? '✅' : status === 'failed' ? '⚠️' : '⏳';
    }
    if (status === 'failed') {
      // 失敗は常に表示（ユーザーが対処方法を知る必要があるため）
      cvStatus.hidden = false;
      return;
    }
    if (!userIsWaiting) {
      // ユーザーがまだ何もしていない → バナーは出さない
      cvStatus.hidden = true;
      return;
    }
    // userIsWaiting=true の時のみ表示
    cvStatus.hidden = false;
    if (status === 'ready') {
      // 数秒後に隠す
      setTimeout(() => { if (cvStatus) cvStatus.hidden = true; }, 2500);
    }
  }

  // 複数のCDNを順番に試す（最初に成功したものを使う）
  const OPENCV_CDN_URLS = [
    'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
    'https://docs.opencv.org/4.10.0/opencv.js',
    'https://docs.opencv.org/4.x/opencv.js',
    'https://unpkg.com/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js'
  ];

  // ★注意★ この loadScript は OpenCV.js 専用（タイムアウト付き）。
  // 関数名の衝突を避けるため、PNG保存などの汎用ロード用は loadExternalScript() に分離している。
  function loadScript(url, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.async = true;
      // crossOrigin を付けない: 単独テストで cv.Mat が 0.9秒で利用可能だったが、
      // crossOrigin='anonymous' を付けると永久にハングする現象を確認したため。
      // OpenCV.js (techstark v4.10) は単一ファイル（WASM埋め込み）なので CORS は不要。
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
      let done = false;

      // 確実なタイムアウト（onRuntimeInitialized コールバック待ちで止まらないように
      // setTimeout ベースで強制的に reject する）
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('runtime init timeout'));
      }, timeoutMs);

      function poll() {
        if (done) return;
        // 1. 完全に初期化済み？
        if (window.cv && typeof window.cv.Mat === 'function') {
          done = true;
          clearTimeout(timer);
          resolve(window.cv);
          return;
        }
        // 2. ファストパス: onRuntimeInitialized コールバックも登録しておく
        //    （コールバックが発火しなくても下のポーリングで救える）
        if (window.cv && window.cv.onRuntimeInitialized !== undefined && !window.cv._hookedByDiagnose) {
          window.cv._hookedByDiagnose = true;
          const prev = window.cv.onRuntimeInitialized;
          window.cv.onRuntimeInitialized = () => {
            if (typeof prev === 'function') { try { prev(); } catch (_) {} }
            // ポーリングがすぐ次の200msで拾うので resolve はそちらに任せる
          };
        }
        // 3. ポーリング継続（onRuntimeInitialized が無音失敗してもこちらで救える）
        setTimeout(poll, 200);
      }
      poll();
    });
  }

  async function waitForOpenCV() {
    if (cvReadyPromise) return cvReadyPromise;
    cvReadyPromise = new Promise((resolve, reject) => {
      // 既にロード済みの場合
      if (window.cv && typeof window.cv.Mat === 'function') {
        cvReady = true;
        setCvStatus('ready', '✅ 検出エンジン (OpenCV.js) の準備完了');
        resolve(window.cv);
        return;
      }

      // 重要: Emscripten の流儀で、script ロード前に Module を設定する。
      // onRuntimeInitialized で resolve するのが OpenCV.js の正しい使い方。
      // ポーリング方式は不要（minimal test では 0.9秒でこのコールバックが発火することを確認済み）。
      const TOTAL_TIMEOUT = 90000;
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cvLoadFailed = true;
        setCvStatus('failed', '⚠️ OpenCV.js のロードがタイムアウトしました。リロードまたはネットワーク確認をお願いします。');
        reject(new Error('opencv load timeout'));
      }, TOTAL_TIMEOUT);

      window.Module = window.Module || {};
      const prevOnRuntime = window.Module.onRuntimeInitialized;

      // 完了判定の共通処理。コールバック・ポーリングどちらでも先勝ちで成功扱い。
      const markReady = () => {
        if (done) return;
        if (!(window.cv && typeof window.cv.Mat === 'function')) return; // まだ未完
        done = true;
        clearTimeout(timer);
        cvReady = true;
        setCvStatus('ready', '✅ 検出エンジン (OpenCV.js) の準備完了');
        resolve(window.cv);
      };

      window.Module.onRuntimeInitialized = () => {
        if (typeof prevOnRuntime === 'function') { try { prevOnRuntime(); } catch (_) {} }
        // techstark v4.10 は cv.Mat がここで使えるはず
        markReady();
      };

      // バックアップ: 500ms ポーリング (setTimeout チェーン)
      // setInterval だと WASM 初期化中に複数回キューされてクラッシュ要因になる場合があるため
      function poll() {
        if (done) return;
        if (window.cv && typeof window.cv.Mat === 'function') {
          markReady();
          return;
        }
        setTimeout(poll, 500);
      }
      // 最初のポーリングは少し遅らせて WASM 初期化を妨げない
      setTimeout(poll, 1000);

      // CDN を順に試す（ダウンロード失敗時のみ次へ）
      let cdnIdx = 0;
      function tryNextCDN() {
        if (done) return;
        if (cdnIdx >= OPENCV_CDN_URLS.length) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          cvLoadFailed = true;
          setCvStatus('failed', '⚠️ OpenCV.js のダウンロードに失敗しました（全CDN応答なし）。');
          reject(new Error('all CDNs failed'));
          return;
        }
        const url = OPENCV_CDN_URLS[cdnIdx];
        const host = new URL(url).hostname;
        setCvStatus('loading', `⏳ 検出エンジンを読み込み中… (${host}、初回は10〜30秒)`);
        loadScript(url, 15000)
          .then(() => {
            // ダウンロード成功。あとは onRuntimeInitialized を待つ（上で登録済み）
            // setCvStatus はそのままにしておく（ユーザーには「読み込み中」と見える）
            console.log(`[diagnose] script loaded from ${host}, waiting for runtime init...`);
          })
          .catch((err) => {
            console.warn(`[diagnose] OpenCV CDN failed: ${host} (${err.message})`);
            cdnIdx++;
            tryNextCDN();
          });
      }
      tryNextCDN();
    });
    cvReadyPromise.catch(() => {}); // Unhandled rejection 抑止
    return cvReadyPromise;
  }
  // OpenCV.js はサイズが大きく（〜10MB）WASM 初期化でメインスレッドが一瞬重くなる。
  // ・preload (HTMLヘッダ) でダウンロードはページレンダリングと並行で進む
  // ・実行（コンパイル＋初期化）は DOM ready 後 500ms 遅延で開始
  //   → 初期表示はブロックしない
  // ・ユーザーがそれより早くアップロードした場合は handleFile() 内で同じ Promise を待機する
  // 注意: requestIdleCallback は環境によって発火しないことがあるため使用しない。
  function startOpenCVPrewarm() {
    setTimeout(() => {
      console.log('[diagnose] starting OpenCV prewarm');
      waitForOpenCV().catch(err => console.warn('[diagnose] OpenCV prewarm:', err.message));
    }, 500);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    startOpenCVPrewarm();
  } else {
    document.addEventListener('DOMContentLoaded', startOpenCVPrewarm, { once: true });
  }

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

  // ファイル input の value をクリアしておくことで、同じファイルを再選択した場合にも change が発火する
  if (fileInput)   fileInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) handleFile(f);
  });
  if (cameraInput) cameraInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) handleFile(f);
  });

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
  // 多重実行ガード（同じユーザー操作で複数ファイルが投げ込まれた場合の保険）
  let isHandlingFile = false;

  async function handleFile(file) {
    if (file && typeof file.then === 'function') {
      file = await file;
      if (!file) return;
    }
    if (!file) return;
    if (isHandlingFile) {
      console.warn('[diagnose] handleFile called while already running. Ignoring duplicate.');
      return;
    }
    isHandlingFile = true;

    // 全体ウォッチドッグ: 想定外のハングで「解析中…」が出っ放しになるのを防ぐ。
    // 想定:
    //   フェーズ1 ダウンロード: 15s × 最大4CDN = 60s
    //   フェーズ2 WASM初期化:    90s
    //   フェーズ3 解析:          ~10s
    //   合計最悪値: ~160s
    // それを少し超えた余裕として 200s に設定。
    const WATCHDOG_MS = 200000; // 200秒 (= 3.3分)
    let watchdogFired = false;
    const watchdogTimer = setTimeout(() => {
      watchdogFired = true;
      console.error('[diagnose] watchdog fired: handleFile took too long');
      // ハング中の await は永久に解決しない可能性があるため、ここで明示的にガードを解除し
      // ユーザーが再試行できるようにする（finally だけに頼らない）
      isHandlingFile = false;
      showError({
        code: 'internal_error',
        message: '処理がタイムアウトしました',
        hint: 'ネットワークが不安定か、検出エンジンの読み込みに時間がかかっています。ページを再読み込みしてお試しください。',
      });
    }, WATCHDOG_MS);

    const finish = () => {
      clearTimeout(watchdogTimer);
      isHandlingFile = false;
    };

    try {
      hideError();

      // ここからはユーザーが「待機中」になる → ステータスバナーを表示してOK
      userIsWaiting = true;
      // 既にロード済みなら再度バナーを出す必要はない
      if (cvLoadFailed) {
        setCvStatus('failed', '⚠️ OpenCV.js の読み込みに失敗しました（全CDN応答なし）');
      } else if (!cvReady) {
        setCvStatus('loading', '⏳ 検出エンジン (OpenCV.js) を読み込み中…');
      }

      // バリデーション
      if (!ALLOWED_MIME.includes(file.type)) {
        userIsWaiting = false;
        if (cvStatus) cvStatus.hidden = true;
        showError({
          code: 'invalid_format',
          message: 'JPEG / PNG / WebP のみ対応しています。',
          hint: `受信した形式: ${file.type || '不明'}`,
        });
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        userIsWaiting = false;
        if (cvStatus) cvStatus.hidden = true;
        showError({
          code: 'file_too_large',
          message: `画像サイズが ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB を超えています。`,
          hint: `現在のサイズ: ${(file.size / 1024 / 1024).toFixed(1)}MB`,
        });
        return;
      }

      // 画像読み込み
      showProgress(5, '画像を読み込み中', 1);
      try {
        currentImage = await loadImage(file);
      } catch (err) {
        if (watchdogFired) return;
        userIsWaiting = false;
        if (cvStatus) cvStatus.hidden = true;
        showError({ code: 'load_failed', message: '画像の読み込みに失敗しました', hint: err.message });
        return;
      }
      if (watchdogFired) return;

      // OpenCV.js のロードを待機
      showProgress(15, '検出エンジン (OpenCV.js) の準備中', 2);
      try {
        await waitForOpenCV();
      } catch (err) {
        if (watchdogFired) return;
        showError({
          code: 'model_load_failed',
          message: '検出エンジン (OpenCV.js) の読み込みに失敗しました',
          hint: 'ページを再読み込みするか、ネットワーク接続をご確認ください。',
        });
        return;
      }
      if (watchdogFired) return;

      // 解析実行
      showProgress(35, 'カードを検出・正面化中', 2);
      let result;
      try {
        result = await analyzeCardFromImage(currentImage, file);
      } catch (err) {
        if (watchdogFired) return;
        console.error('[diagnose] analyze failed:', err);
        showError({ code: 'internal_error', message: err.message || '解析中にエラーが発生しました', hint: 'お手数ですが別の画像で再度お試しください。' });
        return;
      }
      if (watchdogFired) return;

      if (result.error === 'card_not_detected') {
        showError({
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
        return;
      }

      currentResult = result;
      showProgress(85, '結果を描画中', 4);
      renderResults(result);
      hideProgress();
      showResults();
      setTimeout(() => {
        if (resultsPanel) resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    } finally {
      finish();
    }
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

      // 撮影品質の判定（正面化前の元画像で）
      const imageQuality = safeCall(() => assessImageQuality(src), 'assessImageQuality') || { warnings: [], metrics: {} };

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

      // ホログラム検出（中央のアートワーク領域で）
      const holoInfo = safeCall(() => detectHolographic(rect), 'detectHolographic') || { is_holographic: false };

      // センタリング採点（内枠検出 → 比率計算）
      showProgress(58, 'センタリングを採点中', 2);
      await new Promise(r2 => setTimeout(r2, 20));
      const innerFrame = safeCall(() => detectInnerFrame(rect), 'detectInnerFrame');
      const centering = innerFrame ? safeCall(() => computeCentering(innerFrame), 'computeCentering') : null;

      // 各損傷を検出
      showProgress(62, '折れ目を検出中', 3);
      await new Promise(r2 => setTimeout(r2, 20));
      const creases = safeCall(() => detectCreases(rect), 'detectCreases') || [];

      showProgress(70, '凹みを検出中', 3);
      await new Promise(r2 => setTimeout(r2, 20));
      const indents = safeCall(() => detectIndents(rect), 'detectIndents') || [];

      showProgress(75, '角の損傷を検出中', 3);
      await new Promise(r2 => setTimeout(r2, 20));
      const corners = safeCall(() => detectCornerDamage(rect), 'detectCornerDamage') || [];

      showProgress(80, 'シミを検出中', 3);
      await new Promise(r2 => setTimeout(r2, 20));
      const stains = safeCall(() => detectStains(rect), 'detectStains') || [];

      let damages = [...creases, ...indents, ...corners, ...stains];
      if (warpResult && warpResult.severity) damages.push(warpResult);

      // === 信頼度ポストプロセス（精度向上のキモ） ===
      // 1) レイアウトマスクで信頼度を減衰（テキスト/ホロ領域の誤検出抑制）
      damages.forEach(d => applyLayoutMask(d, holoInfo));
      // 2) 撮影品質警告に応じた信頼度補正
      if (imageQuality.warnings && imageQuality.warnings.includes('motion_blur')) {
        damages.forEach(d => { d.confidence = (d.confidence || 0) * 0.8; });
      }
      if (imageQuality.warnings && imageQuality.warnings.includes('low_contrast')) {
        damages.forEach(d => { d.confidence = (d.confidence || 0) * 0.9; });
      }
      // 3) 信頼度フロア未満は棄却
      damages = damages.filter(d => (d.confidence || 0) >= DETECT_PARAMS.confidenceFloor);
      // 4) NMS（同タイプ内の重複統合）
      damages = applyNMS(damages, DETECT_PARAMS.nmsIoU);

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

      // 結果 JSON 構築（拡張: image quality / holo / centering）
      return buildResultJSON(img, file, damages, { imageQuality, holoInfo, centering });
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

  // ----- §4.3 折れ目検出 (HoughLinesP + マルチ特徴信頼度) -----
  function detectCreases(rectMat) {
    const cv = window.cv;
    const gray = new cv.Mat();
    cv.cvtColor(rectMat, gray, cv.COLOR_RGBA2GRAY);

    const filtered = new cv.Mat();
    cv.bilateralFilter(gray, filtered, 9, 75, 75);

    // 適応的閾値: Cannyの上下限を画像のメディアンから動的決定
    const cannyTh = computeAdaptiveCannyThresholds(filtered);

    const edges = new cv.Mat();
    cv.Canny(filtered, edges, cannyTh.low, cannyTh.high);

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

      // マルチ特徴信頼度
      // - straightness: 直線性（HoughLinesP出力なので高めだが、長さで近似）
      // - brightness_diff: 線の上下で輝度差があるか（折れ目は隣接が明暗反転する）
      // - continuity: 線の長さ（連続性の代理指標）
      const features = computeCreaseFeatures(filtered, x1, y1, x2, y2);
      features.continuity = clamp01(lengthMm / 60);
      features.length_mm = lengthMm;
      const mfConf = combineConfidences({
        straightness: features.straightness,
        brightness_diff: features.brightness_diff,
        continuity: features.continuity,
      });
      if (mfConf <= 0) continue;

      let severity = 'light';
      if (lengthMm >= 30) severity = 'severe';
      else if (lengthMm >= 10) severity = 'moderate';

      // confidence は従来式と特徴量の幾何平均を使用（より厳しい側に寄せる）
      const baseConf = Math.min(1.0, lengthMm / 60);
      const confidence = Math.sqrt(baseConf * mfConf);

      results.push({
        type: 'crease',
        x1, y1, x2, y2,
        length_mm: lengthMm,
        severity,
        confidence,
        features,
        geom: {
          kind: 'polyline',
          points_norm: [[x1 / W, y1 / H], [x2 / W, y2 / H]],
        },
      });
    }

    gray.delete(); filtered.delete(); edges.delete(); lines.delete();
    return mergeNearbyLines(results).slice(0, 10); // 表示上限
  }

  // メディアンベースの自動 Canny 閾値（Otsu/median）
  function computeAdaptiveCannyThresholds(grayMat) {
    try {
      const cv = window.cv;
      const data = grayMat.data;
      // サンプリング（ダウンサンプリングで高速化）
      const step = Math.max(1, Math.floor(data.length / 10000));
      const sample = [];
      for (let i = 0; i < data.length; i += step) sample.push(data[i]);
      sample.sort((a, b) => a - b);
      const median = sample[Math.floor(sample.length / 2)] || 128;
      const sigma = 0.33;
      const low = Math.max(0, Math.floor((1 - sigma) * median));
      const high = Math.min(255, Math.floor((1 + sigma) * median));
      return { low: Math.max(20, low), high: Math.min(220, Math.max(low + 30, high)) };
    } catch (_) {
      return { low: 30, high: 100 };
    }
  }

  // 折れ目候補ラインの局所特徴: 線の両側の輝度差・直線性
  function computeCreaseFeatures(grayMat, x1, y1, x2, y2) {
    const W = grayMat.cols, H = grayMat.rows;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    // 線の法線方向ベクトル
    const nx = -dy / len, ny = dx / len;
    const SAMPLES = 24;
    const offset = 4;  // 法線方向のオフセット（px）
    let darkSum = 0, lightSum = 0, samples = 0;
    let darkVar = 0, lightVar = 0;
    let validDiff = 0;
    for (let i = 1; i < SAMPLES - 1; i++) {
      const t = i / SAMPLES;
      const px = x1 + dx * t;
      const py = y1 + dy * t;
      const lx = Math.round(px - nx * offset);
      const ly = Math.round(py - ny * offset);
      const rx = Math.round(px + nx * offset);
      const ry = Math.round(py + ny * offset);
      const cx = Math.round(px), cy = Math.round(py);
      if (lx < 0 || lx >= W || ly < 0 || ly >= H) continue;
      if (rx < 0 || rx >= W || ry < 0 || ry >= H) continue;
      if (cx < 0 || cx >= W || cy < 0 || cy >= H) continue;
      const lv = grayMat.ucharAt(ly, lx);
      const rv = grayMat.ucharAt(ry, rx);
      const cv2 = grayMat.ucharAt(cy, cx);
      // 中心が両側より暗い（折れ目の谷）or 明るい（折れ目の山）→ どちらでも有効
      const sideMean = (lv + rv) / 2;
      const diff = Math.abs(cv2 - sideMean);
      validDiff += diff;
      darkSum += Math.min(lv, rv);
      lightSum += Math.max(lv, rv);
      samples++;
    }
    if (samples < 4) return { straightness: 0, brightness_diff: 0 };
    const meanDiff = validDiff / samples;
    // 0-1 にスケール（典型的な折れ目で 8-30 程度の差）
    const brightness_diff = clamp01((meanDiff - 4) / 25);
    // straightness: HoughLinesP の出力は概ね直線。長さに対する逸脱は計測コスト高なので、サンプル間の安定度を代理に。
    const straightness = 0.85; // baseline（HoughLinesP前提で固定値、十分に直線）
    return { straightness, brightness_diff, mean_intensity_diff: meanDiff };
  }

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  // マルチ特徴信頼度: 1つでも極端に低ければ棄却、それ以外は重み付き平均
  function combineConfidences(features, weights) {
    const keys = Object.keys(features);
    if (keys.length === 0) return 0;
    const values = keys.map(k => features[k]);
    if (values.some(v => v < 0.18)) return 0;  // 弱い特徴があれば棄却
    let sum = 0, wsum = 0;
    keys.forEach(k => {
      const w = (weights && weights[k]) || 1;
      sum += features[k] * w;
      wsum += w;
    });
    return clamp01(sum / wsum);
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

      // マルチ特徴: 局所明度減 / アスペクト比 / 形状の凸性近似
      const aspect = w > 0 && h > 0 ? Math.min(w, h) / Math.max(w, h) : 0;
      const fillRatio = (w * h) > 0 ? area / (w * h) : 0;  // bbox 内の塗り率（凸性の代理）
      const features = {
        intensity_drop: clamp01(avgDark / 35),
        compactness:    clamp01(aspect),       // 細長すぎる線状は凹みでない
        convexity:      clamp01(fillRatio * 1.3),
      };
      const mfConf = combineConfidences(features);
      if (mfConf <= 0) continue;

      // 従来式と組み合わせ
      const baseConf = Math.min(1.0, avgDark / 40);
      const confidence = Math.sqrt(baseConf * mfConf);

      results.push({
        type: 'indent',
        severity,
        confidence,
        features,
        bbox: { x, y, w, h },
        metrics: { area_mm2: areaMm2, avg_intensity: avgDark, fill_ratio: fillRatio, aspect },
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

      // マルチ特徴: 面積 / 連続性（fill ratio） / アスペクト比
      const fillRatio = (r.width * r.height) > 0 ? area / (r.width * r.height) : 0;
      const aspect = (r.width > 0 && r.height > 0) ? Math.min(r.width, r.height) / Math.max(r.width, r.height) : 0;
      const features = {
        area:          clamp01(areaMm2 / 80),
        connectedness: clamp01(fillRatio * 1.4),
        compactness:   clamp01(aspect * 1.5),
      };
      const mfConf = combineConfidences(features);
      if (mfConf <= 0) continue;
      const baseConf = Math.min(1.0, areaMm2 / 100);
      const confidence = Math.sqrt(baseConf * mfConf);

      results.push({
        type: 'stain',
        severity,
        confidence,
        features,
        metrics: { area_mm2: areaMm2, fill_ratio: fillRatio, aspect },
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
  function buildResultJSON(img, file, detections, extras) {
    extras = extras || {};
    const imageQuality = extras.imageQuality || { warnings: [], metrics: {} };
    const holoInfo = extras.holoInfo || { is_holographic: false };
    const centering = extras.centering || null;

    const order = { mild: 0, light: 1, moderate: 2, severe: 3, critical: 4 };
    const highest = detections.reduce((acc, d) => order[d.severity] > order[acc] ? d.severity : acc, 'mild');
    const overall = detections.length ? avg(detections.map(d => d.confidence)) : 0;

    // 撮影品質の警告を JSON に組み込む
    const qualityWarnings = (imageQuality.warnings || []).map(code => ({
      code,
      message: ({
        too_dark:      '画像が暗すぎます。明るい場所で再撮影をお勧めします。',
        too_bright:    '画像が明るすぎます（白飛びの可能性）。',
        low_contrast:  'コントラストが不足しています。背景とのコントラストを確保してください。',
        motion_blur:   '画像がブレている可能性があります。',
      }[code]) || code,
    }));
    const noDetectWarn = detections.length === 0 ? [{ code: 'no_detections', message: '損傷は検出されませんでした。' }] : [];

    return {
      schema_version: '1.1',
      engine: { name: 'heuristic-cv', version: '0.2.0', is_demo: true, model_loaded_at: new Date().toISOString() },
      diagnosed_at: new Date().toISOString(),
      image: {
        filename: file.name, mime: file.type,
        width: img.naturalWidth, height: img.naturalHeight,
        card_bbox: null, card_corners: null,
        orientation: img.naturalWidth > img.naturalHeight ? 'landscape' : 'portrait',
        side: 'front',
        quality: {
          warnings: imageQuality.warnings || [],
          metrics: imageQuality.metrics || {},
        },
      },
      card: {
        is_holographic: !!holoInfo.is_holographic,
        holo_score: holoInfo.score || 0,
        centering: centering ? {
          available: true,
          horizontal: {
            left_px: centering.horizontal.leftPx,
            right_px: centering.horizontal.rightPx,
            ratio_label: centering.horizontal.label,
            deviation_pct: centering.horizontal.deviation,
          },
          vertical: {
            top_px: centering.vertical.topPx,
            bottom_px: centering.vertical.bottomPx,
            ratio_label: centering.vertical.label,
            deviation_pct: centering.vertical.deviation,
          },
          estimated_grade: centering.estimatedGrade,
          score_0_100: centering.overallScore,
          annotation: centering.annotation,
        } : { available: false },
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
      warnings: [...noDetectWarn, ...qualityWarnings],
    };
  }

  function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

  // ============================================================
  // 結果描画
  // ============================================================
  function renderResults(result) {
    currentDetections = result.detections;
    drawCanvas(currentImage, result.detections, result.card && result.card.centering);

    if (metaCount)      metaCount.textContent = result.summary.total_detections;
    if (metaConfidence) metaConfidence.textContent = result.summary.total_detections
      ? Math.round(result.summary.overall_confidence * 100) + '%'
      : '—';
    if (metaEngine) metaEngine.textContent = `${result.engine.name} v${result.engine.version}`;

    // ホログラム pill
    const holoPill = document.getElementById('meta-holo-pill');
    if (holoPill) holoPill.hidden = !(result.card && result.card.is_holographic);

    // 撮影品質警告
    renderQualityWarnings(result);

    // センタリング採点セクション
    renderCenteringSection(result.card && result.card.centering);

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

  function renderQualityWarnings(result) {
    const wrapper = document.getElementById('quality-warnings');
    const list = document.getElementById('quality-warnings-list');
    if (!wrapper || !list) return;
    const qWarnings = (result.warnings || []).filter(w => w.code !== 'no_detections');
    if (!qWarnings.length) {
      wrapper.hidden = true;
      return;
    }
    list.innerHTML = qWarnings
      .map(w => `<li>${escapeHTML(w.message)}</li>`)
      .join('');
    wrapper.hidden = false;
  }

  function renderCenteringSection(centering) {
    const section = document.getElementById('centering-section');
    if (!section) return;
    if (!centering || !centering.available) {
      section.hidden = true;
      return;
    }
    section.hidden = false;

    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    setText('centering-h-label', centering.horizontal.ratio_label);
    setText('centering-v-label', centering.vertical.ratio_label);
    setText('centering-h-detail',
      `左 ${Math.round(centering.horizontal.left_px)}px / 右 ${Math.round(centering.horizontal.right_px)}px ・ 偏差 ${centering.horizontal.deviation_pct.toFixed(1)}%`);
    setText('centering-v-detail',
      `上 ${Math.round(centering.vertical.top_px)}px / 下 ${Math.round(centering.vertical.bottom_px)}px ・ 偏差 ${centering.vertical.deviation_pct.toFixed(1)}%`);

    // バー描画: 左右%/上下% を 0-100% にマッピング
    const hFill = document.getElementById('centering-h-bar-fill');
    const vFill = document.getElementById('centering-v-bar-fill');
    if (hFill) {
      const lp = centering.horizontal.deviation_pct; // 0..50
      // バー: 中央線(50%)から左 or 右にズレを示す
      const leftPercent = (centering.horizontal.left_px / (centering.horizontal.left_px + centering.horizontal.right_px)) * 100;
      // バーの開始位置と幅: min(50, leftPercent) から max(50, leftPercent) まで
      const start = Math.min(50, leftPercent);
      const end   = Math.max(50, leftPercent);
      hFill.style.left = start + '%';
      hFill.style.width = (end - start) + '%';
      hFill.classList.remove('dev-mid', 'dev-bad');
      if (lp >= 15) hFill.classList.add('dev-bad');
      else if (lp >= 7.5) hFill.classList.add('dev-mid');
    }
    if (vFill) {
      const lp = centering.vertical.deviation_pct;
      const topPercent = (centering.vertical.top_px / (centering.vertical.top_px + centering.vertical.bottom_px)) * 100;
      const start = Math.min(50, topPercent);
      const end   = Math.max(50, topPercent);
      vFill.style.left = start + '%';
      vFill.style.width = (end - start) + '%';
      vFill.classList.remove('dev-mid', 'dev-bad');
      if (lp >= 15) vFill.classList.add('dev-bad');
      else if (lp >= 7.5) vFill.classList.add('dev-mid');
    }

    // グレードバッジ
    const badge = document.getElementById('centering-grade-badge');
    if (badge) {
      badge.textContent = centering.estimated_grade;
      badge.classList.remove('grade-9', 'grade-8', 'grade-7', 'grade-6', 'grade-5', 'grade-low');
      const g = centering.estimated_grade || '';
      if (g.includes('GEM MINT')) {/* default green */}
      else if (g.includes('MINT 9')) badge.classList.add('grade-9');
      else if (g.includes('NM-MT 8')) badge.classList.add('grade-8');
      else if (g.includes('NM 7')) badge.classList.add('grade-7');
      else if (g.includes('EX-MT 6')) badge.classList.add('grade-6');
      else if (g.includes('EX 5')) badge.classList.add('grade-5');
      else badge.classList.add('grade-low');
    }
    setText('centering-score-value', String(centering.score_0_100));

    // 解説
    const note = document.getElementById('centering-note');
    if (note) {
      const hd = centering.horizontal.deviation_pct.toFixed(1);
      const vd = centering.vertical.deviation_pct.toFixed(1);
      note.textContent = `左右の枠幅差は ${hd}%、上下は ${vd}% です。`
        + ` 推定グレード ${centering.estimated_grade}（最も悪い軸を基準）。`
        + ` ※ あくまで参考値で、PSA等の正式鑑定は別途必要です。`;
    }

    // オーバーレイトグル
    const toggle = document.getElementById('centering-overlay-toggle');
    if (toggle) {
      toggle.onchange = () => {
        currentCenteringOverlayEnabled = toggle.checked;
        // 再描画
        if (currentResult) drawCanvas(currentImage, currentResult.detections, currentResult.card && currentResult.card.centering);
      };
      currentCenteringOverlayEnabled = toggle.checked;
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
  function drawCanvas(img, detections, centering) {
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

    // センタリングオーバーレイを先に描画（損傷バッジが上に来るように）
    if (centering && centering.available && currentCenteringOverlayEnabled) {
      drawCenteringOverlay(canvasOverlay, centering, scaleX, scaleY);
    }

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
    const centering = currentResult.card && currentResult.card.centering;
    let pulses = 0;
    const id = setInterval(() => {
      ctx.clearRect(0, 0, cw, ch);
      // センタリングオーバーレイを再描画
      if (centering && centering.available && currentCenteringOverlayEnabled) {
        drawCenteringOverlay(canvasOverlay, centering, sx, sy);
      }
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
  function hideProgress() {
    if (analysisProgress) analysisProgress.hidden = true;
    // ユーザー待機状態を解除（CVステータスバナーをこれ以上勝手に出さない）
    userIsWaiting = false;
    if (cvStatus && cvStatus.dataset.status === 'ready') cvStatus.hidden = true;
  }
  function showResults() { if (resultsPanel) resultsPanel.hidden = false; }
  function hideResults() { if (resultsPanel) resultsPanel.hidden = true; }

  /**
   * エラー表示
   * @param {{code, message, hint?, hints?}} err
   */
  function showError(err) {
    hideProgress(); hideResults();
    userIsWaiting = false;
    // 失敗ステータス以外のCVバナーは隠す
    if (cvStatus && cvStatus.dataset.status !== 'failed') cvStatus.hidden = true;
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
        await loadExternalScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js');
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

  // 汎用スクリプト遅延ロード（html2canvas など、タイムアウト不要・CORS不要なもの専用）。
  // ★注意★ これを loadScript と同名にすると上の OpenCV 用 loadScript を上書きしてしまい
  //   タイムアウト機構が無効化されて「永遠に読み込み中」のバグになる。必ず別名にすること。
  function loadExternalScript(src) {
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
  // 撮影品質判定（ヒストグラム + ラプラシアン分散）
  // ============================================================
  function assessImageQuality(srcMat) {
    const cv = window.cv;
    const gray = new cv.Mat();
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);

    // 輝度統計
    const meanScalar = cv.mean(gray);
    const meanVal = meanScalar[0];

    // 標準偏差（コントラスト）
    const meanMat = new cv.Mat();
    const stdMat = new cv.Mat();
    cv.meanStdDev(gray, meanMat, stdMat);
    const stdVal = stdMat.doubleAt(0, 0);

    // ラプラシアン分散（ボケ判定）
    const lap = new cv.Mat();
    cv.Laplacian(gray, lap, cv.CV_64F);
    const lapMean = new cv.Mat();
    const lapStd = new cv.Mat();
    cv.meanStdDev(lap, lapMean, lapStd);
    const lapVar = Math.pow(lapStd.doubleAt(0, 0), 2);

    const warnings = [];
    if (meanVal < 50)  warnings.push('too_dark');
    if (meanVal > 220) warnings.push('too_bright');
    if (stdVal < 30)   warnings.push('low_contrast');
    if (lapVar < 80)   warnings.push('motion_blur');

    gray.delete(); meanMat.delete(); stdMat.delete();
    lap.delete(); lapMean.delete(); lapStd.delete();

    return {
      warnings,
      metrics: {
        mean_brightness: meanVal,
        contrast_std: stdVal,
        laplacian_variance: lapVar,
      },
    };
  }

  // ============================================================
  // ホログラム検出
  //   中央のアートワーク領域で、彩度の周期的変化（虹色パターン）を検出
  // ============================================================
  function detectHolographic(rectMat) {
    const cv = window.cv;
    const W = rectMat.cols, H = rectMat.rows;
    // アートワーク領域 (中央 60%)
    const ax = Math.round(W * 0.15);
    const ay = Math.round(H * 0.18);
    const aw = Math.round(W * 0.70);
    const ah = Math.round(H * 0.37);

    const roi = rectMat.roi(new cv.Rect(ax, ay, aw, ah));
    const hsv = new cv.Mat();
    cv.cvtColor(roi, hsv, cv.COLOR_RGBA2RGB);
    cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

    const ch = new cv.MatVector();
    cv.split(hsv, ch);
    const Hch = ch.get(0);  // Hue
    const Sch = ch.get(1);  // Saturation

    // 1) 彩度の標準偏差（ホログラムは彩度バリエーションが大きい）
    const sMean = new cv.Mat();
    const sStd = new cv.Mat();
    cv.meanStdDev(Sch, sMean, sStd);
    const satStd = sStd.doubleAt(0, 0);

    // 2) Hue のヒストグラム広がり（多色性）
    let hueRange = 0;
    try {
      // ヒストグラム計算
      const channels = new cv.MatVector();
      channels.push_back(Hch);
      const mask = new cv.Mat();
      const hist = new cv.Mat();
      // OpenCV.js は cv.calcHist が一部不安定なので簡易的にサンプリング
      const sample = [];
      const step = Math.max(1, Math.floor(Hch.rows * Hch.cols / 4000));
      for (let yy = 0; yy < Hch.rows; yy += 4) {
        for (let xx = 0; xx < Hch.cols; xx += 4) {
          const v = Hch.ucharAt(yy, xx);
          if (Sch.ucharAt(yy, xx) > 30) sample.push(v); // 彩度がある画素のみ
        }
      }
      if (sample.length > 50) {
        sample.sort((a, b) => a - b);
        const p10 = sample[Math.floor(sample.length * 0.1)];
        const p90 = sample[Math.floor(sample.length * 0.9)];
        hueRange = p90 - p10;
      }
      channels.delete(); mask.delete(); hist.delete();
    } catch (_) { hueRange = 0; }

    // ホログラムスコア: 彩度のバラつきとHueの広がりを組み合わせる
    const satScore = clamp01((satStd - 25) / 60);  // satStd 25→0, 85→1
    const hueScore = clamp01((hueRange - 20) / 80); // hueRange 20→0, 100→1
    const score = (satScore * 0.6 + hueScore * 0.4);

    // 0.45以上ならホログラムカードと推定
    const is_holographic = score >= 0.45;

    ch.delete(); hsv.delete(); roi.delete();
    sMean.delete(); sStd.delete();

    return {
      is_holographic,
      score,
      area_norm: [ax / W, ay / H, (ax + aw) / W, (ay + ah) / H],
      metrics: { saturation_std: satStd, hue_range: hueRange },
    };
  }

  // ============================================================
  // レイアウトマスクで信頼度を減衰
  // ============================================================
  function applyLayoutMask(d, holoInfo) {
    const bbox = bboxNormOf(d);
    if (!bbox) return;
    const [nx1, ny1, nx2, ny2] = bbox;
    const cy = (ny1 + ny2) / 2;
    const cx = (nx1 + nx2) / 2;

    // テキスト領域（折れ目以外を強く減衰、折れ目は弱く減衰）
    let inText = false;
    for (const z of DETECT_PARAMS.textZones) {
      if (cy >= z.y1 && cy <= z.y2) { inText = true; break; }
    }
    if (inText) {
      // 折れ目は構造的なので減衰を弱く（0.7）
      const factor = (d.type === 'crease') ? 0.7 : 0.5;
      d.confidence = (d.confidence || 0) * factor;
      d._mask_applied = (d._mask_applied || []).concat(['text_zone']);
    }

    // ホログラム領域: Crease 以外を減衰（折れ目は本物の損傷の可能性）
    if (holoInfo && holoInfo.is_holographic && holoInfo.area_norm) {
      const [hx1, hy1, hx2, hy2] = holoInfo.area_norm;
      if (cx >= hx1 && cx <= hx2 && cy >= hy1 && cy <= hy2) {
        if (d.type !== 'crease') {
          d.confidence = (d.confidence || 0) * 0.7;
          d._mask_applied = (d._mask_applied || []).concat(['holo_zone']);
        }
      }
    }
  }

  function bboxNormOf(d) {
    if (!d.geom) return null;
    if (d.geom.kind === 'bbox' && d.geom.norm) return d.geom.norm;
    if (d.geom.kind === 'polyline' && d.geom.points_norm) {
      const xs = d.geom.points_norm.map(p => p[0]);
      const ys = d.geom.points_norm.map(p => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    return null;
  }

  // ============================================================
  // NMS（同タイプ内の重複検出を統合）
  // ============================================================
  function applyNMS(detections, iouThresh) {
    // タイプごとにグループ化
    const byType = {};
    detections.forEach(d => {
      const t = d.type;
      if (!byType[t]) byType[t] = [];
      byType[t].push(d);
    });

    const out = [];
    for (const t of Object.keys(byType)) {
      const list = byType[t].slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      const keep = [];
      for (const d of list) {
        const dBbox = bboxNormOf(d);
        if (!dBbox) { keep.push(d); continue; }
        let suppressed = false;
        for (const k of keep) {
          const kBbox = bboxNormOf(k);
          if (!kBbox) continue;
          if (computeIoU(dBbox, kBbox) > iouThresh) {
            suppressed = true;
            break;
          }
        }
        if (!suppressed) keep.push(d);
      }
      out.push(...keep);
    }
    return out;
  }

  function computeIoU(a, b) {
    const [ax1, ay1, ax2, ay2] = a;
    const [bx1, by1, bx2, by2] = b;
    const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
    const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
    const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    const ua = Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1);
    const ub = Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1);
    const uni = ua + ub - inter;
    return uni > 0 ? inter / uni : 0;
  }

  // ============================================================
  // センタリング採点
  // ============================================================

  /**
   * 内側枠（アートワーク枠）を検出して 4 辺の枠幅 (px) を返す
   * 手法: 各辺から内側へスキャンして輝度・色相の変化点を統計的に決定
   * @returns {{top:number,bottom:number,left:number,right:number, outer:[x,y,x,y], inner:[x,y,x,y], confidence:number} | null}
   */
  function detectInnerFrame(rectMat) {
    const cv = window.cv;
    const W = rectMat.cols, H = rectMat.rows;

    // RGBA → RGB
    const rgb = new cv.Mat();
    cv.cvtColor(rectMat, rgb, cv.COLOR_RGBA2RGB);
    // グレースケールと HSV 両方利用
    const gray = new cv.Mat();
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    const hsv = new cv.Mat();
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);

    // 各辺を独立に検出。サンプリング数 SAMPLES、最大スキャン深度 MAX_SCAN
    const SAMPLES = 21;
    const MAX_SCAN_TB = Math.floor(H * 0.2);  // 上下: カード高さの 20%
    const MAX_SCAN_LR = Math.floor(W * 0.2);  // 左右: カード幅の 20%
    const MIN_BORDER_TB = Math.floor(H * 0.005);
    const MIN_BORDER_LR = Math.floor(W * 0.005);

    // 上辺: 各列で上から下へスキャン、輝度/色相が大きく変わる点を「内枠」とする
    const topVals = [];
    for (let i = 1; i < SAMPLES - 1; i++) {
      const x = Math.round((i / SAMPLES) * W);
      const v = scanForFrameBoundary(gray, hsv, x, 0, 0, 1, MAX_SCAN_TB, MIN_BORDER_TB);
      if (v != null) topVals.push(v);
    }
    const bottomVals = [];
    for (let i = 1; i < SAMPLES - 1; i++) {
      const x = Math.round((i / SAMPLES) * W);
      const v = scanForFrameBoundary(gray, hsv, x, H - 1, 0, -1, MAX_SCAN_TB, MIN_BORDER_TB);
      if (v != null) bottomVals.push(v);
    }
    const leftVals = [];
    for (let i = 1; i < SAMPLES - 1; i++) {
      const y = Math.round((i / SAMPLES) * H);
      const v = scanForFrameBoundary(gray, hsv, 0, y, 1, 0, MAX_SCAN_LR, MIN_BORDER_LR);
      if (v != null) leftVals.push(v);
    }
    const rightVals = [];
    for (let i = 1; i < SAMPLES - 1; i++) {
      const y = Math.round((i / SAMPLES) * H);
      const v = scanForFrameBoundary(gray, hsv, W - 1, y, -1, 0, MAX_SCAN_LR, MIN_BORDER_LR);
      if (v != null) rightVals.push(v);
    }

    rgb.delete(); gray.delete(); hsv.delete();

    // ロバスト推定: 中央値（外れ値耐性）
    const top    = robustMedian(topVals);
    const bottom = robustMedian(bottomVals);
    const left   = robustMedian(leftVals);
    const right  = robustMedian(rightVals);

    if (top == null || bottom == null || left == null || right == null) return null;
    if (top + bottom < 4 || left + right < 4) return null; // 検出失敗

    const innerX1 = Math.round(left);
    const innerY1 = Math.round(top);
    const innerX2 = Math.round(W - right);
    const innerY2 = Math.round(H - bottom);

    // 信頼度: サンプルの分散（小さいほど高信頼）
    const variances = [
      stdOf(topVals), stdOf(bottomVals), stdOf(leftVals), stdOf(rightVals)
    ].filter(v => v != null);
    const avgStd = variances.length ? variances.reduce((a, b) => a + b, 0) / variances.length : 30;
    const confidence = clamp01(1 - avgStd / 30);

    return {
      top, bottom, left, right,
      outer: [0, 0, W, H],
      inner: [innerX1, innerY1, innerX2, innerY2],
      confidence,
    };
  }

  // 1辺の境界をスキャン: 始点 (sx, sy) から方向 (dx, dy) へ進み、輝度 or 色相が大きく変化する点までの距離を返す
  function scanForFrameBoundary(grayMat, hsvMat, sx, sy, dx, dy, maxScan, minBorder) {
    const W = grayMat.cols, H = grayMat.rows;
    // エッジ部の最初の数 px は不安定なので minBorder スキップ
    let prevGray = null;
    let prevHue = null;
    let edgeAccum = 0;
    for (let s = 0; s < maxScan; s++) {
      const x = sx + dx * s;
      const y = sy + dy * s;
      if (x < 0 || x >= W || y < 0 || y >= H) break;
      const g = grayMat.ucharAt(y, x);
      // HSV: H = 0, S = 1, V = 2 (3チャンネル)
      const hueIdx = (y * W + x) * 3;
      const h = hsvMat.data[hueIdx];
      if (s >= minBorder && prevGray != null) {
        const dG = Math.abs(g - prevGray);
        let dH = Math.abs(h - prevHue);
        // 色相は循環するので min(dH, 180 - dH)
        dH = Math.min(dH, 180 - dH);
        // どちらかが閾値超えれば「変化点」候補
        if (dG > 22 || dH > 12) {
          edgeAccum++;
          if (edgeAccum >= 2) return s;  // 2連続で変化があれば確定
        } else {
          edgeAccum = 0;
        }
      }
      prevGray = g;
      prevHue = h;
    }
    return null;
  }

  function robustMedian(values) {
    if (!values || values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    // 上下 10% を除外してから中央値
    const trim = Math.floor(sorted.length * 0.1);
    const trimmed = sorted.slice(trim, sorted.length - trim);
    if (trimmed.length === 0) return sorted[Math.floor(sorted.length / 2)];
    return trimmed[Math.floor(trimmed.length / 2)];
  }

  function stdOf(values) {
    if (!values || values.length < 2) return null;
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    const v = values.reduce((a, b) => a + (b - m) * (b - m), 0) / values.length;
    return Math.sqrt(v);
  }

  /**
   * 枠幅からセンタリング比率を計算
   * @param {{top:number,bottom:number,left:number,right:number, outer, inner, confidence}} frame
   */
  function computeCentering(frame) {
    const { top, bottom, left, right } = frame;
    const horizSum = left + right;
    const vertSum = top + bottom;
    const leftPct = (left / horizSum) * 100;
    const rightPct = (right / horizSum) * 100;
    const topPct = (top / vertSum) * 100;
    const bottomPct = (bottom / vertSum) * 100;

    const horizDev = Math.abs(left - right) / horizSum * 100;
    const vertDev = Math.abs(top - bottom) / vertSum * 100;

    const horizontal = {
      leftPx: left,
      rightPx: right,
      leftPercent: leftPct,
      rightPercent: rightPct,
      deviation: horizDev,
      label: `${Math.round(leftPct)}/${Math.round(rightPct)}`,
    };
    const vertical = {
      topPx: top,
      bottomPx: bottom,
      topPercent: topPct,
      bottomPercent: bottomPct,
      deviation: vertDev,
      label: `${Math.round(topPct)}/${Math.round(bottomPct)}`,
    };

    // PSAグレード推定（最も悪い軸を採用）
    const worstDeviation = Math.max(horizDev, vertDev);
    const worstRatio = 50 + worstDeviation / 2; // dev=10 → 55/45

    let estimatedGrade;
    if (worstRatio <= 55) estimatedGrade = 'GEM MINT 10';
    else if (worstRatio <= 60) estimatedGrade = 'MINT 9';
    else if (worstRatio <= 65) estimatedGrade = 'NM-MT 8';
    else if (worstRatio <= 70) estimatedGrade = 'NM 7';
    else if (worstRatio <= 75) estimatedGrade = 'EX-MT 6';
    else if (worstRatio <= 80) estimatedGrade = 'EX 5';
    else estimatedGrade = 'VG-EX or below';

    const overallScore = Math.max(0, Math.round(100 - worstDeviation * 2));

    return {
      horizontal,
      vertical,
      estimatedGrade,
      overallScore,
      worstDeviation,
      annotation: {
        outer_rect: frame.outer,
        inner_rect: frame.inner,
      },
      detection_confidence: frame.confidence,
    };
  }

  /**
   * Canvas にセンタリングオーバーレイを描画
   * @param {HTMLCanvasElement} canvas - canvasOverlay
   * @param {object} centering - JSON.card.centering
   * @param {number} sx - rect→canvas スケール
   * @param {number} sy
   */
  function drawCenteringOverlay(canvas, centering, sx, sy) {
    if (!canvas || !centering || !centering.available) return;
    const ctx = canvas.getContext('2d');
    const ann = centering.annotation;
    if (!ann || !ann.outer_rect || !ann.inner_rect) return;

    const [ox1, oy1, ox2, oy2] = ann.outer_rect;
    const [ix1, iy1, ix2, iy2] = ann.inner_rect;
    const Ox1 = ox1 * sx, Oy1 = oy1 * sy, Ox2 = ox2 * sx, Oy2 = oy2 * sy;
    const Ix1 = ix1 * sx, Iy1 = iy1 * sy, Ix2 = ix2 * sx, Iy2 = iy2 * sy;

    ctx.save();
    // 外枠（緑）
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = Math.max(2, canvas.width / 400);
    ctx.setLineDash([]);
    ctx.strokeRect(Ox1, Oy1, Ox2 - Ox1, Oy2 - Oy1);

    // 内枠（青）
    ctx.strokeStyle = '#3b82f6';
    ctx.setLineDash([8, 4]);
    ctx.strokeRect(Ix1, Iy1, Ix2 - Ix1, Iy2 - Iy1);
    ctx.setLineDash([]);

    // 4辺の矢印（枠幅を可視化）
    ctx.strokeStyle = '#fbbf24';
    ctx.fillStyle = '#fbbf24';
    ctx.lineWidth = Math.max(1.5, canvas.width / 600);
    const cxV = (Ox1 + Ox2) / 2;
    const cyH = (Oy1 + Oy2) / 2;
    drawArrow(ctx, cxV, Oy1, cxV, Iy1);   // 上辺
    drawArrow(ctx, cxV, Oy2, cxV, Iy2);   // 下辺
    drawArrow(ctx, Ox1, cyH, Ix1, cyH);   // 左辺
    drawArrow(ctx, Ox2, cyH, Ix2, cyH);   // 右辺

    // テキスト: 比率ラベル
    const fontSize = Math.max(14, canvas.width / 60);
    ctx.font = `bold ${fontSize}px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = `${centering.horizontal.ratio_label} ・ ${centering.vertical.ratio_label}`;
    const tx = (Ix1 + Ix2) / 2;
    const ty = (Iy1 + Iy2) / 2;
    // 背景
    const metrics = ctx.measureText(label);
    const padX = 10, padY = 6;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(tx - metrics.width / 2 - padX, ty - fontSize / 2 - padY, metrics.width + padX * 2, fontSize + padY * 2);
    ctx.fillStyle = '#fbbf24';
    ctx.fillText(label, tx, ty);

    ctx.restore();
  }

  function drawArrow(ctx, x1, y1, x2, y2) {
    const headLen = 6;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 4) return;
    const ux = dx / len, uy = dy / len;
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.stroke();
    // 矢頭
    const ang = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(ang - Math.PI / 6), y2 - headLen * Math.sin(ang - Math.PI / 6));
    ctx.lineTo(x2 - headLen * Math.cos(ang + Math.PI / 6), y2 - headLen * Math.sin(ang + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
    // 反対側にも矢頭（双方向矢印）
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 + headLen * Math.cos(ang - Math.PI / 6), y1 + headLen * Math.sin(ang - Math.PI / 6));
    ctx.lineTo(x1 + headLen * Math.cos(ang + Math.PI / 6), y1 + headLen * Math.sin(ang + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  // ============================================================
  // 既存サイト index.html のヘッダーへ「📷 診断」リンク追加（同一オリジン）
  //   → このページからは触れないが、別ページで本スクリプトが読まれた時用
  // ============================================================
  // ※ 仕様により index.html 自体は触らない。本ページ専用。

  console.log('[diagnose] initialized.');
})();
