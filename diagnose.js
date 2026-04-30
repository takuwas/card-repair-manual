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
  const DIAGNOSE_WORKER_URL = 'diagnose-worker.js?v=20260430-boundary-ensemble';

  // ============================================================
  // 検出パラメータ（精度向上用の閾値）
  // ============================================================
  const DETECT_PARAMS = {
    // テキスト密度の高い領域（信頼度を減衰させる）
    textZones: [
      { name: 'top_text',    y1: 0.00, y2: 0.16, strength: 0.10 },  // ポケモン名・HP
      { name: 'art_caption', y1: 0.46, y2: 0.56, strength: 0.08 },  // 図鑑バー・銀色の区切り
      { name: 'attack_text', y1: 0.56, y2: 0.83, strength: 0.10 },  // わざ・効果テキスト
      { name: 'bottom_rules',y1: 0.82, y2: 0.93, strength: 0.08 },  // 弱点・抵抗力・逃げる
      { name: 'footer',      y1: 0.91, y2: 1.00, strength: 0.08 },  // コレクター情報
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
  const btnHighPrecision   = $('btn-high-precision');
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
  const canvasWrapper      = $('canvas-wrapper');
  const canvasStage        = $('canvas-stage');
  const canvasTooltip      = $('canvas-tooltip');
  const canvasZoomOut      = $('canvas-zoom-out');
  const canvasZoomIn       = $('canvas-zoom-in');
  const canvasZoomRange    = $('canvas-zoom-range');
  const canvasRotateLeft   = $('canvas-rotate-left');
  const canvasRotateRight  = $('canvas-rotate-right');
  const canvasResetView    = $('canvas-reset-view');
  const canvasZoomValue    = $('canvas-zoom-value');
  const failedPreview      = $('failed-preview');
  const failedPreviewCanvas = $('failed-preview-canvas');
  const demoBanner         = $('demo-banner');
  const themeToggle        = $('theme-toggle');
  const cvStatus           = $('cv-status');
  const sidebarToggle      = $('sidebar-toggle');
  const sidebarEl          = $('sidebar');
  const metaCount          = $('meta-count');
  const metaConfidence     = $('meta-confidence');
  const metaEngine         = $('meta-engine');
  const guidedCamera       = $('guided-camera');
  const guidedCameraVideo  = $('guided-camera-video');
  const guidedCameraCanvas = $('guided-camera-canvas');
  const guidedCameraTitle  = $('guided-camera-title');
  const guidedCameraSubtitle = $('guided-camera-subtitle');
  const guidedCameraClose  = $('guided-camera-close');
  const guidedCameraCapture = $('guided-camera-capture');
  const guidedCameraRetake = $('guided-camera-retake');
  const guidedCameraStatus = $('guided-camera-status');
  const cameraStepper      = $('camera-stepper');
  const cameraAngleBadge   = $('camera-angle-badge');
  const cameraOrientation  = $('camera-orientation');
  const orientationDot     = $('orientation-dot');
  const orientationTitle   = $('orientation-title');
  const orientationDetail  = $('orientation-detail');

  // 状態
  let currentImage = null;        // HTMLImageElement
  let currentResult = null;       // 検出結果 JSON
  let currentDetections = [];     // 描画用（ピクセル座標）
  let currentCenteringOverlayEnabled = true;
  const canvasView = {
    scale: 1,
    rotation: 0,
    panX: 0,
    panY: 0,
    dragging: false,
    moved: false,
    pointerId: null,
    lastX: 0,
    lastY: 0,
    suppressClick: false,
  };
  const PRECISION_STEPS = [
    { id: 'front', label: '正面', subtitle: 'カードの四隅を枠に合わせ、真上から撮影します。' },
    { id: 'left', label: '左斜め', subtitle: 'スマホを少し左へずらして、反射と凹みの陰影を変えて撮影します。' },
    { id: 'right', label: '右斜め', subtitle: 'スマホを少し右へずらして、別角度の陰影を確認します。' },
  ];
  const guidedCameraState = {
    mode: 'single',
    stream: null,
    stepIndex: 0,
    files: [],
    zoomApplied: null,
    qualityLabel: '',
    orientationActive: false,
    orientationPermission: 'unknown',
    orientation: null,
    imageCapture: null,
  };
  let cvReady = false;
  let cvLoadFailed = false;
  let cvReadyPromise = null;
  let pendingFile = null;         // OpenCV.js ロード前にユーザーがアップロードした場合の保留
  let diagnoseWorker = null;
  let workerSeq = 0;
  const workerPending = new Map();

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

  function getDiagnoseWorker() {
    if (diagnoseWorker) return diagnoseWorker;
    diagnoseWorker = new Worker(DIAGNOSE_WORKER_URL);
    diagnoseWorker.onmessage = (event) => {
      const msg = event.data || {};
      const pending = workerPending.get(msg.requestId);
      if (msg.type === 'progress') {
        if (msg.label) setCvStatus('loading', `⏳ ${msg.label}`);
        if (analysisProgress && !analysisProgress.hidden) showProgress(msg.pct || 20, msg.label || '解析中', msg.step || 2);
        return;
      }
      if (msg.type === 'log') {
        const level = msg.level === 'warn' ? 'warn' : 'log';
        console[level]('[diagnose worker]', msg.message);
        return;
      }
      if (!pending) return;
      if (msg.type === 'ready' || msg.type === 'result') {
        workerPending.delete(msg.requestId);
        pending.resolve(msg.result || true);
      } else if (msg.type === 'error') {
        workerPending.delete(msg.requestId);
        pending.reject(new Error(msg.message || 'worker error'));
      }
    };
    diagnoseWorker.onerror = (event) => {
      const err = new Error(event.message || 'diagnose worker error');
      workerPending.forEach(p => p.reject(err));
      workerPending.clear();
      diagnoseWorker = null;
      cvReadyPromise = null;
      cvLoadFailed = true;
      setCvStatus('failed', '⚠️ 検出エンジンの起動に失敗しました。');
    };
    return diagnoseWorker;
  }

  function postWorker(type, payload = {}, transfer = []) {
    const worker = getDiagnoseWorker();
    const requestId = `req-${++workerSeq}`;
    return new Promise((resolve, reject) => {
      workerPending.set(requestId, { resolve, reject, type });
      worker.postMessage({ ...payload, type, requestId }, transfer);
    });
  }

  async function waitForOpenCV() {
    if (cvReadyPromise) return cvReadyPromise;
    cvReadyPromise = postWorker('load')
      .then(() => {
        cvReady = true;
        cvLoadFailed = false;
        setCvStatus('ready', '✅ 検出エンジン (OpenCV.js worker) の準備完了');
        return true;
      })
      .catch(err => {
        cvLoadFailed = true;
        cvReadyPromise = null;
        setCvStatus('failed', '⚠️ OpenCV.js worker の読み込みに失敗しました。');
        throw err;
      });
    cvReadyPromise.catch(() => {});
    return cvReadyPromise;
  }

  // OpenCV.js は worker 内で実行する。精度優先の OpenCV 処理を維持しつつ、
  // UI スレッドの停止を避けるため、ページ本体では cv を直接初期化しない。
  console.log('[diagnose] OpenCV will run in a worker on first analysis.');

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
  if (btnCamera) btnCamera.addEventListener('click', (e) => { e.stopPropagation(); openGuidedCamera('single'); });
  if (btnHighPrecision) btnHighPrecision.addEventListener('click', (e) => { e.stopPropagation(); openGuidedCamera('precision'); });
  if (btnSample) btnSample.addEventListener('click', (e) => { e.stopPropagation(); pickSample(); });
  if (guidedCameraClose) guidedCameraClose.addEventListener('click', closeGuidedCamera);
  if (guidedCameraRetake) guidedCameraRetake.addEventListener('click', retakeGuidedCameraStep);
  if (guidedCameraCapture) guidedCameraCapture.addEventListener('click', captureGuidedCameraFrame);

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
  setupCanvasViewControls();

  // ============================================================
  // ガイド付きカメラ / 高精度モード
  // ============================================================
  async function openGuidedCamera(mode) {
    if (!guidedCamera || !guidedCameraVideo || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (mode === 'single') cameraInput.click();
      else showError({
        code: 'camera_unavailable',
        message: 'このブラウザではガイド付きカメラを起動できません',
        hint: 'iPhoneのSafari/Chromeなど、カメラ利用を許可できるブラウザで開いてください。',
      });
      return;
    }

    guidedCameraState.mode = mode === 'precision' ? 'precision' : 'single';
    guidedCameraState.stepIndex = 0;
    guidedCameraState.files = [];
    guidedCameraState.zoomApplied = null;
    guidedCameraState.qualityLabel = '';
    guidedCameraState.orientation = null;
    guidedCameraState.imageCapture = null;
    guidedCamera.hidden = false;
    document.body.style.overflow = 'hidden';
    updateGuidedCameraUI();

    try {
      await requestDeviceOrientationAccess();
      guidedCameraState.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 4032 },
          height: { ideal: 3024 },
          aspectRatio: { ideal: 4 / 3 },
          frameRate: { ideal: 30 },
          resizeMode: { ideal: 'none' },
        },
        audio: false,
      });
      guidedCameraVideo.srcObject = guidedCameraState.stream;
      await guidedCameraVideo.play();
      await requestCameraBestQuality(guidedCameraState.stream);
      await requestCameraZoom2x(guidedCameraState.stream);
      setupImageCapture(guidedCameraState.stream);
      startOrientationGuide();
      updateGuidedCameraUI();
    } catch (err) {
      closeGuidedCamera();
      if (mode === 'single') {
        cameraInput.click();
      } else {
        showError({
          code: 'camera_unavailable',
          message: 'カメラを起動できませんでした',
          hint: err.message || 'ブラウザのカメラ権限を確認してください。',
        });
      }
    }
  }

  async function requestCameraZoom2x(stream) {
    const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
    if (!track || typeof track.getCapabilities !== 'function' || typeof track.applyConstraints !== 'function') {
      guidedCameraState.zoomApplied = false;
      return;
    }
    const caps = track.getCapabilities();
    if (!caps || !caps.zoom) {
      guidedCameraState.zoomApplied = false;
      return;
    }
    const target = clamp(2, caps.zoom.min || 1, caps.zoom.max || 2);
    try {
      await track.applyConstraints({ advanced: [{ zoom: target }] });
      guidedCameraState.zoomApplied = Math.abs(target - 2) < 0.05 ? 2 : target;
    } catch (_) {
      guidedCameraState.zoomApplied = false;
    }
  }

  async function requestCameraBestQuality(stream) {
    const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
    if (!track || typeof track.getCapabilities !== 'function' || typeof track.applyConstraints !== 'function') {
      guidedCameraState.qualityLabel = 'high-quality-fallback';
      return;
    }
    const caps = track.getCapabilities();
    const advanced = [];
    if (caps.focusMode && caps.focusMode.includes('continuous')) advanced.push({ focusMode: 'continuous' });
    if (caps.exposureMode && caps.exposureMode.includes('continuous')) advanced.push({ exposureMode: 'continuous' });
    if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('continuous')) advanced.push({ whiteBalanceMode: 'continuous' });
    const constraints = { advanced };
    if (caps.width && caps.height) {
      constraints.width = { ideal: caps.width.max };
      constraints.height = { ideal: caps.height.max };
    }
    try {
      await track.applyConstraints(constraints);
    } catch (_) {
      try {
        if (advanced.length) await track.applyConstraints({ advanced });
      } catch (_) {}
    }
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
    guidedCameraState.qualityLabel = settings.width && settings.height
      ? `${settings.width}x${settings.height}`
      : 'highest-available';
  }

  function setupImageCapture(stream) {
    guidedCameraState.imageCapture = null;
    const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
    if (!track || typeof window.ImageCapture !== 'function') return;
    try {
      guidedCameraState.imageCapture = new ImageCapture(track);
    } catch (_) {
      guidedCameraState.imageCapture = null;
    }
  }

  async function captureHighestQualityBlob() {
    const capture = guidedCameraState.imageCapture;
    if (capture && typeof capture.takePhoto === 'function') {
      try {
        if (typeof capture.getPhotoCapabilities === 'function') {
          const caps = await capture.getPhotoCapabilities();
          const settings = {};
          if (caps.imageWidth && caps.imageWidth.max) settings.imageWidth = caps.imageWidth.max;
          if (caps.imageHeight && caps.imageHeight.max) settings.imageHeight = caps.imageHeight.max;
          const photo = await capture.takePhoto(settings);
          if (photo) return photo;
        }
        const photo = await capture.takePhoto();
        if (photo) return photo;
      } catch (err) {
        console.warn('[diagnose] ImageCapture.takePhoto failed, falling back to canvas:', err.message || err);
      }
    }
    return captureVideoFrameBlob();
  }

  async function captureVideoFrameBlob() {
    if (!guidedCameraVideo || !guidedCameraCanvas) return null;
    const vw = guidedCameraVideo.videoWidth;
    const vh = guidedCameraVideo.videoHeight;
    if (!vw || !vh) return null;
    guidedCameraCanvas.width = vw;
    guidedCameraCanvas.height = vh;
    guidedCameraCanvas.getContext('2d').drawImage(guidedCameraVideo, 0, 0, vw, vh);
    return new Promise(resolve => guidedCameraCanvas.toBlob(resolve, 'image/jpeg', 0.98));
  }

  async function requestDeviceOrientationAccess() {
    if (!('DeviceOrientationEvent' in window)) {
      guidedCameraState.orientationPermission = 'unsupported';
      return false;
    }
    const maybeRequest = DeviceOrientationEvent.requestPermission;
    if (typeof maybeRequest === 'function') {
      try {
        const result = await maybeRequest.call(DeviceOrientationEvent);
        guidedCameraState.orientationPermission = result;
        return result === 'granted';
      } catch (_) {
        guidedCameraState.orientationPermission = 'denied';
        return false;
      }
    }
    guidedCameraState.orientationPermission = 'granted';
    return true;
  }

  function startOrientationGuide() {
    if (guidedCameraState.orientationActive || guidedCameraState.orientationPermission !== 'granted') {
      updateOrientationGuide();
      return;
    }
    guidedCameraState.orientationActive = true;
    window.addEventListener('deviceorientation', handleDeviceOrientation, true);
    updateOrientationGuide();
  }

  function stopOrientationGuide() {
    if (!guidedCameraState.orientationActive) return;
    guidedCameraState.orientationActive = false;
    window.removeEventListener('deviceorientation', handleDeviceOrientation, true);
  }

  function handleDeviceOrientation(event) {
    const beta = Number.isFinite(event.beta) ? event.beta : null;
    const gamma = Number.isFinite(event.gamma) ? event.gamma : null;
    const alpha = Number.isFinite(event.alpha) ? event.alpha : null;
    guidedCameraState.orientation = { beta, gamma, alpha };
    updateOrientationGuide();
  }

  function updateOrientationGuide() {
    if (!cameraOrientation || !orientationDot || !orientationTitle || !orientationDetail) return;
    cameraOrientation.classList.remove('is-good', 'is-bad');
    if (guidedCameraState.orientationPermission === 'unsupported') {
      orientationTitle.textContent = '角度センサー非対応';
      orientationDetail.textContent = 'ガイド枠に合わせ、カード面とスマホを平行にしてください。';
      orientationDot.style.transform = 'translate(-50%, -50%)';
      return;
    }
    if (guidedCameraState.orientationPermission !== 'granted') {
      orientationTitle.textContent = '角度センサー未許可';
      orientationDetail.textContent = 'モーション利用を許可すると傾きガイドを表示できます。';
      orientationDot.style.transform = 'translate(-50%, -50%)';
      return;
    }
    const o = guidedCameraState.orientation;
    if (!o || o.beta == null || o.gamma == null) {
      orientationTitle.textContent = '角度を確認中';
      orientationDetail.textContent = 'スマホをカード面と平行にしてください。';
      orientationDot.style.transform = 'translate(-50%, -50%)';
      return;
    }
    const pitch = normalizePitchForCamera(o.beta);
    const roll = clamp(o.gamma, -45, 45);
    const pitchErr = Math.abs(pitch);
    const rollErr = Math.abs(roll);
    const good = pitchErr <= 7 && rollErr <= 7;
    const bad = pitchErr > 14 || rollErr > 14;
    if (good) cameraOrientation.classList.add('is-good');
    else if (bad) cameraOrientation.classList.add('is-bad');
    const dx = clamp(roll / 18, -1, 1) * 13;
    const dy = clamp(pitch / 18, -1, 1) * 13;
    orientationDot.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    orientationTitle.textContent = good ? '角度OK' : '角度を調整';
    orientationDetail.textContent = `上下 ${pitch.toFixed(1)}° / 左右 ${roll.toFixed(1)}°。7°以内が目安です。`;
  }

  function normalizePitchForCamera(beta) {
    if (!Number.isFinite(beta)) return 0;
    if (Math.abs(beta) > 45) return beta > 0 ? beta - 90 : beta + 90;
    return beta;
  }

  function closeGuidedCamera() {
    stopOrientationGuide();
    if (guidedCameraState.stream) {
      guidedCameraState.stream.getTracks().forEach(t => t.stop());
    }
    guidedCameraState.stream = null;
    guidedCameraState.files = [];
    guidedCameraState.stepIndex = 0;
    guidedCameraState.imageCapture = null;
    if (guidedCameraVideo) guidedCameraVideo.srcObject = null;
    if (guidedCamera) guidedCamera.hidden = true;
    document.body.style.overflow = '';
  }

  function retakeGuidedCameraStep() {
    if (guidedCameraState.mode !== 'precision') {
      guidedCameraState.files = [];
      updateGuidedCameraUI();
      return;
    }
    if (guidedCameraState.files.length) guidedCameraState.files.pop();
    guidedCameraState.stepIndex = guidedCameraState.files.length;
    updateGuidedCameraUI();
  }

  async function captureGuidedCameraFrame() {
    const blob = await captureHighestQualityBlob();
    if (!blob) return;

    const step = currentGuidedStep();
    const file = new File([blob], `camera-${step.id}-${Date.now()}.jpg`, { type: 'image/jpeg' });
    if (guidedCameraState.mode === 'precision') {
      guidedCameraState.files.push(file);
      guidedCameraState.stepIndex = guidedCameraState.files.length;
      if (guidedCameraState.files.length >= PRECISION_STEPS.length) {
        const files = guidedCameraState.files.slice();
        closeGuidedCamera();
        handlePrecisionFiles(files);
        return;
      }
      updateGuidedCameraUI();
      return;
    }

    closeGuidedCamera();
    handleFile(file);
  }

  function currentGuidedStep() {
    return guidedCameraState.mode === 'precision'
      ? PRECISION_STEPS[Math.min(guidedCameraState.stepIndex, PRECISION_STEPS.length - 1)]
      : PRECISION_STEPS[0];
  }

  function updateGuidedCameraUI() {
    const step = currentGuidedStep();
    const precision = guidedCameraState.mode === 'precision';
    if (guidedCameraTitle) guidedCameraTitle.textContent = precision ? '高精度モード' : 'カードを撮影';
    if (guidedCameraSubtitle) guidedCameraSubtitle.textContent = precision
      ? `${guidedCameraState.stepIndex + 1}/3: ${step.subtitle}`
      : 'カードの四隅を枠に合わせ、真上から撮影します。';
    if (cameraAngleBadge) cameraAngleBadge.textContent = step.label;
    if (guidedCameraCapture) guidedCameraCapture.textContent = precision
      ? (guidedCameraState.stepIndex >= PRECISION_STEPS.length - 1 ? '3枚目を撮影して解析' : `${guidedCameraState.stepIndex + 1}枚目を撮影`)
      : '撮影して解析';
    if (guidedCameraRetake) guidedCameraRetake.disabled = precision ? guidedCameraState.files.length === 0 : false;
    if (cameraStepper) {
      cameraStepper.hidden = !precision;
      cameraStepper.innerHTML = precision
        ? PRECISION_STEPS.map((s, i) => `<span class="camera-step ${i < guidedCameraState.files.length ? 'is-done' : i === guidedCameraState.stepIndex ? 'is-active' : ''}">${i + 1}. ${escapeHTML(s.label)}</span>`).join('')
        : '';
    }
    if (guidedCameraStatus) {
      const zoomText = guidedCameraState.zoomApplied
        ? `2倍望遠を要求済み（${Number(guidedCameraState.zoomApplied).toFixed(1)}x）。`
        : guidedCameraState.zoomApplied === false
          ? 'この端末/ブラウザでは2倍望遠を直接指定できないため、通常レンズで撮影します。'
          : '2倍望遠を要求しています。端末非対応の場合は通常レンズで起動します。';
      const qualityText = guidedCameraState.qualityLabel
        ? `画質: ${guidedCameraState.qualityLabel}。`
        : '利用可能な最高画質を要求しています。';
      guidedCameraStatus.textContent = `${zoomText} ${qualityText} カード全体を枠内に入れ、白飛びしない角度で撮影してください。`;
    }
    updateOrientationGuide();
  }

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
        showFailedPreview();
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
      hideFailedPreview();
      hideProgress();
      showResults();
      requestAnimationFrame(() => {
        resizeCanvasStageToFit();
        resetCanvasView();
      });
      setTimeout(() => {
        if (resultsPanel) resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    } finally {
      finish();
    }
  }

  async function handlePrecisionFiles(files) {
    files = (files || []).filter(Boolean);
    if (files.length < 3) return;
    if (isHandlingFile) {
      console.warn('[diagnose] precision analysis requested while already running.');
      return;
    }
    isHandlingFile = true;
    const WATCHDOG_MS = 420000;
    let watchdogFired = false;
    const watchdogTimer = setTimeout(() => {
      watchdogFired = true;
      isHandlingFile = false;
      showError({
        code: 'internal_error',
        message: '高精度解析がタイムアウトしました',
        hint: '3枚の解析に時間がかかっています。ページを再読み込みして、通常モードまたは明るい場所で再撮影してください。',
      });
    }, WATCHDOG_MS);

    const finish = () => {
      clearTimeout(watchdogTimer);
      isHandlingFile = false;
    };

    try {
      hideError();
      userIsWaiting = true;
      if (!files.every(file => ALLOWED_MIME.includes(file.type))) {
        showError({ code: 'invalid_format', message: 'JPEG / PNG / WebP のみ対応しています。' });
        return;
      }
      if (files.some(file => file.size > MAX_FILE_SIZE)) {
        showError({ code: 'file_too_large', message: `画像サイズは1枚あたり ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB 以下にしてください。` });
        return;
      }

      if (!cvReady) setCvStatus('loading', '⏳ 検出エンジン (OpenCV.js) を読み込み中…');
      showProgress(8, '高精度モード: 検出エンジンを準備中', 1);
      await waitForOpenCV();
      if (watchdogFired) return;

      const entries = [];
      for (let i = 0; i < files.length; i++) {
        const step = PRECISION_STEPS[i] || { id: `view${i + 1}`, label: `${i + 1}枚目` };
        showProgress(18 + i * 22, `高精度モード: ${step.label}の画像を解析中`, 2);
        const img = await loadImage(files[i]);
        if (i === 0) currentImage = img;
        const result = await analyzeCardFromImage(img, files[i]);
        if (result && !result.error) entries.push({ file: files[i], img, result, view: step });
      }
      if (watchdogFired) return;

      if (!entries.length) {
        currentImage = await loadImage(files[0]);
        showFailedPreview();
        showError({
          code: 'card_not_found',
          message: 'カードが認識できません',
          hints: [
            '3枚ともカードの四隅が枠内に収まっていますか？',
            'カードと背景の境界が見える明るさですか？',
            '2倍望遠または少し離れた位置から撮影していますか？',
          ],
        });
        return;
      }

      showProgress(88, '高精度モード: 3方向の結果を統合中', 4);
      const aggregate = aggregatePrecisionResults(entries);
      currentImage = entries[0].img;
      currentResult = aggregate;
      renderResults(aggregate);
      hideFailedPreview();
      hideProgress();
      showResults();
      requestAnimationFrame(() => {
        resizeCanvasStageToFit();
        resetCanvasView();
      });
      setTimeout(() => {
        if (resultsPanel) resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    } catch (err) {
      if (!watchdogFired) {
        console.error('[diagnose] precision analysis failed:', err);
        showError({ code: 'internal_error', message: err.message || '高精度解析中にエラーが発生しました' });
      }
    } finally {
      finish();
    }
  }

  function aggregatePrecisionResults(entries) {
    const base = cloneJSON(entries[0].result);
    const merged = [];
    entries.forEach((entry) => {
      (entry.result.detections || []).forEach((d) => {
        const copy = cloneJSON(d);
        copy.source_views = [entry.view.label];
        const existing = merged.find(x => x.type === copy.type && computeDetectionIoU(x, copy) >= 0.32);
        if (existing) {
          existing.confidence = clamp(Math.max(existing.confidence || 0, copy.confidence || 0) + 0.08, 0, 1);
          existing.source_views = Array.from(new Set([...(existing.source_views || []), entry.view.label]));
          if (severityValue(copy.severity) > severityValue(existing.severity)) existing.severity = copy.severity;
        } else {
          merged.push(copy);
        }
      });
    });

    merged.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const filtered = applyNMS(merged, 0.45).slice(0, 20);
    filtered.forEach((d, i) => {
      d.id = `d${i + 1}`;
      if (d.source_views && d.source_views.length > 1) {
        d.explanation = `${d.explanation || ''}（高精度モード: ${d.source_views.join('・')}で確認）`;
      }
    });

    base.detections = filtered;
    base.capture_mode = {
      mode: 'high_precision',
      views: entries.map(e => e.view.label),
      note: '正面・左斜め・右斜めの3枚を個別解析し、重複候補を統合しています。',
    };
    base.engine = {
      ...(base.engine || {}),
      name: `${(base.engine && base.engine.name) || 'opencv-worker'}+multi-angle`,
      version: '0.4.0',
    };
    base.card.centering = choosePrecisionCentering(entries);
    updateResultSummary(base);
    return base;
  }

  function choosePrecisionCentering(entries) {
    const front = entries[0].result.card && entries[0].result.card.centering;
    if (front && front.available) return front;
    return entries
      .map(e => e.result.card && e.result.card.centering)
      .filter(c => c && c.available)
      .sort((a, b) => (b.detection_confidence || 0) - (a.detection_confidence || 0))[0] || { available: false };
  }

  function updateResultSummary(result) {
    const order = { mild: 0, light: 1, moderate: 2, severe: 3, critical: 4 };
    const detections = result.detections || [];
    const highest = detections.reduce((acc, d) => order[d.severity] > order[acc] ? d.severity : acc, 'mild');
    const overall = detections.length ? avg(detections.map(d => d.confidence || 0)) : 0;
    result.summary = {
      ...(result.summary || {}),
      total_detections: detections.length,
      highest_severity: highest,
      overall_confidence: overall,
      overall_recommendation: detections.length === 0
        ? '✅ 高精度モードでも明確な損傷は検出されませんでした。'
        : `${detections.length} 件の損傷候補を検出しました。高精度モードでは複数角度で確認できた候補の信頼度を上げています。`,
    };
  }

  function computeDetectionIoU(a, b) {
    const ab = bboxNormOf(a);
    const bb = bboxNormOf(b);
    return ab && bb ? computeIoU(ab, bb) : 0;
  }

  function severityValue(severity) {
    return ({ mild: 0, light: 1, moderate: 2, severe: 3, critical: 4 })[severity] || 0;
  }

  function cloneJSON(value) {
    return JSON.parse(JSON.stringify(value));
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
    // 入力を canvas に描き、OpenCV worker へ転送する。
    const inputCanvas = document.createElement('canvas');
    // 大きすぎる画像は最大辺 1600px に縮小（精度と速度のバランス）。
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

    showProgress(42, 'OpenCV worker へ画像を転送中', 2);
    await new Promise(r => setTimeout(r, 20));

    const imageData = inputCanvas.getContext('2d').getImageData(0, 0, iw, ih);
    const workerResult = await postWorker('analyze', {
      width: iw,
      height: ih,
      buffer: imageData.data.buffer,
    }, [imageData.data.buffer]);

    if (!workerResult || workerResult.error) return workerResult || { error: 'internal_error' };

    const cardQuadOriginal = Array.isArray(workerResult.cardQuad)
      ? workerResult.cardQuad.map(p => ({ x: p.x / scale, y: p.y / scale }))
      : null;
    const imageQuality = workerResult.imageQuality || { warnings: [], metrics: {} };
    const holoInfo = workerResult.holoInfo || { is_holographic: false };
    const centering = workerResult.centering || null;
    const damages = Array.isArray(workerResult.detections) ? workerResult.detections : [];

    // ID 付与・ラベル整形
    damages.forEach((d, i) => {
      d.id = `d${i + 1}`;
      const meta = DAMAGE_TYPES[d.type] || { jp: d.type, color: '#888' };
      d.type_label_jp = meta.jp;
      d.severity_label_jp = severityLabel(d.severity);
      d.highlight_color = meta.color;
      d.label_short = `${meta.jp} (${d.severity_label_jp})`;
      const key = `${d.type}.${d.severity}`;
      d.repair_methods = REPAIR_METHOD_MAP[key]
        || REPAIR_METHOD_MAP[`${d.type}.moderate`]
        || REPAIR_METHOD_MAP[`${d.type}.light`]
        || [{ name: 'マニュアル本体で確認', chapter: '#chapter-1', summary: 'クイック診断チャートで詳細を確認', priority: 1 }];
      d.explanation = buildExplanation(d);
      if (d.geom && d.geom.kind === 'bbox' && d.geom.norm) {
        const [nx1, ny1, nx2, ny2] = d.geom.norm;
        d.bbox_pixel = [nx1 * RECT_W, ny1 * RECT_H, nx2 * RECT_W, ny2 * RECT_H];
      } else if (d.geom && d.geom.kind === 'polyline' && d.geom.points_norm) {
        const xs = d.geom.points_norm.map(p => p[0] * RECT_W);
        const ys = d.geom.points_norm.map(p => p[1] * RECT_H);
        d.bbox_pixel = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      }
    });

    return buildResultJSON(img, file, damages, {
      imageQuality,
      holoInfo,
      centering,
      cardQuad: cardQuadOriginal,
      engine: workerResult.engine,
    });
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

    candidates.forEach(c => { try { c.contour.delete(); } catch (_) {} });
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

    L.delete();
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
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

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

    L.delete();
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
      if (area < 50) { c.delete(); continue; }
      const r = cv.boundingRect(c);
      c.delete();
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

    S.delete();
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
      const contour = contours.get(i);
      const a = cv.contourArea(contour);
      contour.delete();
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
    let fillRatio = 1;
    if (approx.rows >= 4) {
      const hull = new cv.Mat();
      cv.convexHull(cnt, hull);
      const hullArea = cv.contourArea(hull);
      const minRect = cv.minAreaRect(cnt);
      const rectArea = minRect.size.width * minRect.size.height;
      fillRatio = rectArea > 0 ? hullArea / rectArea : 1;
      maxDevPx = Math.max(0, (1.0 - fillRatio) * minRect.size.width);
      hull.delete();
    }

    const PX_TO_MM = 63.0 / RECT_W;
    const warpMm = maxDevPx * PX_TO_MM;

    let severity = null;
    if (fillRatio <= 0.94) {
      if (warpMm >= 5.0) severity = 'severe';
      else if (warpMm >= 3.5) severity = 'moderate';
      else if (warpMm >= 2.0) severity = 'light';
    }

    cnt.delete();
    approx.delete();
    gray.delete(); edges.delete(); contours.delete(); hier.delete();

    if (!severity) return null;
    return {
      type: 'warp',
      severity,
      confidence: Math.min(1.0, (warpMm - 1.5) / 4),
      metrics: { max_deviation_mm: warpMm, contour_fill_ratio: fillRatio },
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
    const engineInfo = extras.engine || { name: 'opencv-worker', version: '0.3.0' };
    const cardQuad = Array.isArray(extras.cardQuad) && extras.cardQuad.length === 4
      ? extras.cardQuad.map(p => ({
          x: clamp(p.x, 0, img.naturalWidth),
          y: clamp(p.y, 0, img.naturalHeight),
        }))
      : null;
    const cardBBox = cardQuad ? {
      x: Math.min(...cardQuad.map(p => p.x)),
      y: Math.min(...cardQuad.map(p => p.y)),
      w: Math.max(...cardQuad.map(p => p.x)) - Math.min(...cardQuad.map(p => p.x)),
      h: Math.max(...cardQuad.map(p => p.y)) - Math.min(...cardQuad.map(p => p.y)),
    } : null;

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
        estimated_boundary: 'カード外周を明確に切り出せなかったため、中央のカード比率から境界を推定しています。',
      }[code]) || code,
    }));
    const noDetectWarn = detections.length === 0 ? [{ code: 'no_detections', message: '損傷は検出されませんでした。' }] : [];

    return {
      schema_version: '1.1',
      engine: { name: engineInfo.name || 'opencv-worker', version: engineInfo.version || '0.3.0', is_demo: true, model_loaded_at: new Date().toISOString() },
      diagnosed_at: new Date().toISOString(),
      image: {
        filename: file.name, mime: file.type,
        width: img.naturalWidth, height: img.naturalHeight,
        card_bbox: cardBBox,
        card_corners: cardQuad,
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
          worst_ratio: centering.worstRatio,
          method: centering.method,
          detection_confidence: centering.detection_confidence,
          stabilized: !!centering.stabilized,
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
    resetCanvasView();

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
      const wr = Number.isFinite(centering.worst_ratio)
        ? centering.worst_ratio
        : Math.max(
          centering.horizontal.left_px / (centering.horizontal.left_px + centering.horizontal.right_px) * 100,
          centering.horizontal.right_px / (centering.horizontal.left_px + centering.horizontal.right_px) * 100,
          centering.vertical.top_px / (centering.vertical.top_px + centering.vertical.bottom_px) * 100,
          centering.vertical.bottom_px / (centering.vertical.top_px + centering.vertical.bottom_px) * 100,
        );
      note.textContent = `左右の枠幅差は ${hd}%、上下は ${vd}% です。`
        + ` 最も悪い比率は約 ${wr.toFixed(1)}/${(100 - wr).toFixed(1)}、推定グレード ${centering.estimated_grade} です。`
        + (centering.stabilized ? ' 内部の文字線を拾わないよう、現実的なセンタリング範囲へ補正しています。' : '')
        + ` ※ 画像からの参考値で、正式鑑定結果を保証するものではありません。`;
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
  function setupCanvasViewControls() {
    if (!canvasWrapper || !canvasStage) return;
    if (canvasZoomOut) canvasZoomOut.addEventListener('click', () => setCanvasZoom(canvasView.scale / 1.2));
    if (canvasZoomIn) canvasZoomIn.addEventListener('click', () => setCanvasZoom(canvasView.scale * 1.2));
    if (canvasZoomRange) {
      canvasZoomRange.addEventListener('input', () => setCanvasZoom(Number(canvasZoomRange.value) / 100));
    }
    if (canvasRotateLeft) canvasRotateLeft.addEventListener('click', () => rotateCanvasView(-90));
    if (canvasRotateRight) canvasRotateRight.addEventListener('click', () => rotateCanvasView(90));
    if (canvasResetView) canvasResetView.addEventListener('click', resetCanvasView);

    canvasWrapper.addEventListener('wheel', (e) => {
      if (!currentResult) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setCanvasZoom(canvasView.scale * factor);
    }, { passive: false });

    canvasWrapper.addEventListener('pointerdown', (e) => {
      if (!currentResult || e.button !== 0) return;
      canvasView.dragging = true;
      canvasView.moved = false;
      canvasView.pointerId = e.pointerId;
      canvasView.lastX = e.clientX;
      canvasView.lastY = e.clientY;
      canvasStage.classList.add('is-dragging');
      try { canvasWrapper.setPointerCapture(e.pointerId); } catch (_) {}
    });

    canvasWrapper.addEventListener('pointermove', (e) => {
      if (!canvasView.dragging || canvasView.pointerId !== e.pointerId) return;
      const dx = e.clientX - canvasView.lastX;
      const dy = e.clientY - canvasView.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) canvasView.moved = true;
      canvasView.panX += dx;
      canvasView.panY += dy;
      canvasView.lastX = e.clientX;
      canvasView.lastY = e.clientY;
      applyCanvasViewTransform();
      if (canvasTooltip) canvasTooltip.hidden = true;
    });

    const endDrag = (e) => {
      if (!canvasView.dragging || canvasView.pointerId !== e.pointerId) return;
      canvasView.dragging = false;
      canvasView.pointerId = null;
      canvasStage.classList.remove('is-dragging');
      try { canvasWrapper.releasePointerCapture(e.pointerId); } catch (_) {}
      if (canvasView.moved) {
        canvasView.suppressClick = true;
        setTimeout(() => { canvasView.suppressClick = false; }, 0);
      }
    };
    canvasWrapper.addEventListener('pointerup', endDrag);
    canvasWrapper.addEventListener('pointercancel', endDrag);
    window.addEventListener('resize', () => {
      resizeCanvasStageToFit();
      applyCanvasViewTransform();
    });
  }

  function setCanvasZoom(nextScale) {
    canvasView.scale = clamp(Number(nextScale) || 1, 0.25, 5);
    applyCanvasViewTransform();
  }

  function rotateCanvasView(deltaDeg) {
    canvasView.rotation = ((canvasView.rotation + deltaDeg) % 360 + 360) % 360;
    applyCanvasViewTransform();
  }

  function resetCanvasView() {
    canvasView.scale = 1;
    canvasView.rotation = 0;
    canvasView.panX = 0;
    canvasView.panY = 0;
    applyCanvasViewTransform();
  }

  function applyCanvasViewTransform() {
    if (!canvasStage) return;
    const w = canvasStage.clientWidth || canvasStage.offsetWidth || 1;
    const h = canvasStage.clientHeight || canvasStage.offsetHeight || 1;
    const rad = canvasView.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const a = canvasView.scale * cos;
    const b = canvasView.scale * sin;
    const c = -canvasView.scale * sin;
    const d = canvasView.scale * cos;
    const cx = w / 2;
    const cy = h / 2;
    const e = cx + canvasView.panX - a * cx - c * cy;
    const f = cy + canvasView.panY - b * cx - d * cy;
    canvasStage.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${e}, ${f})`;
    const pct = Math.round(canvasView.scale * 100);
    if (canvasZoomRange) canvasZoomRange.value = String(pct);
    if (canvasZoomValue) canvasZoomValue.textContent = `${pct}%`;
  }

  function resizeCanvasStageToFit() {
    if (!canvasWrapper || !canvasStage || !canvasBase || !canvasBase.width || !canvasBase.height) return;
    const aspect = canvasBase.width / canvasBase.height;
    const maxW = canvasWrapper.getBoundingClientRect().width || canvasWrapper.clientWidth || canvasBase.width;
    const maxH = Math.max(260, window.innerHeight * 0.7);
    let w = maxW;
    let h = w / aspect;
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
    canvasStage.style.width = `${Math.max(1, Math.round(w))}px`;
    canvasStage.style.height = `${Math.max(1, Math.round(h))}px`;
  }

  function inverseCanvasViewPoint(clientX, clientY) {
    if (!canvasWrapper || !canvasStage) return null;
    const rect = canvasWrapper.getBoundingClientRect();
    const x = clientX - rect.left - canvasStage.offsetLeft;
    const y = clientY - rect.top - canvasStage.offsetTop;
    const w = canvasStage.clientWidth || canvasStage.offsetWidth || 1;
    const h = canvasStage.clientHeight || canvasStage.offsetHeight || 1;
    const rad = canvasView.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const a = canvasView.scale * cos;
    const b = canvasView.scale * sin;
    const c = -canvasView.scale * sin;
    const d = canvasView.scale * cos;
    const cx = w / 2;
    const cy = h / 2;
    const e = cx + canvasView.panX - a * cx - c * cy;
    const f = cy + canvasView.panY - b * cx - d * cy;
    const det = a * d - b * c || 1;
    const px = x - e;
    const py = y - f;
    return {
      x: (d * px - c * py) / det,
      y: (-b * px + a * py) / det,
      width: w,
      height: h,
    };
  }

  function drawCanvas(img, detections, centering) {
    if (!canvasBase || !canvasOverlay) return;
    const ctxBase = canvasBase.getContext('2d');
    const ctxOver = canvasOverlay.getContext('2d');

    // 表示用の論理ピクセル: 元画像サイズをそのまま使う（CSS で縮小）
    const cw = img.naturalWidth;
    const ch = img.naturalHeight;
    if (canvasStage) canvasStage.style.setProperty('--canvas-aspect', `${cw} / ${ch}`);
    canvasBase.width = canvasOverlay.width = cw;
    canvasBase.height = canvasOverlay.height = ch;
    resizeCanvasStageToFit();
    ctxBase.clearRect(0, 0, cw, ch);
    ctxBase.drawImage(img, 0, 0, cw, ch);
    ctxOver.clearRect(0, 0, cw, ch);

    const mapper = createImageMapper(img, currentResult);

    // センタリングオーバーレイを先に描画（損傷バッジが上に来るように）
    if (centering && centering.available && currentCenteringOverlayEnabled) {
      drawCenteringOverlay(canvasOverlay, centering, mapper);
    }

    detections.forEach((d, i) => {
      drawDetectionOnImage(ctxOver, d, i + 1, mapper);
    });

    setupCanvasInteraction(detections);
    applyCanvasViewTransform();
  }

  function showFailedPreview() {
    if (!failedPreview || !failedPreviewCanvas || !currentImage) return;
    const maxW = 1100;
    const scale = Math.min(1, maxW / currentImage.naturalWidth);
    const w = Math.max(1, Math.round(currentImage.naturalWidth * scale));
    const h = Math.max(1, Math.round(currentImage.naturalHeight * scale));
    failedPreviewCanvas.width = w;
    failedPreviewCanvas.height = h;
    failedPreviewCanvas.getContext('2d').drawImage(currentImage, 0, 0, w, h);
    failedPreview.hidden = false;
  }

  function hideFailedPreview() {
    if (failedPreview) failedPreview.hidden = true;
    if (failedPreviewCanvas) {
      failedPreviewCanvas.width = 0;
      failedPreviewCanvas.height = 0;
    }
  }

  function createImageMapper(img, result) {
    const fallbackQuad = [
      { x: 0, y: 0 },
      { x: img.naturalWidth, y: 0 },
      { x: img.naturalWidth, y: img.naturalHeight },
      { x: 0, y: img.naturalHeight },
    ];
    const corners = result && result.image && Array.isArray(result.image.card_corners)
      ? result.image.card_corners
      : null;
    const quad = corners && corners.length === 4
      ? corners.map(p => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }))
      : fallbackQuad;
    return {
      quad,
      pointNorm(nx, ny) {
        return mapQuadPoint(quad, clamp01(nx), clamp01(ny));
      },
      pointRect(x, y) {
        return mapQuadPoint(quad, clamp01(x / RECT_W), clamp01(y / RECT_H));
      },
    };
  }

  function mapQuadPoint(quad, u, v) {
    const tl = quad[0], tr = quad[1], br = quad[2], bl = quad[3];
    const top = {
      x: tl.x + (tr.x - tl.x) * u,
      y: tl.y + (tr.y - tl.y) * u,
    };
    const bottom = {
      x: bl.x + (br.x - bl.x) * u,
      y: bl.y + (br.y - bl.y) * u,
    };
    return {
      x: top.x + (bottom.x - top.x) * v,
      y: top.y + (bottom.y - top.y) * v,
    };
  }

  function drawDetectionOnImage(ctx, d, num, mapper) {
    const color = d.highlight_color || (DAMAGE_TYPES[d.type] || {}).color || '#ff5252';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color + '33';
    ctx.lineWidth = Math.max(3, ctx.canvas.width / 350);

    d._hitPoly = null;
    d._hitSegments = null;

    let bx = 0, by = 0;
    if (d.geom && d.geom.kind === 'polyline' && d.geom.points_norm) {
      const pts = d.geom.points_norm.map(p => mapper.pointNorm(p[0], p[1]));
      ctx.beginPath();
      pts.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
      if (pts[0]) { bx = pts[0].x; by = pts[0].y; }
      d._hitSegments = pts.length >= 2 ? [[pts[0], pts[pts.length - 1], Math.max(12, ctx.lineWidth * 4)]] : null;
    } else if (d.geom && d.geom.kind === 'bbox' && d.geom.norm) {
      const [nx1, ny1, nx2, ny2] = d.geom.norm;
      const poly = [
        mapper.pointNorm(nx1, ny1),
        mapper.pointNorm(nx2, ny1),
        mapper.pointNorm(nx2, ny2),
        mapper.pointNorm(nx1, ny2),
      ];
      drawPolygonPath(ctx, poly);
      ctx.fill();
      ctx.stroke();
      d._hitPoly = poly;
      bx = poly[0].x; by = poly[0].y;
    } else if (d.geom && d.geom.kind === 'card_global') {
      // カード全体: 外枠を破線で
      ctx.setLineDash([10, 6]);
      drawPolygonPath(ctx, mapper.quad);
      ctx.stroke();
      ctx.setLineDash([]);
      d._hitPoly = mapper.quad;
      bx = mapper.quad[0].x + 30; by = mapper.quad[0].y + 30;
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

  function drawPolygonPath(ctx, points) {
    if (!points || !points.length) return;
    ctx.beginPath();
    points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
  }

  function setupCanvasInteraction(detections) {
    if (!canvasOverlay) return;
    canvasOverlay.onpointermove = (e) => {
      if (canvasView.dragging) return;
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
      if (canvasView.suppressClick) return;
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
    const transformed = inverseCanvasViewPoint(e.clientX, e.clientY);
    if (transformed && canvasOverlay) {
      return {
        x: transformed.x * (canvasOverlay.width / transformed.width),
        y: transformed.y * (canvasOverlay.height / transformed.height),
      };
    }
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
    if (d._hitPoly && pointInPolygon(pt, d._hitPoly)) return true;
    if (d._hitSegments) {
      return d._hitSegments.some(([a, b, threshold]) => distancePointToSegment(pt, a, b) <= threshold);
    }
    return false;
  }

  function pointInPolygon(pt, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y;
      const xj = polygon[j].x, yj = polygon[j].y;
      const intersects = ((yi > pt.y) !== (yj > pt.y))
        && (pt.x < (xj - xi) * (pt.y - yi) / ((yj - yi) || 1e-9) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function distancePointToSegment(pt, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(pt.x - a.x, pt.y - a.y);
    const t = clamp(((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2, 0, 1);
    return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
  }

  function highlightOnCanvas(detId) {
    if (!currentResult) return;
    const d = currentResult.detections.find(x => x.id === detId);
    if (!d) return;
    const ctx = canvasOverlay.getContext('2d');
    const cw = canvasOverlay.width, ch = canvasOverlay.height;
    const mapper = createImageMapper(currentImage, currentResult);
    const centering = currentResult.card && currentResult.card.centering;
    let pulses = 0;
    const id = setInterval(() => {
      ctx.clearRect(0, 0, cw, ch);
      // センタリングオーバーレイを再描画
      if (centering && centering.available && currentCenteringOverlayEnabled) {
        drawCenteringOverlay(canvasOverlay, centering, mapper);
      }
      currentResult.detections.forEach((dd, i) => {
        const isTarget = dd.id === detId;
        ctx.globalAlpha = isTarget ? (pulses % 2 === 0 ? 1 : 0.45) : 0.6;
        drawDetectionOnImage(ctx, dd, i + 1, mapper);
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
    hideFailedPreview();
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
    if (cvStatus && cvStatus.dataset.status !== 'failed') cvStatus.hidden = true;
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
    if (
      currentImage &&
      !['invalid_format', 'file_too_large', 'load_failed', 'invalid_input', 'sample_load_failed'].includes(err.code)
    ) {
      showFailedPreview();
    }
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
      camera_unavailable:'❌ カメラを起動できません',
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
  function hideError() {
    if (errorState) errorState.hidden = true;
    hideFailedPreview();
  }

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

    Hch.delete(); Sch.delete();
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
    const bw = Math.max(0, nx2 - nx1);
    const bh = Math.max(0, ny2 - ny1);
    const area = bw * bh;

    for (const z of DETECT_PARAMS.textZones) {
      const overlap = overlapRatio1D(ny1, ny2, z.y1, z.y2);
      if (cy >= z.y1 && cy <= z.y2 || overlap >= 0.35) {
        if (d.type === 'indent') {
          const areaMm2 = d.metrics && Number.isFinite(d.metrics.area_mm2) ? d.metrics.area_mm2 : 0;
          const smallTextBlob = areaMm2 < 30 && (area < 0.018 || bh < 0.055);
          d.confidence = (d.confidence || 0) * (smallTextBlob ? z.strength : 0.9);
        } else if (d.type === 'crease') {
          d.confidence = (d.confidence || 0) * (isPrintedRuleLine(d) ? 0.35 : 0.75);
        } else {
          d.confidence = (d.confidence || 0) * 0.55;
        }
        d._mask_applied = (d._mask_applied || []).concat([z.name]);
        break;
      }
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

  function isPrintedRuleLine(d) {
    if (!d.geom || d.geom.kind !== 'polyline' || !d.geom.points_norm) return false;
    const [[x1, y1], [x2, y2]] = d.geom.points_norm;
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const length = Math.hypot(dx, dy);
    return length > 0.08 && (dy / (dx || 1e-9)) < 0.16;
  }

  function overlapRatio1D(a1, a2, b1, b2) {
    const inter = Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
    return inter / Math.max(1e-9, a2 - a1);
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

    return stabilizeCenteringFrame({
      top, bottom, left, right,
      outer: [0, 0, W, H],
      inner: [innerX1, innerY1, innerX2, innerY2],
      confidence,
      method: 'scan',
    }, W, H);
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

  function stabilizeCenteringFrame(frame, W, H) {
    const h = constrainMarginPair(frame.left, frame.right, W * 0.025, W * 0.13);
    const v = constrainMarginPair(frame.top, frame.bottom, H * 0.018, H * 0.13);
    if (!h || !v) return null;
    const stabilized = h.stabilized || v.stabilized;
    const left = h.a;
    const right = h.b;
    const top = v.a;
    const bottom = v.b;
    return {
      ...frame,
      top,
      bottom,
      left,
      right,
      inner: [Math.round(left), Math.round(top), Math.round(W - right), Math.round(H - bottom)],
      confidence: clamp01((frame.confidence || 0) * (stabilized ? 0.82 : 1)),
      stabilized,
    };
  }

  function constrainMarginPair(a, b, minMargin, maxMargin) {
    if (!isFinite(a) || !isFinite(b) || a <= 0 || b <= 0) return null;
    let x = clamp(a, minMargin, maxMargin);
    let y = clamp(b, minMargin, maxMargin);
    let stabilized = Math.abs(x - a) > 1 || Math.abs(y - b) > 1;
    const maxRatio = 1.22;
    const lo = Math.min(x, y);
    const hi = Math.max(x, y);
    if (lo > 0 && hi / lo > maxRatio) {
      if (x > y) x = y * maxRatio;
      else y = x * maxRatio;
      stabilized = true;
    }
    return { a: x, b: y, stabilized };
  }

  /**
   * 枠幅からセンタリング比率を計算
   * @param {{top:number,bottom:number,left:number,right:number, outer, inner, confidence}} frame
   */
  function computeCentering(frame) {
    const { top, bottom, left, right } = frame;
    const horizSum = left + right;
    const vertSum = top + bottom;
    if (horizSum <= 0 || vertSum <= 0) return null;
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
    const worstRatio = Math.max(leftPct, rightPct, topPct, bottomPct);

    let estimatedGrade;
    if (worstRatio <= 55) estimatedGrade = 'GEM MINT 10';
    else if (worstRatio <= 60) estimatedGrade = 'MINT 9';
    else if (worstRatio <= 65) estimatedGrade = 'NM-MT 8';
    else if (worstRatio <= 70) estimatedGrade = 'NM 7';
    else if (worstRatio <= 80) estimatedGrade = 'EX-MT 6';
    else if (worstRatio <= 85) estimatedGrade = 'EX 5/4';
    else if (worstRatio <= 90) estimatedGrade = 'VG or lower';
    else estimatedGrade = 'OC';

    const overallScore = Math.max(0, Math.round(100 - (worstRatio - 50) * 2));

    return {
      horizontal,
      vertical,
      estimatedGrade,
      overallScore,
      worstDeviation,
      worstRatio,
      annotation: {
        outer_rect: frame.outer,
        inner_rect: frame.inner,
      },
      detection_confidence: frame.confidence,
      stabilized: !!frame.stabilized,
    };
  }

  /**
   * Canvas にセンタリングオーバーレイを描画
   * @param {HTMLCanvasElement} canvas - canvasOverlay
   * @param {object} centering - JSON.card.centering
   * @param {{pointRect:function}} mapper - 正面化座標から元画像キャンバスへのマッパー
   */
  function drawCenteringOverlay(canvas, centering, mapper) {
    if (!canvas || !centering || !centering.available) return;
    const ctx = canvas.getContext('2d');
    const ann = centering.annotation;
    if (!ann || !ann.outer_rect || !ann.inner_rect) return;

    const [ox1, oy1, ox2, oy2] = ann.outer_rect;
    const [ix1, iy1, ix2, iy2] = ann.inner_rect;
    const outer = [
      mapper.pointRect(ox1, oy1),
      mapper.pointRect(ox2, oy1),
      mapper.pointRect(ox2, oy2),
      mapper.pointRect(ox1, oy2),
    ];
    const inner = [
      mapper.pointRect(ix1, iy1),
      mapper.pointRect(ix2, iy1),
      mapper.pointRect(ix2, iy2),
      mapper.pointRect(ix1, iy2),
    ];

    ctx.save();
    // 外枠（緑）
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = Math.max(2, canvas.width / 400);
    ctx.setLineDash([]);
    drawPolygonPath(ctx, outer);
    ctx.stroke();

    // 内枠（青）
    ctx.strokeStyle = '#3b82f6';
    ctx.setLineDash([8, 4]);
    drawPolygonPath(ctx, inner);
    ctx.stroke();
    ctx.setLineDash([]);

    // 4辺の矢印（枠幅を可視化）
    ctx.strokeStyle = '#fbbf24';
    ctx.fillStyle = '#fbbf24';
    ctx.lineWidth = Math.max(1.5, canvas.width / 600);
    const topOuter = mapper.pointRect((ox1 + ox2) / 2, oy1);
    const topInner = mapper.pointRect((ix1 + ix2) / 2, iy1);
    const bottomOuter = mapper.pointRect((ox1 + ox2) / 2, oy2);
    const bottomInner = mapper.pointRect((ix1 + ix2) / 2, iy2);
    const leftOuter = mapper.pointRect(ox1, (oy1 + oy2) / 2);
    const leftInner = mapper.pointRect(ix1, (iy1 + iy2) / 2);
    const rightOuter = mapper.pointRect(ox2, (oy1 + oy2) / 2);
    const rightInner = mapper.pointRect(ix2, (iy1 + iy2) / 2);
    drawArrow(ctx, topOuter.x, topOuter.y, topInner.x, topInner.y);
    drawArrow(ctx, bottomOuter.x, bottomOuter.y, bottomInner.x, bottomInner.y);
    drawArrow(ctx, leftOuter.x, leftOuter.y, leftInner.x, leftInner.y);
    drawArrow(ctx, rightOuter.x, rightOuter.y, rightInner.x, rightInner.y);

    // テキスト: 比率ラベル
    const fontSize = Math.max(14, canvas.width / 60);
    ctx.font = `bold ${fontSize}px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = `${centering.horizontal.ratio_label} ・ ${centering.vertical.ratio_label}`;
    const center = mapper.pointRect((ix1 + ix2) / 2, (iy1 + iy2) / 2);
    const tx = center.x;
    const ty = center.y;
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
