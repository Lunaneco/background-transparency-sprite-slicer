/**
 * 背景透過&スプライト切り出し編集ツール - アプリケーションロジック
 * すべてのコメントは日本語、変数名は英語で記述。
 */

document.addEventListener('DOMContentLoaded', () => {
  // Lucideアイコンの安全な初期化
  function safeCreateIcons() {
    if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
      try {
        lucide.createIcons();
      } catch (e) {
        console.error('Lucideアイコンの生成に失敗しました:', e);
      }
    }
  }

  safeCreateIcons();

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    // file:// や権限が制限されたブラウザ向けのフォールバック
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('Clipboard copy failed');
  }

  // IndexedDB が使用可能かチェックし、不可ならメモリ内オブジェクトにフォールバック
  let isIndexedDBSupported = true;
  try {
    isIndexedDBSupported = ('indexedDB' in window) && (window.indexedDB !== null);
  } catch (e) {
    isIndexedDBSupported = false;
  }

  // メモリ内フォールバック用のセーブスロットデータ
  const memorySaveSlots = {};

  // IndexedDBの設定
  const dbName = 'SpriteSlicerDB';
  const storeName = 'saveSlots';

  // ブラウザ上で安全に処理できる上限。大きすぎる画像は主スレッドやメモリを圧迫する。
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
  const MAX_IMAGE_PIXELS = 16_000_000;
  const MAX_AUTO_DETECT_PIXELS = 8_000_000;
  const MAX_DETECTED_SLICES = 2_000;
  const MAX_TRANSPARENCY_PIXELS = 8_000_000;
  const MAX_EXPORT_SLICE_PIXELS = 16_000_000;
  const MAX_ZIP_FILE_COUNT = 5_000;
  const MAX_ZIP_ENTRY_BYTES = 52 * 1024 * 1024;
  const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
  const MAX_ZIP_METADATA_BYTES = 2 * 1024 * 1024;
  const MAX_SAFE_NAME_LENGTH = 80;
  const MAX_IMAGE_DATA_URL_LENGTH = Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 1024;
  const IMAGE_MIME_BY_EXTENSION = Object.freeze({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp'
  });
  const RESERVED_SLICE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
  // 大きな画像で履歴がメモリを使い切らないよう、画像サイズに応じて履歴数を絞る。
  const HISTORY_MEMORY_BUDGET_BYTES = 160 * 1024 * 1024;

  // ==========================================================================
  // 状態管理 (State)
  // ==========================================================================
  let imgState = {
    element: null,          // Image または Canvas オブジェクト（編集中のキャンバス）
    originalElement: null,  // 編集前のオリジナル画像（Canvas オブジェクト）
    width: 0,               // 元画像の幅
    height: 0,              // 元画像の高さ
    name: 'spritesheet'     // 画像ファイル名（拡張子なし）
  };

  let canvasState = {
    zoom: 1.0,          // ズーム倍率
    offsetX: 0,         // パン（スクロール）のオフセット X
    offsetY: 0,         // パン（スクロール）のオフセット Y
    isPanning: false,   // パン移動中かどうか
    panStartX: 0,
    panStartY: 0,
    isDrawing: false,   // 手動範囲選択のドラッグ中かどうか
    drawStartX: 0,
    drawStartY: 0,
    drawCurrentX: 0,
    drawCurrentY: 0,
    backgroundTheme: 'dark', // 'dark', 'light', 'transparent'
    showLabels: true,
    showGridLines: false,
    lastMouseDownX: 0,  // ドラッグ距離計測用
    lastMouseDownY: 0,  // ドラッグ距離計測用
    // スライス移動・リサイズ状態
    dragState: {
      type: 'none',     // 'none', 'move', 'resize-tl', 'resize-tr', 'resize-bl', 'resize-br'
      startMouseX: 0,
      startMouseY: 0,
      originalSlice: null
    }
  };

  let historyState = {
    undoStack: [],      // Undo用の状態スタック
    redoStack: [],      // Redo用の状態スタック
    maxSize: 30         // 最大履歴保存数
  };
  let isCoordinateEditInProgress = false;
  let coordinateHistorySaved = false;
  let isRotationEditInProgress = false;
  let rotationHistorySaved = false;

  let slices = [];       // スライスデータの配列: { id, name, x, y, w, h }
  let selectedSliceId = null; // 現在選択されているスライスのID
  let nextSliceId = 1;   // 次に割り当てるスライスID
  let copiedSlice = null; // コピーされたスライスデータ

  let registeredCategories = []; // 登録済みカテゴリー名の配列
  let activeCategoryName = null; // 現在アクティブなカテゴリー名
  let categoryCounters = Object.create(null); // カテゴリー名ごとの連番カウンター

  // アクティブな分割モード ('auto', 'manual')
  let activeMode = 'auto';
  let isMoveImageMode = false;

  // 消しゴムツール用の状態
  let isEraserMode = false;     // 消しゴムモードが有効か
  let eraserSize = 20;          // ブラシサイズ（px）
  let eraserMouseX = 0;         // 消しゴムカーソルX座標
  let eraserMouseY = 0;         // 消しゴムカーソルY座標
  let isMouseInCanvas = false;  // マウスがキャンバス上にあるか
  let isErasing = false;        // ドラッグ消去中か
  let lastEraserX = 0;          // 前回の消去座標X
  let lastEraserY = 0;          // 前回の消去座標Y
  let isRestoreMode = false;    // 復元モードが有効か
  let isRestoring = false;      // ドラッグ復元中か
  let lastRestoreX = 0;         // 前回の復元座標X
  let lastRestoreY = 0;         // 前回の復元座標Y
  let isSpacePressed = false;   // スペースキーが押されているか

  // ==========================================================================
  // DOM 要素の取得
  // ==========================================================================
  const fileUpload = document.getElementById('file-upload');
  const fileUploadDrag = document.getElementById('file-upload-drag');
  const btnLoadDemo = document.getElementById('btn-load-demo');
  const btnLoadDemoEmpty = document.getElementById('btn-load-demo-empty');
  const btnLoadDemoDragon = document.getElementById('btn-load-demo-dragon');
  const btnLoadDemoDragonEmpty = document.getElementById('btn-load-demo-dragon-empty');
  const dropZone = document.getElementById('drop-zone');
  const canvasWrapper = document.getElementById('canvas-wrapper');
  const canvasContainer = document.getElementById('canvas-container');
  const mainCanvas = document.getElementById('sprite-canvas');
  const mainCtx = mainCanvas.getContext('2d');

  // モード選択ボタン
  const modeAuto = document.getElementById('mode-auto');
  const modeManual = document.getElementById('mode-manual');
  
  // 設定パネル
  const autoSettings = document.getElementById('auto-settings');
  const manualSettings = document.getElementById('manual-settings');

  // 表示設定
  const bgDarkBtn = document.getElementById('bg-dark-btn');
  const bgLightBtn = document.getElementById('bg-light-btn');
  const bgTransparentBtn = document.getElementById('bg-transparent-btn');
  const showLabelsCheckbox = document.getElementById('show-labels');

  // キャンバスツールバー
  const btnZoomIn = document.getElementById('btn-zoom-in');
  const btnZoomOut = document.getElementById('btn-zoom-out');
  const btnZoomReset = document.getElementById('btn-zoom-reset');
  const zoomValue = document.getElementById('zoom-value');
  const imageSizeInfo = document.getElementById('image-size-info');
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');

  // セーブスロット関連
  const saveSlotSelect = document.getElementById('save-slot-select');
  const saveSlotName = document.getElementById('save-slot-name');
  const slotInfoBox = document.getElementById('slot-info-box');
  const btnSaveSlot = document.getElementById('btn-save-slot');
  const btnLoadSlot = document.getElementById('btn-load-slot');
  const btnDeleteSlotDB = document.getElementById('btn-delete-slot-db');
  const btnClearAllSaves = document.getElementById('btn-clear-all-saves');

  // 命名・カテゴリー設定
  const categoryPrefixInput = document.getElementById('category-prefix');
  const btnAddCategory = document.getElementById('btn-add-category');
  const registeredCategoriesSection = document.getElementById('registered-categories-section');
  const categoryTagsContainer = document.getElementById('category-tags-container');

  // 自動検出設定
  const toleranceInput = document.getElementById('tolerance');
  const toleranceVal = document.getElementById('tolerance-val');
  const minSizeInput = document.getElementById('min-size');
  const btnDetectSlices = document.getElementById('btn-detect-slices');



  // 選択詳細パネル
  const selectionDetailPanel = document.getElementById('selection-detail-panel');
  const slicePreviewCanvas = document.getElementById('slice-preview-canvas');
  const sliceNameInput = document.getElementById('slice-name');
  const btnUpdateSlice = document.getElementById('btn-update-slice');
  const btnDuplicateSlice = document.getElementById('btn-duplicate-slice');
  const btnDeleteSlice = document.getElementById('btn-delete-slice');
  const btnRenameSlicesAuto = document.getElementById('btn-rename-slices-auto');
  const btnMoveImageMode = document.getElementById('btn-move-image-mode');
  const btnClearImageContent = document.getElementById('btn-clear-image-content');
  const sliceXInput = document.getElementById('slice-x');
  const sliceYInput = document.getElementById('slice-y');
  const sliceWInput = document.getElementById('slice-w');
  const sliceHInput = document.getElementById('slice-h');

  const sliceRotationInput = document.getElementById('slice-rotation');
  const sliceRotationNumInput = document.getElementById('slice-rotation-num');

  // スライスリスト
  const sliceListContainer = document.getElementById('slice-list-container');
  const sliceCounter = document.getElementById('slice-counter');
  const btnClearAll = document.getElementById('btn-clear-all');

  // エクスポート＆コード
  const btnExportZip = document.getElementById('btn-export-zip');
  const codeOutput = document.getElementById('code-output');
  const btnCopyCode = document.getElementById('btn-copy-code');
  const codeTabs = document.querySelectorAll('.code-tab');
  let activeTab = 'json';

  // トースト
  const toastContainer = document.getElementById('toast-container');

  // 消しゴムツール関連
  const btnEraserMode = document.getElementById('btn-eraser-mode');
  const btnRestoreMode = document.getElementById('btn-restore-mode');
  const brushModeBadge = document.getElementById('brush-mode-badge');
  const eraserSizeControl = document.getElementById('eraser-size-control');
  const eraserSizeSlider = document.getElementById('eraser-size-slider');
  const eraserSizeValue = document.getElementById('eraser-size-value');

  // 高機能透過ツール関連
  const btnHeaderTransparency = document.getElementById('btn-header-transparency');
  const btnTransparency = document.getElementById('btn-transparency');
  const transparencyModal = document.getElementById('transparency-modal');
  const btnCloseTransparencyModal = document.getElementById('btn-close-transparency-modal');
  const btnCancelTransparency = document.getElementById('btn-cancel-transparency');
  const btnApplyTransparency = document.getElementById('btn-apply-transparency');
  const transparencyColor = document.getElementById('transparency-color');
  const transparencyColorPreview = document.getElementById('transparency-color-preview');
  const btnTransparencyPicker = document.getElementById('btn-transparency-picker');
  const transparencyColorHex = document.getElementById('transparency-color-hex');
  const transparencyTolerance = document.getElementById('transparency-tolerance');
  const transparencyToleranceVal = document.getElementById('transparency-tolerance-val');
  const transparencyFeather = document.getElementById('transparency-feather');
  const transparencyFeatherVal = document.getElementById('transparency-feather-val');
  const transparencyChoke = document.getElementById('transparency-choke');
  const transparencyChokeVal = document.getElementById('transparency-choke-val');
  const transparencyDefringe = document.getElementById('transparency-defringe');
  const transparencyRangeSliceLabel = document.getElementById('transparency-range-slice-label');
  const transparencySliceNameText = document.getElementById('transparency-slice-name-text');
  const transparencyPreviewCanvas = document.getElementById('transparency-preview-canvas');

  let previewSourceCanvas = null; // 元画像プレビューソース用Canvas
  let isPipetteActive = false; // スポイト機能がアクティブか
  let lastFocusedElement = null;
  let autoDetectAfterTransparency = false; // サンプル2の透過適用後にのみ自動検出する

  // ==========================================================================
  // 初期化 & イベントバインディング
  // ==========================================================================
  
  // 透過関連の初期設定
  if (btnHeaderTransparency) btnHeaderTransparency.addEventListener('click', openTransparencyModal);
  if (btnTransparency) btnTransparency.addEventListener('click', openTransparencyModal);
  if (btnCloseTransparencyModal) btnCloseTransparencyModal.addEventListener('click', closeTransparencyModal);
  if (btnCancelTransparency) btnCancelTransparency.addEventListener('click', closeTransparencyModal);
  if (btnApplyTransparency) btnApplyTransparency.addEventListener('click', applyTransparency);
  
  if (transparencyColor) {
    transparencyColor.addEventListener('input', (e) => {
      const color = e.target.value;
      if (transparencyColorPreview) transparencyColorPreview.style.backgroundColor = color;
      if (transparencyColorHex) transparencyColorHex.textContent = color.toUpperCase();
      updateTransparencyPreview();
    });
  }
  
  if (transparencyColorPreview) {
    transparencyColorPreview.addEventListener('click', () => {
      if (transparencyColor) transparencyColor.click();
    });
    transparencyColorPreview.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (transparencyColor) transparencyColor.click();
      }
    });
  }

  if (btnTransparencyPicker) {
    btnTransparencyPicker.addEventListener('click', () => {
      togglePipetteMode();
    });
  }

  const handleSliderUpdate = (slider, valSpan, formatFn) => {
    if (slider) {
      slider.addEventListener('input', (e) => {
        if (valSpan) valSpan.textContent = formatFn(e.target.value);
        updateTransparencyPreview();
      });
    }
  };

  handleSliderUpdate(transparencyTolerance, transparencyToleranceVal, v => v);
  handleSliderUpdate(transparencyFeather, transparencyFeatherVal, v => `${v} px`);
  handleSliderUpdate(transparencyChoke, transparencyChokeVal, v => `${v} px`);

  if (transparencyDefringe) {
    transparencyDefringe.addEventListener('change', updateTransparencyPreview);
  }

  // 適用範囲の切り替え
  const rangeRadios = document.getElementsByName('transparency-range');
  rangeRadios.forEach(radio => {
    radio.addEventListener('change', updateTransparencyPreview);
  });

  
  // ファイル選択イベント
  fileUpload.addEventListener('change', handleFileSelect);
  fileUploadDrag.addEventListener('change', handleFileSelect);
  if (btnLoadDemo) btnLoadDemo.addEventListener('click', loadDemoImage);
  if (btnLoadDemoEmpty) btnLoadDemoEmpty.addEventListener('click', loadDemoImage);
  if (btnLoadDemoDragon) btnLoadDemoDragon.addEventListener('click', loadDemoDragonImage);
  if (btnLoadDemoDragonEmpty) btnLoadDemoDragonEmpty.addEventListener('click', loadDemoDragonImage);
  
  // ドラッグ＆ドロップ
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      loadImage(e.dataTransfer.files[0]);
    }
  });

  // 分割モードの切り替え
  const modeButtons = [
    { btn: modeAuto, mode: 'auto', panel: autoSettings },
    { btn: modeManual, mode: 'manual', panel: manualSettings }
  ];

  modeButtons.forEach(item => {
    item.btn.addEventListener('click', () => {
      modeButtons.forEach(i => {
        i.btn.classList.remove('active');
        i.panel.classList.add('hidden');
      });
      item.btn.classList.add('active');
      item.panel.classList.remove('hidden');
      activeMode = item.mode;
      
      // 他の切り分けモードへ変更した時は、ピクセル移動モードを自動で解除
      isMoveImageMode = false;
      updateMoveImageButton();
      deactivateEraserModeUI();
      deactivateRestoreModeUI();
      
      // 手動モードに切り替えたときは、キャンバスの描画ステートを準備
      if (activeMode === 'manual') {
        canvasContainer.classList.add('drawing');
      } else {
        canvasContainer.classList.remove('drawing');
      }
      
      renderCanvas();
      showToast(`${item.btn.querySelector('span').textContent}モードに切り替えました。`);
    });
  });

  // 自動検出設定の閾値スライダー数値同期
  toleranceInput.addEventListener('input', (e) => {
    toleranceVal.textContent = e.target.value;
  });

  // 自動検出実行
  btnDetectSlices.addEventListener('click', () => {
    if (!imgState.element) {
      showToast('先に画像を読み込んでください。', 'danger');
      return;
    }
    if (slices.length > 0) {
      if (!confirm('既存のスライスデータはすべて上書きされます。よろしいですか？')) {
        return;
      }
    }
    detectSlicesAuto();
  });



  // 背景切り替え
  const bgButtons = [
    { btn: bgDarkBtn, theme: 'dark' },
    { btn: bgLightBtn, theme: 'light' },
    { btn: bgTransparentBtn, theme: 'transparent' }
  ];

  bgButtons.forEach(item => {
    item.btn.addEventListener('click', () => {
      bgButtons.forEach(i => i.btn.classList.remove('active'));
      item.btn.classList.add('active');
      canvasState.backgroundTheme = item.theme;
      
      // キャンバスコンテナのクラスを更新してCSS背景を適用
      canvasContainer.className = 'canvas-container';
      if (activeMode === 'manual') {
        canvasContainer.classList.add('drawing');
      }
      if (item.theme === 'dark') {
        canvasContainer.style.backgroundColor = 'var(--bg-canvas-dark)';
        canvasContainer.style.backgroundImage = 'none';
      } else if (item.theme === 'light') {
        canvasContainer.style.backgroundColor = 'var(--bg-canvas-light)';
        canvasContainer.style.backgroundImage = 'none';
      } else {
        canvasContainer.style.backgroundColor = '#ffffff';
        // style.cssの bg-transparent-pattern と同じパターンをJSでインライン適用
        canvasContainer.style.backgroundImage = 
          'linear-gradient(45deg, #e2e8f0 25%, transparent 25%), ' +
          'linear-gradient(-45deg, #e2e8f0 25%, transparent 25%), ' +
          'linear-gradient(45deg, transparent 75%, #e2e8f0 75%), ' +
          'linear-gradient(-45deg, transparent 75%, #e2e8f0 75%)';
        canvasContainer.style.backgroundSize = '10px 10px';
        canvasContainer.style.backgroundPosition = '0 0, 0 5px, 5px -5px, -5px 0px';
      }
      renderCanvas();
    });
  });

  // 表示チェックボックス
  showLabelsCheckbox.addEventListener('change', (e) => {
    canvasState.showLabels = e.target.checked;
    renderCanvas();
  });


  // キャンバスツールバーの操作
  btnZoomIn.addEventListener('click', () => adjustZoom(0.1));
  btnZoomOut.addEventListener('click', () => adjustZoom(-0.1));
  btnZoomReset.addEventListener('click', resetZoomAndPan);

  // 消しゴムツールの操作
  if (btnEraserMode) {
    btnEraserMode.addEventListener('click', toggleEraserMode);
  }
  if (btnRestoreMode) {
    btnRestoreMode.addEventListener('click', toggleRestoreMode);
  }
  if (eraserSizeSlider) {
    eraserSizeSlider.addEventListener('input', (e) => {
      eraserSize = parseInt(e.target.value, 10) || 20;
      if (eraserSizeValue) {
        eraserSizeValue.textContent = `${eraserSize}px`;
      }
      renderCanvas(); // プレビューの太さ円を更新
    });
  }

  // 全クリア
  btnClearAll.addEventListener('click', () => {
    if (slices.length === 0) return;
    if (confirm('すべてのスライス設定を消去しますか？')) {
      saveHistory(); // クリア前に履歴保存
      slices = [];
      selectedSliceId = null;
      nextSliceId = 1;
      updateSliceList();
      hideSelectionDetail();
      renderCanvas();
      updateCodeOutput();
      btnExportZip.disabled = true;
      showToast('スライスをクリアしました。');
    }
  });

  // 選択スライスの更新
  btnUpdateSlice.addEventListener('click', () => {
    if (selectedSliceId === null) return;
    const sliceIndex = slices.findIndex(s => s.id === selectedSliceId);
    if (sliceIndex === -1) return;

    const baseName = imgState.name || 'sprite';
    const category = activeCategoryName;
    const slicePrefix = category ? `${baseName}_${category}` : baseName;
    const requestedName = sliceNameInput.value.trim() || `${slicePrefix}_${selectedSliceId}`;
    const newName = getUniqueSliceName(
      requestedName,
      getUsedSliceNames(selectedSliceId),
      `sprite_${selectedSliceId}`
    );

    saveHistory(); // 更新前に履歴保存

    slices[sliceIndex].name = newName;
    sliceNameInput.value = newName;

    const nameNotice = requestedName === newName ? '' : `（安全な名前「${newName}」に調整）`;
    showToast(`スライス名を更新しました。${nameNotice}`);
    updateSliceList();
    renderCanvas();
    updateCodeOutput();
    renderSlicePreview(slices[sliceIndex]);
  });

  // 選択スライスの複製
  if (btnDuplicateSlice) {
    btnDuplicateSlice.addEventListener('click', () => {
      if (selectedSliceId === null) return;
      const slice = slices.find(s => s.id === selectedSliceId);
      if (slice) {
        copySlice(slice);
        pasteSlice();
      }
    });
  }

  function beginCoordinateEdit() {
    if (selectedSliceId === null || !imgState.element || isCoordinateEditInProgress) return;
    // 値が実際に変わるまで履歴は確保しない。フォーカスだけで大きなCanvasを複製しないため。
    isCoordinateEditInProgress = true;
  }

  // 座標とサイズの入力欄が変更された際のリアルタイム反映
  function handleCoordinateInput(e) {
    if (selectedSliceId === null || !imgState.element) return;
    
    const sliceIndex = slices.findIndex(s => s.id === selectedSliceId);
    if (sliceIndex === -1) return;

    let val = parseInt(e.target.value, 10);
    if (isNaN(val)) return;

    const prop = e.target.id.replace('slice-', ''); // 'x', 'y', 'w', 'h'
    const original = slices[sliceIndex];
    let updated = { ...original };

    // バリデーションと範囲制限
    if (prop === 'x') {
      updated.x = Math.max(0, Math.min(imgState.width - original.w, val));
      e.target.value = updated.x;
    } else if (prop === 'y') {
      updated.y = Math.max(0, Math.min(imgState.height - original.h, val));
      e.target.value = updated.y;
    } else if (prop === 'w') {
      updated.w = Math.max(1, Math.min(imgState.width - original.x, val));
      e.target.value = updated.w;
    } else if (prop === 'h') {
      updated.h = Math.max(1, Math.min(imgState.height - original.y, val));
      e.target.value = updated.h;
    }

    const hasChanged = updated.x !== original.x ||
      updated.y !== original.y ||
      updated.w !== original.w ||
      updated.h !== original.h;
    if (!hasChanged) return;

    // focusせずに値を変更する操作にも対応する。
    beginCoordinateEdit();
    if (!coordinateHistorySaved) {
      saveHistory();
      coordinateHistorySaved = true;
    }

    slices[sliceIndex] = updated;

    // リスト内の詳細テキスト更新
    const detailsEl = document.querySelector(`.slice-item[data-id="${updated.id}"] .slice-item-details`);
    if (detailsEl) {
      detailsEl.textContent = `X: ${updated.x} Y: ${updated.y} (${updated.w}x${updated.h})`;
    }

    renderSlicePreview(updated);
    renderCanvas();
    updateCodeOutput();
  }

  // フォーカスアウト時、またはEnterキー押下時に編集セッションを終了
  function handleCoordinateCommit(e) {
    if (selectedSliceId === null) return;
    
    // 履歴は input の直前に保存済み。ここでは連続入力を一区切りにする。
    if (e.type === 'blur' || (e.type === 'keydown' && e.key === 'Enter')) {
      isCoordinateEditInProgress = false;
      coordinateHistorySaved = false;
      if (e.type === 'keydown' && e.key === 'Enter') {
        e.target.blur(); // フォーカスを外す
      }
    }
  }

  [sliceXInput, sliceYInput, sliceWInput, sliceHInput].forEach(input => {
    if (input) {
      input.addEventListener('focus', beginCoordinateEdit);
      input.addEventListener('input', handleCoordinateInput);
      input.addEventListener('blur', handleCoordinateCommit);
      input.addEventListener('keydown', handleCoordinateCommit);
    }
  });



  function beginRotationEdit() {
    if (selectedSliceId === null || !imgState.element || isMoveImageMode || isRotationEditInProgress) return;
    isRotationEditInProgress = true;
  }

  // スライス画像の回転入力欄変更時のリアルタイム反映
  function handleRotationInput(e) {
    if (selectedSliceId === null || !imgState.element) return;

    const sliceIndex = slices.findIndex(s => s.id === selectedSliceId);
    if (sliceIndex === -1) return;

    let val = parseInt(e.target.value, 10);
    if (isNaN(val)) val = 0;

    val = Math.max(-180, Math.min(180, val));

    if (e.target === sliceRotationInput) {
      sliceRotationNumInput.value = val;
    } else {
      sliceRotationInput.value = val;
    }

    const currentRotation = slices[sliceIndex].rotation || 0;
    if (currentRotation === val) return;

    beginRotationEdit();
    if (!isMoveImageMode && !rotationHistorySaved) {
      saveHistory();
      rotationHistorySaved = true;
    }

    // ピクセル移動（画像編集）モード時のみピクセルをその場で回転プレビューさせる
    if (isMoveImageMode) {
      const drag = canvasState.dragState;
      if (drag.type === 'none') {
        const slice = slices[sliceIndex];
        drag.type = 'rotate-ui';
        drag.originalSlice = { ...slice };
        drag.currentPixelX = slice.x;
        drag.currentPixelY = slice.y;
        
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = imgState.width;
        tempCanvas.height = imgState.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(imgState.element, 0, 0);
        
        const sliceCanvas = document.createElement('canvas');
        sliceCanvas.width = slice.w;
        sliceCanvas.height = slice.h;
        const sliceCtx = sliceCanvas.getContext('2d');
        
        const x1 = Math.max(0, Math.min(imgState.width, slice.x));
        const y1 = Math.max(0, Math.min(imgState.height, slice.y));
        const x2 = Math.max(0, Math.min(imgState.width, slice.x + slice.w));
        const y2 = Math.max(0, Math.min(imgState.height, slice.y + slice.h));
        const overlapW = x2 - x1;
        const overlapH = y2 - y1;

        if (overlapW > 0 && overlapH > 0) {
          const srcCtx = imgState.element.getContext('2d');
          const imgData = srcCtx.getImageData(x1, y1, overlapW, overlapH);
          sliceCtx.putImageData(imgData, x1 - slice.x, y1 - slice.y);
          tempCtx.clearRect(x1, y1, overlapW, overlapH);
        }
        
        drag.tempCanvas = tempCanvas;
        drag.sliceImageData = sliceCtx.getImageData(0, 0, slice.w, slice.h);
        
        // 開始角度の初期値（ダミー）
        drag.startAngle = 0;
        drag.originalRotation = 0;
        
        saveHistory(); // 回転変更開始前に履歴保存
      }
    }

    slices[sliceIndex].rotation = val;

    renderSlicePreview(slices[sliceIndex]);
    renderCanvas();
    updateCodeOutput();
  }

  // スライス画像の回転適用（確定）
  function handleRotationCommit(e) {
    // Enterキー押下時、またはスライダーから手を離した/フォーカスアウト時
    if (e.type === 'keydown' && e.key !== 'Enter') return;
    isRotationEditInProgress = false;
    rotationHistorySaved = false;
    
    const drag = canvasState.dragState;
    if (drag.type === 'rotate-ui') {
      const sliceIndex = slices.findIndex(s => s.id === selectedSliceId);
      if (sliceIndex !== -1) {
        const slice = slices[sliceIndex];
        
        // 1. 退避した背景画像に対して、回転したピクセルデータを上書き描画
        const finalCtx = drag.tempCanvas.getContext('2d');
        const tempSliceCanvas = document.createElement('canvas');
        tempSliceCanvas.width = drag.originalSlice.w;
        tempSliceCanvas.height = drag.originalSlice.h;
        tempSliceCanvas.getContext('2d').putImageData(drag.sliceImageData, 0, 0);
        
        if (slice.rotation && slice.rotation !== 0) {
          finalCtx.save();
          const cx = drag.currentPixelX + drag.originalSlice.w / 2;
          const cy = drag.currentPixelY + drag.originalSlice.h / 2;
          finalCtx.translate(cx, cy);
          finalCtx.rotate(slice.rotation * Math.PI / 180);
          finalCtx.drawImage(tempSliceCanvas, -drag.originalSlice.w / 2, -drag.originalSlice.h / 2);
          finalCtx.restore();
        } else {
          finalCtx.drawImage(tempSliceCanvas, drag.currentPixelX, drag.currentPixelY);
        }
        
        // 2. 背景画像を同期更新
        imgState.element = drag.tempCanvas;
        imgState.width = drag.tempCanvas.width;
        imgState.height = drag.tempCanvas.height;
        
        // スライス自体の回転角度を同期
        if (sliceRotationInput) sliceRotationInput.value = slice.rotation || 0;
        if (sliceRotationNumInput) sliceRotationNumInput.value = slice.rotation || 0;
        
        updateSliceList();
        renderCanvas();
        updateCodeOutput();
        if (selectedSliceId !== null) {
          const currentSlice = slices.find(s => s.id === selectedSliceId);
          if (currentSlice) {
            renderSlicePreview(currentSlice);
          }
        }
        showToast('画像ピクセルの回転を適用しました。');
      }
      
      drag.type = 'none';
      drag.originalSlice = null;
      drag.tempCanvas = null;
      drag.sliceImageData = null;
      
      // 自動的にピクセル移動モードを解除する
      isMoveImageMode = false;
      updateMoveImageButton();
    }
  }

  [sliceRotationInput, sliceRotationNumInput].forEach(input => {
    if (input) {
      input.addEventListener('focus', beginRotationEdit);
      input.addEventListener('input', handleRotationInput);
      input.addEventListener('change', handleRotationCommit);
      input.addEventListener('blur', handleRotationCommit);
      input.addEventListener('keydown', handleRotationCommit);
    }
  });



  // 画像ピクセル移動ボタンの表示更新ヘルパー
  function updateMoveImageButton() {
    if (!btnMoveImageMode) return;
    const inactiveEl = btnMoveImageMode.querySelector('.btn-content-inactive');
    const activeEl = btnMoveImageMode.querySelector('.btn-content-active');
    
    if (isMoveImageMode) {
      btnMoveImageMode.classList.add('btn-active');
      if (inactiveEl) inactiveEl.classList.add('hidden');
      if (activeEl) activeEl.classList.remove('hidden');
    } else {
      btnMoveImageMode.classList.remove('btn-active');
      if (inactiveEl) inactiveEl.classList.remove('hidden');
      if (activeEl) activeEl.classList.add('hidden');
    }
    updateShortcutHints();
  }

  // 画像ピクセル自体を移動させるモードの切り替え
  if (btnMoveImageMode) {
    btnMoveImageMode.addEventListener('click', () => {
      if (isMoveImageMode) {
        // 画像ピクセル移動モードを確実に解除
        isMoveImageMode = false;
        updateMoveImageButton();
        renderCanvas();
        showToast('画像編集モードを解除しました。');
      } else {
        // 画像ピクセル移動モードを有効化（スライスが選択されていることが必須）
        if (selectedSliceId === null) {
          showToast('移動するスライスを選択してください。', 'danger');
          return;
        }
        isMoveImageMode = true;
        updateMoveImageButton();
        deactivateEraserModeUI();
        deactivateRestoreModeUI();
        renderCanvas();
        showToast('画像編集モード：枠内をドラッグして移動、上の回転ハンドルで回転、枠の四隅をドラッグすると画像ごとリサイズします。');
      }
    });
  }

  // 選択スライスの画像中身を消去
  if (btnClearImageContent) {
    btnClearImageContent.addEventListener('click', () => {
      if (selectedSliceId === null) {
        showToast('消去するスライスを選択してください。', 'danger');
        return;
      }
      
      const slice = slices.find(s => s.id === selectedSliceId);
      if (!slice) return;
      
      if (!confirm(`${slice.name} の画像ピクセルを消去（透明化）しますか？`)) {
        return;
      }
      
      saveHistory(); // 消去前に履歴保存
      
      // イミュータブル設計：新しいCanvasを作成して現在の画像データをコピー
      const newCanvas = document.createElement('canvas');
      newCanvas.width = imgState.width;
      newCanvas.height = imgState.height;
      const newCtx = newCanvas.getContext('2d');
      newCtx.drawImage(imgState.element, 0, 0);
      
      // 画像外へのはみ出しを考慮してクランプ（IndexSizeError防止）
      const x1 = Math.max(0, Math.min(imgState.width, slice.x));
      const y1 = Math.max(0, Math.min(imgState.height, slice.y));
      const x2 = Math.max(0, Math.min(imgState.width, slice.x + slice.w));
      const y2 = Math.max(0, Math.min(imgState.height, slice.y + slice.h));
      const overlapW = x2 - x1;
      const overlapH = y2 - y1;
      
      if (overlapW > 0 && overlapH > 0) {
        newCtx.clearRect(x1, y1, overlapW, overlapH);
      }
      
      // キャンバス自体を差し替え（同期更新）
      imgState.element = newCanvas;
      
      updateSliceList();
      renderCanvas();
      updateCodeOutput();
      renderSlicePreview(slice);
      showToast('画像ピクセルを消去しました。');
    });
  }

  // 選択スライスの削除
  btnDeleteSlice.addEventListener('click', () => {
    if (selectedSliceId === null) return;
    deleteSlice(selectedSliceId);
  });

  // コピペコードタブの切り替え
  codeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      codeTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeTab = tab.dataset.tab;
      updateCodeOutput();
    });
  });

  // コードのコピー
  btnCopyCode.addEventListener('click', async () => {
    const text = codeOutput.textContent;
    if (!imgState.element || slices.length === 0 || !text) {
      showToast('先に画像を読み込み、スライスを作成してください。', 'danger');
      return;
    }

    try {
      await copyTextToClipboard(text);
      showToast('コードをクリップボードにコピーしました！');
    } catch (err) {
      showToast('コピーに失敗しました。', 'danger');
    }
  });

  // ZIPエクスポート
  btnExportZip.addEventListener('click', exportSlicesToZip);

  // Undo / Redo ボタンのイベントリスナー
  btnUndo.addEventListener('click', undo);
  btnRedo.addEventListener('click', redo);

  // キーボードによるショートカット (Undo / Redo / 削除 / 選択移動)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && transparencyModal && !transparencyModal.classList.contains('hidden')) {
      closeTransparencyModal();
      return;
    }

    const activeTagName = document.activeElement.tagName;
    const targetTagName = e.target.tagName;
    if (activeTagName === 'INPUT' || activeTagName === 'TEXTAREA' || activeTagName === 'SELECT' ||
        targetTagName === 'INPUT' || targetTagName === 'TEXTAREA' || targetTagName === 'SELECT' ||
        e.target.isContentEditable) {
      return;
    }
    
    // スペースキーによる一時的なパン（手のひらツール）
    if (e.key === ' ' || e.code === 'Space') {
      if (!isSpacePressed) {
        isSpacePressed = true;
        e.preventDefault();
        canvasContainer.style.cursor = 'grab';
        updateShortcutHints();
      }
      return;
    }
    
    const isZ = e.key.toLowerCase() === 'z' || e.code === 'KeyZ';
    const isY = e.key.toLowerCase() === 'y' || e.code === 'KeyY';
    const isC = e.key.toLowerCase() === 'c' || e.code === 'KeyC';
    const isV = e.key.toLowerCase() === 'v' || e.code === 'KeyV';
    
    // コピー (Ctrl+C / Cmd+C)
    if ((e.ctrlKey || e.metaKey) && isC && selectedSliceId !== null) {
      e.preventDefault();
      const slice = slices.find(s => s.id === selectedSliceId);
      if (slice) copySlice(slice);
    }
    // 貼り付け (Ctrl+V / Cmd+V)
    else if ((e.ctrlKey || e.metaKey) && isV) {
      e.preventDefault();
      pasteSlice();
    }
    // Undo (Ctrl+Z / Cmd+Z)
    else if ((e.ctrlKey || e.metaKey) && isZ && !e.shiftKey) {
      e.preventDefault();
      undo();
    }
    // Redo (Ctrl+Y / Cmd+Shift+Z)
    else if (((e.ctrlKey || e.metaKey) && isY) || 
             ((e.ctrlKey || e.metaKey) && e.shiftKey && isZ)) {
      e.preventDefault();
      redo();
    }
    // 削除 (Delete / Backspace)
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedSliceId !== null) {
      e.preventDefault();
      deleteSlice(selectedSliceId);
    }
    // 解除 (Escape)
    else if (e.key === 'Escape') {
      e.preventDefault();
      if (isEraserMode) {
        deactivateEraserModeUI();
        renderCanvas();
        showToast('消しゴムツールを解除しました。');
      }
      if (isRestoreMode) {
        deactivateRestoreModeUI();
        renderCanvas();
        showToast('復元ブラシツールを解除しました。');
      }
      if (isMoveImageMode) {
        isMoveImageMode = false;
        updateMoveImageButton();
        renderCanvas();
        showToast('画像編集モードを解除しました。');
      }
    }
    // 位置の微調整 (Shift + Arrow Keys)
    else if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') && selectedSliceId !== null) {
      e.preventDefault();
      const sliceIndex = slices.findIndex(s => s.id === selectedSliceId);
      if (sliceIndex !== -1) {
        saveHistory(); // 移動前に履歴保存
        const slice = slices[sliceIndex];
        const amount = e.altKey ? 10 : 1; // Altキー併用で10ピクセル移動
        let newX = slice.x;
        let newY = slice.y;

        if (e.key === 'ArrowLeft') newX -= amount;
        else if (e.key === 'ArrowRight') newX += amount;
        else if (e.key === 'ArrowUp') newY -= amount;
        else if (e.key === 'ArrowDown') newY += amount;

        // 画像境界内にクランプ
        newX = Math.max(0, Math.min(imgState.width - slice.w, newX));
        newY = Math.max(0, Math.min(imgState.height - slice.h, newY));

        slice.x = newX;
        slice.y = newY;

        // UIとプレビューの更新
        if (sliceXInput) sliceXInput.value = newX;
        if (sliceYInput) sliceYInput.value = newY;

        const detailsEl = document.querySelector(`.slice-item[data-id="${slice.id}"] .slice-item-details`);
        if (detailsEl) {
          detailsEl.textContent = `X: ${newX} Y: ${newY} (${slice.w}x${slice.h})`;
        }

        renderSlicePreview(slice);
        renderCanvas();
        updateCodeOutput();
      }
    }
    // 選択移動 (Arrow Keys)
    else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      selectAdjacentSlice('left');
    }
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      selectAdjacentSlice('right');
    }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectAdjacentSlice('up');
    }
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectAdjacentSlice('down');
    }
  });

  // スペースキー解放でのパンモード解除
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.code === 'Space') {
      isSpacePressed = false;
      // 元のカーソル形状に戻す
      canvasContainer.style.cursor = (isEraserMode || isRestoreMode) ? 'none' : (activeMode === 'manual' ? 'crosshair' : 'grab');
      updateShortcutHints();
    }
  });

  // セーブスロット関連のイベントリスナー
  saveSlotSelect.addEventListener('change', updateSlotInfo);
  btnSaveSlot.addEventListener('click', handleSaveSlot);
  btnLoadSlot.addEventListener('click', handleLoadSlot);
  btnDeleteSlotDB.addEventListener('click', handleDeleteSlot);
  if (btnClearAllSaves) btnClearAllSaves.addEventListener('click', handleClearAllSaves);

  // スライス名一括振り直し
  btnRenameSlicesAuto.addEventListener('click', renameSlicesAuto);

  // カテゴリー接頭辞関連のイベントリスナー
  categoryPrefixInput.addEventListener('input', () => {
    const val = categoryPrefixInput.value.trim();
    if (val) {
      btnAddCategory.classList.remove('hidden');
      btnAddCategory.textContent = `${val}追加`;
    } else {
      btnAddCategory.classList.add('hidden');
    }
  });

  btnAddCategory.addEventListener('click', () => {
    const requestedValue = categoryPrefixInput.value.trim();
    const val = sanitizeSliceName(requestedValue, 'category');
    if (requestedValue) {
      if (!registeredCategories.includes(val)) {
        registeredCategories.push(val);
        categoryCounters[val] = 1;
      }
      categoryPrefixInput.value = '';
      btnAddCategory.classList.add('hidden');
      registeredCategoriesSection.classList.remove('hidden');
      
      activeCategoryName = val;
      categoryCounters[val] = 1; // 追加時も1からスタート
      renderCategoryTags();
      if (requestedValue !== val) {
        showToast(`カテゴリー名を安全な形式「${val}」に調整しました。`);
      }
    }
  });

  // 起動時にセーブスロットを初期化
  initializeSaveSlots();

  // ==========================================================================
  // ファイル処理 (File Handling)
  // ==========================================================================
  function handleFileSelect(e) {
    if (e.target.files.length > 0) {
      loadImage(e.target.files[0]);
    }
  }

  function getImageMimeTypeFromName(fileName) {
    const match = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? IMAGE_MIME_BY_EXTENSION[match[1]] || null : null;
  }

  function sanitizeIdentifierToken(value, fallback = 'spritesheet') {
    let safe = String(value || '')
      .normalize('NFKC')
      .replace(/[^a-zA-Z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, MAX_SAFE_NAME_LENGTH);

    if (!safe || !/^[a-zA-Z_]/.test(safe) || RESERVED_SLICE_NAMES.has(safe.toLowerCase())) {
      safe = fallback;
    }
    return safe.slice(0, MAX_SAFE_NAME_LENGTH);
  }

  function sanitizeSliceName(value, fallback = 'sprite') {
    let safe = String(value || '')
      .normalize('NFKC')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, MAX_SAFE_NAME_LENGTH);

    if (!safe || RESERVED_SLICE_NAMES.has(safe.toLowerCase())) {
      safe = fallback;
    }
    return safe.slice(0, MAX_SAFE_NAME_LENGTH);
  }

  function getUniqueSliceName(value, usedNames = new Set(), fallback = 'sprite') {
    const base = sanitizeSliceName(value, fallback);
    let candidate = base;
    let sequence = 2;

    while (usedNames.has(candidate.toLowerCase())) {
      const suffix = `_${sequence}`;
      candidate = `${base.slice(0, Math.max(1, MAX_SAFE_NAME_LENGTH - suffix.length))}${suffix}`;
      sequence++;
    }

    usedNames.add(candidate.toLowerCase());
    return candidate;
  }

  function getUsedSliceNames(excludeId = null) {
    return new Set(
      slices
        .filter(slice => slice.id !== excludeId)
        .map(slice => sanitizeSliceName(slice.name, `sprite_${slice.id}`).toLowerCase())
    );
  }

  function getSafeImageName(rawFileName) {
    const dotIndex = rawFileName.lastIndexOf('.');
    const baseName = dotIndex !== -1 ? rawFileName.substring(0, dotIndex) : rawFileName;
    return sanitizeIdentifierToken(baseName, 'spritesheet');
  }

  function isSupportedImageFile(file) {
    return Boolean(file && getImageMimeTypeFromName(file.name));
  }

  function isSafeZipEntryPath(entryName) {
    const normalizedName = String(entryName || '').replace(/\/+$/, '');
    if (!normalizedName || normalizedName.length > 240 || /[\\\u0000]/.test(normalizedName)) return false;
    if (normalizedName.startsWith('/') || /^[a-zA-Z]:/.test(normalizedName)) return false;
    return normalizedName.split('/').every(part => part && part !== '.' && part !== '..');
  }

  function getZipEntryUncompressedSize(entry) {
    const size = Number(entry && entry._data && entry._data.uncompressedSize);
    return Number.isSafeInteger(size) && size >= 0 ? size : null;
  }

  function inspectZipBeforeExtraction(zip) {
    const allEntries = Object.entries(zip.files || {});
    if (allEntries.length === 0 || allEntries.length > MAX_ZIP_FILE_COUNT) {
      return { error: `ZIP内のファイル数は ${MAX_ZIP_FILE_COUNT.toLocaleString()} 個までです。` };
    }

    let totalUncompressedBytes = 0;
    for (const [name, entry] of allEntries) {
      const originalName = entry && entry.unsafeOriginalName ? entry.unsafeOriginalName : name;
      if (!isSafeZipEntryPath(originalName)) {
        return { error: '安全でないパスを含むZIPファイルは読み込めません。' };
      }
      if (entry && entry.dir) continue;

      const entrySize = getZipEntryUncompressedSize(entry);
      if (entrySize === null || entrySize > MAX_ZIP_ENTRY_BYTES) {
        return { error: 'ZIP内に大きすぎる、またはサイズを確認できないファイルがあります。' };
      }
      totalUncompressedBytes += entrySize;
      if (totalUncompressedBytes > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
        return { error: `ZIPの展開後サイズは ${Math.floor(MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES / 1024 / 1024)} MB までです。` };
      }
    }

    return { totalUncompressedBytes };
  }

  function normalizeImportedFrames(frames, imageWidth, imageHeight) {
    if (!frames || typeof frames !== 'object' || Array.isArray(frames)) {
      return { slices: [], skippedCount: 0, renamedCount: 0 };
    }

    const entries = Object.entries(frames);
    if (entries.length > MAX_DETECTED_SLICES) {
      return { error: `ZIP内のスライス数は ${MAX_DETECTED_SLICES.toLocaleString()} 個までです。` };
    }

    const usedNames = new Set();
    const normalizedSlices = [];
    let skippedCount = 0;
    let renamedCount = 0;
    let totalSlicePixels = 0;

    for (const [rawName, frameData] of entries) {
      const frame = getValidFrameBounds(frameData && frameData.frame, imageWidth, imageHeight);
      if (!frame) {
        skippedCount++;
        continue;
      }

      totalSlicePixels += frame.w * frame.h;
      if (totalSlicePixels > MAX_EXPORT_SLICE_PIXELS) {
        return { error: `ZIP内スライスの合計は ${MAX_EXPORT_SLICE_PIXELS.toLocaleString()} 画素までです。` };
      }

      const safeName = getUniqueSliceName(rawName, usedNames, `sprite_${normalizedSlices.length + 1}`);
      if (safeName !== rawName) renamedCount++;
      normalizedSlices.push({
        id: normalizedSlices.length + 1,
        name: safeName,
        ...frame,
        rotation: normalizeImportedRotation(frameData && frameData.rotation)
      });
    }

    return { slices: normalizedSlices, skippedCount, renamedCount };
  }

  function normalizeSavedSlices(savedSlices, imageWidth, imageHeight) {
    if (!Array.isArray(savedSlices)) {
      return { error: '保存データのスライス形式が正しくありません。' };
    }
    if (savedSlices.length > MAX_DETECTED_SLICES) {
      return { error: `保存データのスライス数は ${MAX_DETECTED_SLICES.toLocaleString()} 個までです。` };
    }

    const usedNames = new Set();
    const normalizedSlices = [];
    let skippedCount = 0;
    let totalSlicePixels = 0;

    for (const savedSlice of savedSlices) {
      const frame = getValidFrameBounds(savedSlice, imageWidth, imageHeight);
      if (!frame) {
        skippedCount++;
        continue;
      }

      totalSlicePixels += frame.w * frame.h;
      if (totalSlicePixels > MAX_EXPORT_SLICE_PIXELS) {
        return { error: `保存データ内スライスの合計は ${MAX_EXPORT_SLICE_PIXELS.toLocaleString()} 画素までです。` };
      }

      normalizedSlices.push({
        id: normalizedSlices.length + 1,
        name: getUniqueSliceName(savedSlice && savedSlice.name, usedNames, `sprite_${normalizedSlices.length + 1}`),
        ...frame,
        rotation: normalizeImportedRotation(savedSlice && savedSlice.rotation)
      });
    }

    return { slices: normalizedSlices, skippedCount };
  }

  function isSafeStoredImageDataUrl(value) {
    return typeof value === 'string'
      && value.length <= MAX_IMAGE_DATA_URL_LENGTH
      && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(value);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => resolve(event.target.result);
      reader.onerror = () => reject(new Error('Failed to read image data'));
      reader.readAsDataURL(blob);
    });
  }

  function isImageSizeSupported(width, height) {
    const pixelCount = width * height;
    if (!Number.isFinite(pixelCount) || width < 1 || height < 1) {
      showToast('画像のサイズを取得できませんでした。', 'danger');
      return false;
    }
    if (pixelCount > MAX_IMAGE_PIXELS) {
      showToast(`画像が大きすぎます（上限 ${MAX_IMAGE_PIXELS.toLocaleString()} 画素）。縮小してから読み込んでください。`, 'danger');
      return false;
    }
    return true;
  }

  function getValidFrameBounds(frame, imageWidth, imageHeight) {
    if (!frame || typeof frame !== 'object') return null;
    const x = Number(frame.x);
    const y = Number(frame.y);
    const w = Number(frame.w);
    const h = Number(frame.h);
    const values = [x, y, w, h];
    if (!values.every(Number.isInteger)) return null;
    if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > imageWidth || y + h > imageHeight) {
      return null;
    }
    return { x, y, w, h };
  }

  function normalizeImportedRotation(rotation) {
    const numericRotation = Number(rotation);
    if (!Number.isFinite(numericRotation)) return 0;
    return Math.max(-180, Math.min(180, Math.round(numericRotation)));
  }

  function finishLoadingImage(img, rawFileName, successMessage = '画像を読み込みました。', options = {}) {
    if (!isImageSizeSupported(img.width, img.height)) return false;
    const { autoDetect = true } = options;
    autoDetectAfterTransparency = false;

    // 画像データを直接描画・編集できるようにCanvas要素に変換して保持
    const offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = img.width;
    offscreenCanvas.height = img.height;
    const offscreenCtx = offscreenCanvas.getContext('2d');
    offscreenCtx.drawImage(img, 0, 0);

    // オリジナルのCanvas要素も保持しておく（編集前の状態）
    const originalCanvas = document.createElement('canvas');
    originalCanvas.width = img.width;
    originalCanvas.height = img.height;
    const originalCtx = originalCanvas.getContext('2d');
    originalCtx.drawImage(img, 0, 0);

    imgState.element = offscreenCanvas;
    imgState.originalElement = originalCanvas;
    imgState.width = img.width;
    imgState.height = img.height;
    imgState.name = getSafeImageName(rawFileName);

    imageSizeInfo.textContent = `${img.width} x ${img.height} px`;
    mainCanvas.width = img.width;
    mainCanvas.height = img.height;
    dropZone.classList.add('hidden');
    canvasWrapper.classList.remove('hidden');
    resetZoomAndPan();

    slices = [];
    selectedSliceId = null;
    nextSliceId = 1;
    isCoordinateEditInProgress = false;
    coordinateHistorySaved = false;
    isRotationEditInProgress = false;
    rotationHistorySaved = false;
    updateSliceList();
    hideSelectionDetail();

    historyState.undoStack = [];
    historyState.redoStack = [];
    saveHistory();

    btnExportZip.disabled = true;
    updateCodeOutput();
    if (autoDetect) {
      detectSlicesAuto(true);
    } else {
      renderCanvas();
    }
    showToast(successMessage);
    return true;
  }

  function loadDemoImage() {
    const demoCanvas = document.createElement('canvas');
    demoCanvas.width = 448;
    demoCanvas.height = 224;
    const ctx = demoCanvas.getContext('2d');

    const drawSprite = (x, y, body, accent, direction) => {
      ctx.fillStyle = body;
      ctx.fillRect(x + 18, y + 4, 28, 10);
      ctx.fillRect(x + 12, y + 14, 40, 28);
      ctx.fillRect(x + 8, y + 22, 48, 12);
      ctx.fillRect(x + 16, y + 42, 10, 16);
      ctx.fillRect(x + 38, y + 42, 10, 16);
      ctx.fillStyle = accent;
      ctx.fillRect(x + (direction < 0 ? 6 : 50), y + 26, 10, 8);
      ctx.fillRect(x + 24, y + 20, 16, 6);
    };

    const frames = [
      [24, 28, '#8b5cf6', '#fbbf24', -1], [128, 28, '#8b5cf6', '#fbbf24', 1],
      [232, 28, '#06b6d4', '#f472b6', -1], [336, 28, '#06b6d4', '#f472b6', 1],
      [24, 132, '#22c55e', '#f97316', -1], [128, 132, '#22c55e', '#f97316', 1],
      [232, 132, '#ef4444', '#eab308', -1], [336, 132, '#ef4444', '#eab308', 1]
    ];
    frames.forEach(([x, y, body, accent, direction]) => drawSprite(x, y, body, accent, direction));
    finishLoadingImage(demoCanvas, 'demo_sprite.png', 'サンプルを読み込みました。8個のスプライトを自動検出しています。');
  }

  function setDemoDragonTransparencyPreset() {
    const greenScreenColor = '#00ff00';
    transparencyColor.value = greenScreenColor;
    if (transparencyColorPreview) transparencyColorPreview.style.backgroundColor = greenScreenColor;
    if (transparencyColorHex) transparencyColorHex.textContent = greenScreenColor.toUpperCase();

    transparencyTolerance.value = '25';
    if (transparencyToleranceVal) transparencyToleranceVal.textContent = '25';
    transparencyFeather.value = '1';
    if (transparencyFeatherVal) transparencyFeatherVal.textContent = '1 px';
    transparencyChoke.value = '0';
    if (transparencyChokeVal) transparencyChokeVal.textContent = '0 px';
    transparencyDefringe.checked = true;
  }

  function loadDemoDragonImage() {
    const demoDragonImage = new Image();
    demoDragonImage.onload = () => {
      const loaded = finishLoadingImage(
        demoDragonImage,
        'sample_dragon_green.png',
        'サンプル画像2を読み込みました。緑を指定済みの背景透過画面で「透過を適用する」を押してください。',
        { autoDetect: false }
      );
      if (!loaded) return;

      setDemoDragonTransparencyPreset();
      autoDetectAfterTransparency = true;
      openTransparencyModal();
    };
    demoDragonImage.onerror = () => {
      showToast('サンプル画像2を読み込めませんでした。ページを再読み込みしてもう一度お試しください。', 'danger');
    };
    demoDragonImage.src = 'assets/demo-dragon-green.png';
  }

  function loadImage(file) {
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      showToast('ファイルが大きすぎます（上限 50 MB）。縮小または分割してから読み込んでください。', 'danger');
      return;
    }

    // ZIPファイルの読み込みと復元に対応
    const isZipFile = file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
    if (isZipFile) {
      if (typeof JSZip === 'undefined') {
        showToast('ZIPファイルを処理するためのライブラリ (JSZip) が読み込まれていません。', 'danger');
        return;
      }
      
      showToast('ZIPファイルを解析中...');
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const zip = await JSZip.loadAsync(event.target.result);
          const zipInspection = inspectZipBeforeExtraction(zip);
          if (zipInspection.error) {
            showToast(zipInspection.error, 'danger');
            return;
          }

          let jsonFile = null;
          const fileEntries = Object.entries(zip.files).filter(([, entry]) => entry && !entry.dir);
          const fileNames = fileEntries.map(([name]) => name);
          
          const jsonPath = fileNames.find(name => name === 'sprites.json');
          if (jsonPath) {
            jsonFile = zip.files[jsonPath];
          }
          
          let targetImageName = null;
          let slicesData = null;
          
          if (jsonFile) {
            if (getZipEntryUncompressedSize(jsonFile) > MAX_ZIP_METADATA_BYTES) {
              showToast(`sprites.json は ${Math.floor(MAX_ZIP_METADATA_BYTES / 1024 / 1024)} MB までです。`, 'danger');
              return;
            }
            const jsonText = await jsonFile.async('text');
            if (jsonText.length > MAX_ZIP_METADATA_BYTES) {
              showToast(`sprites.json は ${Math.floor(MAX_ZIP_METADATA_BYTES / 1024 / 1024)} MB までです。`, 'danger');
              return;
            }
            const metaData = JSON.parse(jsonText);
            if (metaData && metaData.meta && typeof metaData.meta.image === 'string') {
              const candidateName = metaData.meta.image;
              if (!candidateName.includes('/') && isSafeZipEntryPath(candidateName) && getImageMimeTypeFromName(candidateName)) {
                targetImageName = candidateName;
              }
            }
            if (metaData && metaData.frames && typeof metaData.frames === 'object' && !Array.isArray(metaData.frames)) {
              slicesData = metaData.frames;
            }
          }
          
          let imgEntry = null;
          let origImgEntry = null;

          if (targetImageName) {
            // アプリ出力の編集後シートを優先し、旧形式では元画像もフォールバックする。
            const dotIdx = targetImageName.lastIndexOf('.');
            const baseNameWithoutExt = dotIdx !== -1 ? targetImageName.substring(0, dotIdx) : targetImageName;
            const ext = dotIdx !== -1 ? targetImageName.substring(dotIdx) : '.png';
            const hasEditedSuffix = baseNameWithoutExt.endsWith('_edited');
            const editedName = hasEditedSuffix ? targetImageName : `${baseNameWithoutExt}_edited${ext}`;
            const originalName = hasEditedSuffix
              ? `${baseNameWithoutExt.substring(0, baseNameWithoutExt.length - 7)}${ext}`
              : targetImageName;

            const matchedEditedPath = fileNames.find(name => name === editedName);
            const matchedOrigPath = fileNames.find(name => name === originalName);

            if (matchedEditedPath) {
              imgEntry = zip.files[matchedEditedPath];
              origImgEntry = matchedOrigPath ? zip.files[matchedOrigPath] : null;
            } else if (matchedOrigPath) {
              imgEntry = zip.files[matchedOrigPath];
            }
          }
          
          if (!imgEntry) {
            const candidatePaths = fileNames.filter(name => {
              const isImage = Boolean(getImageMimeTypeFromName(name));
              return isImage && !name.includes('/');
            });
            
            if (candidatePaths.length > 0) {
              imgEntry = zip.files[candidatePaths[0]];
            }
          }
          
          if (!imgEntry) {
            showToast('ZIPファイル内に画像ファイルが見つかりません。', 'danger');
            return;
          }

          const imageMimeType = getImageMimeTypeFromName(imgEntry.name);
          if (!imageMimeType) {
            showToast('ZIP内の画像形式は PNG / JPG / WebP / GIF のみ対応しています。', 'danger');
            return;
          }
          if (getZipEntryUncompressedSize(imgEntry) > MAX_UPLOAD_BYTES) {
            showToast('ZIP内の画像が大きすぎます（上限 50 MB）。', 'danger');
            return;
          }
          
          // 編集後画像の読み込み
          const extractedImageBlob = await imgEntry.async('blob');
          const imgBlob = new Blob([extractedImageBlob], { type: imageMimeType });
          if (imgBlob.size > MAX_UPLOAD_BYTES) {
            showToast('ZIP内の画像が大きすぎます（上限 50 MB）。', 'danger');
            return;
          }
          const imgDataUrl = await blobToDataUrl(imgBlob);

          // オリジナル画像の読み込み（存在する場合）
          let origDataUrl = null;
          const originalMimeType = origImgEntry && getImageMimeTypeFromName(origImgEntry.name);
          if (origImgEntry && originalMimeType && getZipEntryUncompressedSize(origImgEntry) <= MAX_UPLOAD_BYTES) {
            const extractedOriginalBlob = await origImgEntry.async('blob');
            const origBlob = new Blob([extractedOriginalBlob], { type: originalMimeType });
            if (origBlob.size <= MAX_UPLOAD_BYTES) {
              origDataUrl = await blobToDataUrl(origBlob);
            }
          }
          
          const loadImages = async () => {
            const img = await new Promise((resolve, reject) => {
              const tempImg = new Image();
              tempImg.onload = () => resolve(tempImg);
              tempImg.onerror = () => reject(new Error('Failed to load ZIP image'));
              tempImg.src = imgDataUrl;
            });

            if (!isImageSizeSupported(img.width, img.height)) return;

            let origImg = null;
            if (origDataUrl) {
              origImg = await new Promise((resolve, reject) => {
                const tempImg = new Image();
                tempImg.onload = () => resolve(tempImg);
                tempImg.onerror = () => reject(new Error('Failed to load original ZIP image'));
                tempImg.src = origDataUrl;
              });
              if (!isImageSizeSupported(origImg.width, origImg.height) || origImg.width !== img.width || origImg.height !== img.height) {
                origImg = null;
                showToast('ZIP内の元画像のサイズが一致しないため、編集後画像を元画像として使用します。', 'danger');
              }
            }

            const normalizedImport = slicesData
              ? normalizeImportedFrames(slicesData, img.width, img.height)
              : null;
            if (normalizedImport && normalizedImport.error) {
              showToast(normalizedImport.error, 'danger');
              return;
            }

            const offscreenCanvas = document.createElement('canvas');
            offscreenCanvas.width = img.width;
            offscreenCanvas.height = img.height;
            const offscreenCtx = offscreenCanvas.getContext('2d');
            offscreenCtx.drawImage(img, 0, 0);

            const originalCanvas = document.createElement('canvas');
            originalCanvas.width = img.width;
            originalCanvas.height = img.height;
            const originalCtx = originalCanvas.getContext('2d');
            if (origImg) {
              originalCtx.drawImage(origImg, 0, 0);
            } else {
              originalCtx.drawImage(img, 0, 0);
            }
            
            imgState.element = offscreenCanvas;
            imgState.originalElement = originalCanvas;
            imgState.width = img.width;
            imgState.height = img.height;
            
            // ファイル名から_editedを除去して基本名を取得
            const rawName = imgEntry.name.split('/').pop();
            const dotIndex = rawName.lastIndexOf('.');
            let baseName = dotIndex !== -1 ? rawName.substring(0, dotIndex) : rawName;
            if (baseName.endsWith('_edited')) {
              baseName = baseName.substring(0, baseName.length - 7);
            }
            imgState.name = getSafeImageName(baseName);
            
            imageSizeInfo.textContent = `${img.width} x ${img.height} px`;
            mainCanvas.width = img.width;
            mainCanvas.height = img.height;
            dropZone.classList.add('hidden');
            canvasWrapper.classList.remove('hidden');
            resetZoomAndPan();
            
            slices = [];
            selectedSliceId = null;
            nextSliceId = 1;
            isCoordinateEditInProgress = false;
            coordinateHistorySaved = false;
            isRotationEditInProgress = false;
            rotationHistorySaved = false;
            historyState.undoStack = [];
            historyState.redoStack = [];
            saveHistory();

            if (normalizedImport) {
              slices = normalizedImport.slices;
              const skippedFrameCount = normalizedImport.skippedCount;
              const renamedFrameCount = normalizedImport.renamedCount;
              nextSliceId = slices.length + 1;
              selectedSliceId = slices.length > 0 ? slices[0].id : null;
              updateSliceList();
              
              if (selectedSliceId !== null) {
                showSelectionDetail(slices[0], false);
              } else {
                hideSelectionDetail();
              }
              renderCanvas();
              updateCodeOutput();
              btnExportZip.disabled = slices.length === 0;
              if (slices.length === 0 && skippedFrameCount > 0) {
                showToast('ZIP内のスライス座標が不正なため、画像のみ復元しました。', 'danger');
              } else {
                const notices = [];
                if (skippedFrameCount > 0) notices.push(`不正な${skippedFrameCount}個を除外`);
                if (renamedFrameCount > 0) notices.push(`${renamedFrameCount}個の名前を安全な形式に調整`);
                const noticeText = notices.length > 0 ? `（${notices.join('、')}）` : '';
                showToast(`ZIPファイルからスプライト画像と${slices.length}個のスライスを復元しました。${noticeText}`);
              }
            } else {
              detectSlicesAuto(true);
              showToast('ZIPファイルから画像を読み込み、自動スライスを実行しました。');
            }
          };

          await loadImages();
          
        } catch (err) {
          console.error(err);
          showToast('ZIPファイルの読み込み中にエラーが発生しました。', 'danger');
        }
      };
      reader.onerror = () => showToast('ZIPファイルを読み込めませんでした。', 'danger');
      reader.readAsArrayBuffer(file);
      return;
    }

    if (!isSupportedImageFile(file)) {
      showToast('PNG / JPG / WebP / GIF または対応するZIPファイルを選択してください。', 'danger');
      return;
    }

    const imageMimeType = getImageMimeTypeFromName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        finishLoadingImage(img, file.name);
      };
      img.onerror = () => showToast('画像を読み込めませんでした。破損していないか確認してください。', 'danger');
      img.src = event.target.result;
    };
    reader.onerror = () => showToast('ファイルを読み込めませんでした。', 'danger');
    // SVGなどの実行可能なベクター形式を受け入れず、拡張子に対応するラスタ画像として読み込む。
    reader.readAsDataURL(new Blob([file], { type: imageMimeType }));
  }

  // ==========================================================================
  // 消しゴムツール (Eraser Tool)
  // ==========================================================================
  
  function toggleEraserMode() {
    if (!imgState.element) {
      showToast('画像を指定してください。', 'danger');
      return;
    }
    
    isEraserMode = !isEraserMode;
    
    if (isEraserMode) {
      // 画像移動などの他モードを解除
      isMoveImageMode = false;
      updateMoveImageButton();
      
      if (isRestoreMode) {
        deactivateRestoreModeUI();
      }
      
      if (btnEraserMode) btnEraserMode.classList.add('active');
      if (eraserSizeControl) eraserSizeControl.classList.remove('hidden');
      if (canvasContainer) canvasContainer.style.cursor = 'none'; // ブラシ円を見せるためカーソルを非表示化
      
      showToast('消しゴムツール：ドラッグしてなぞったピクセルを透明にします。');
    } else {
      deactivateEraserModeUI();
      showToast('消しゴムツールを解除しました。');
    }
    updateShortcutHints();
    renderCanvas();
  }

  function deactivateEraserModeUI() {
    isEraserMode = false;
    if (btnEraserMode) btnEraserMode.classList.remove('active');
    if (!isRestoreMode) {
      if (eraserSizeControl) eraserSizeControl.classList.add('hidden');
      if (canvasContainer) {
        canvasContainer.style.cursor = activeMode === 'manual' ? 'crosshair' : 'grab';
      }
    }
    updateShortcutHints();
  }

  function toggleRestoreMode() {
    if (!imgState.element) {
      showToast('画像を指定してください。', 'danger');
      return;
    }
    
    isRestoreMode = !isRestoreMode;
    
    if (isRestoreMode) {
      // 他のモードを解除
      isMoveImageMode = false;
      updateMoveImageButton();
      
      if (isEraserMode) {
        deactivateEraserModeUI();
      }
      
      if (btnRestoreMode) btnRestoreMode.classList.add('active');
      if (eraserSizeControl) eraserSizeControl.classList.remove('hidden');
      if (canvasContainer) canvasContainer.style.cursor = 'none';
      
      showToast('復元ブラシツール：ドラッグしてなぞった部分を元の画像に戻します。');
    } else {
      deactivateRestoreModeUI();
      showToast('復元ブラシツールを解除しました。');
    }
    updateShortcutHints();
    renderCanvas();
  }

  function deactivateRestoreModeUI() {
    isRestoreMode = false;
    if (btnRestoreMode) btnRestoreMode.classList.remove('active');
    if (!isEraserMode) {
      if (eraserSizeControl) eraserSizeControl.classList.add('hidden');
      if (canvasContainer) {
        canvasContainer.style.cursor = activeMode === 'manual' ? 'crosshair' : 'grab';
      }
    }
    updateShortcutHints();
  }

  // ショートカットキーのヒント更新
  function updateShortcutHints() {
    const hintsEl = document.getElementById('shortcut-hints');
    if (!hintsEl) return;
    if (!imgState.element) {
      hintsEl.classList.add('hidden');
      return;
    }

    let html = '';
    
    if (isSpacePressed) {
      html = '<span><kbd>ドラッグ</kbd> キャンバス移動</span>';
    } else if (isEraserMode) {
      html = '<span><kbd>ドラッグ</kbd> 消去</span> <span style="opacity: 0.4">|</span> <span><kbd>Space</kbd> 手のひら</span> <span style="opacity: 0.4">|</span> <span><kbd>Esc</kbd> 終了</span> <span style="opacity: 0.4">|</span> <span><kbd>Ctrl+Z</kbd> 戻す</span>';
    } else if (isRestoreMode) {
      html = '<span><kbd>ドラッグ</kbd> 復元</span> <span style="opacity: 0.4">|</span> <span><kbd>Space</kbd> 手のひら</span> <span style="opacity: 0.4">|</span> <span><kbd>Esc</kbd> 終了</span> <span style="opacity: 0.4">|</span> <span><kbd>Ctrl+Z</kbd> 戻す</span>';
    } else if (isMoveImageMode) {
      html = '<span><kbd>ドラッグ</kbd> 画像変形</span> <span style="opacity: 0.4">|</span> <span><kbd>Space</kbd> 手のひら</span> <span style="opacity: 0.4">|</span> <span><kbd>Esc</kbd> 終了</span> <span style="opacity: 0.4">|</span> <span><kbd>Ctrl+Z</kbd> 戻す</span>';
    } else if (selectedSliceId !== null) {
      html = '<span><kbd>Shift + 矢印</kbd> 微調整</span> <span style="opacity: 0.4">|</span> <span><kbd>Ctrl+C</kbd> コピー</span> <span style="opacity: 0.4">|</span> <span><kbd>Delete</kbd> 削除</span> <span style="opacity: 0.4">|</span> <span><kbd>Esc</kbd> 解除</span>';
    } else {
      html = '<span><kbd>ドラッグ</kbd> 新規スライス</span> <span style="opacity: 0.4">|</span> <span><kbd>Ctrl+V</kbd> 貼り付け</span> <span style="opacity: 0.4">|</span> <span><kbd>Space</kbd> 手のひら</span> <span style="opacity: 0.4">|</span> <span><kbd>Ctrl+Z</kbd> 戻す</span>';
    }

    hintsEl.innerHTML = html;
    hintsEl.classList.remove('hidden');
  }

  function erasePixel(x, y) {
    if (!imgState.element) return;
    const ctx = imgState.element.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.beginPath();
    ctx.arc(x, y, eraserSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    
    renderCanvas();
    
    if (selectedSliceId !== null) {
      const selectedSlice = slices.find(s => s.id === selectedSliceId);
      if (selectedSlice) {
        renderSlicePreview(selectedSlice);
      }
    }
  }

  function erasePixelLine(x1, y1, x2, y2) {
    if (!imgState.element) return;
    const ctx = imgState.element.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = eraserSize;
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
    
    renderCanvas();
    
    if (selectedSliceId !== null) {
      const selectedSlice = slices.find(s => s.id === selectedSliceId);
      if (selectedSlice) {
        renderSlicePreview(selectedSlice);
      }
    }
  }

  function restorePixel(x, y) {
    if (!imgState.element || !imgState.originalElement) return;
    
    const size = eraserSize;
    const minX = Math.max(0, Math.floor(x - size));
    const minY = Math.max(0, Math.floor(y - size));
    const maxX = Math.min(imgState.width, Math.ceil(x + size));
    const maxY = Math.min(imgState.height, Math.ceil(y + size));
    const w = maxX - minX;
    const h = maxY - minY;
    
    if (w <= 0 || h <= 0) return;
    
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d');
    
    tempCtx.drawImage(imgState.originalElement, minX, minY, w, h, 0, 0, w, h);
    
    tempCtx.save();
    tempCtx.globalCompositeOperation = 'destination-in';
    tempCtx.fillStyle = 'rgba(0,0,0,1)';
    tempCtx.beginPath();
    tempCtx.arc(x - minX, y - minY, size / 2, 0, Math.PI * 2);
    tempCtx.fill();
    tempCtx.restore();
    
    const mainCtx = imgState.element.getContext('2d');
    mainCtx.save();
    mainCtx.globalCompositeOperation = 'source-over';
    mainCtx.drawImage(tempCanvas, minX, minY);
    mainCtx.restore();
    
    renderCanvas();
    
    if (selectedSliceId !== null) {
      const selectedSlice = slices.find(s => s.id === selectedSliceId);
      if (selectedSlice) {
        renderSlicePreview(selectedSlice);
      }
    }
  }

  function restorePixelLine(x1, y1, x2, y2) {
    if (!imgState.element || !imgState.originalElement) return;
    
    const size = eraserSize;
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - size));
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - size));
    const maxX = Math.min(imgState.width, Math.ceil(Math.max(x1, x2) + size));
    const maxY = Math.min(imgState.height, Math.ceil(Math.max(y1, y2) + size));
    const w = maxX - minX;
    const h = maxY - minY;
    
    if (w <= 0 || h <= 0) return;
    
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d');
    
    tempCtx.drawImage(imgState.originalElement, minX, minY, w, h, 0, 0, w, h);
    
    tempCtx.save();
    tempCtx.globalCompositeOperation = 'destination-in';
    tempCtx.lineCap = 'round';
    tempCtx.lineJoin = 'round';
    tempCtx.lineWidth = size;
    tempCtx.strokeStyle = 'rgba(0,0,0,1)';
    tempCtx.beginPath();
    tempCtx.moveTo(x1 - minX, y1 - minY);
    tempCtx.lineTo(x2 - minX, y2 - minY);
    tempCtx.stroke();
    tempCtx.restore();
    
    const mainCtx = imgState.element.getContext('2d');
    mainCtx.save();
    mainCtx.globalCompositeOperation = 'source-over';
    mainCtx.drawImage(tempCanvas, minX, minY);
    mainCtx.restore();
    
    renderCanvas();
    
    if (selectedSliceId !== null) {
      const selectedSlice = slices.find(s => s.id === selectedSliceId);
      if (selectedSlice) {
        renderSlicePreview(selectedSlice);
      }
    }
  }

  // ==========================================================================
  // 高機能背景透過ツール (Advanced Background Transparency)
  // ==========================================================================

  function openTransparencyModal() {
    if (!imgState.element) {
      showToast('画像を先に読み込んでください。', 'danger');
      return;
    }
    if (imgState.width * imgState.height > MAX_TRANSPARENCY_PIXELS) {
      showToast(`背景透過は ${MAX_TRANSPARENCY_PIXELS.toLocaleString()} 画素までです。縮小してから処理してください。`, 'danger');
      return;
    }

    lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // スポイト状態をリセット
    isPipetteActive = false;
    if (btnTransparencyPicker) btnTransparencyPicker.classList.remove('btn-pipette-active');

    // プレビュー元のCanvasを作成
    previewSourceCanvas = document.createElement('canvas');
    previewSourceCanvas.width = imgState.element.width;
    previewSourceCanvas.height = imgState.element.height;
    const previewSourceCtx = previewSourceCanvas.getContext('2d');
    previewSourceCtx.drawImage(imgState.element, 0, 0);

    // プレビュー表示用Canvasのサイズ設定
    const maxPreviewSize = 380;
    let scale = 1.0;
    if (imgState.width > maxPreviewSize || imgState.height > maxPreviewSize) {
      scale = Math.min(maxPreviewSize / imgState.width, maxPreviewSize / imgState.height);
    }
    
    transparencyPreviewCanvas.width = imgState.width * scale;
    transparencyPreviewCanvas.height = imgState.height * scale;

    // スライス選択状態によるUI変更
    const activeSlice = slices.find(s => s.id === selectedSliceId);
    const rangeRadioSlice = document.querySelector('input[name="transparency-range"][value="slice"]');
    const rangeRadioAll = document.querySelector('input[name="transparency-range"][value="all"]');
    
    if (activeSlice) {
      if (transparencyRangeSliceLabel) transparencyRangeSliceLabel.style.display = 'flex';
      if (transparencySliceNameText) transparencySliceNameText.textContent = `選択中のスライス範囲 (${activeSlice.name})`;
      if (rangeRadioSlice) {
        rangeRadioSlice.disabled = false;
        rangeRadioSlice.checked = true; // デフォルトでスライス選択範囲を優先
      }
    } else {
      if (transparencyRangeSliceLabel) transparencyRangeSliceLabel.style.display = 'none';
      if (rangeRadioAll) rangeRadioAll.checked = true;
      if (rangeRadioSlice) rangeRadioSlice.disabled = true;
    }

    // プレビューのイベント登録（スポイトピッカー用）
    transparencyPreviewCanvas.addEventListener('mousedown', handlePreviewClick);

    // モーダルを表示
    if (transparencyModal) transparencyModal.classList.remove('hidden');
    
    // 初回プレビュー更新
    updateTransparencyPreview();
    if (btnCloseTransparencyModal) btnCloseTransparencyModal.focus();
  }

  function closeTransparencyModal() {
    if (transparencyModal) transparencyModal.classList.add('hidden');
    // リスナー解除
    transparencyPreviewCanvas.removeEventListener('mousedown', handlePreviewClick);
    isPipetteActive = false;
    if (btnTransparencyPicker) btnTransparencyPicker.classList.remove('btn-pipette-active');
    if (lastFocusedElement && document.contains(lastFocusedElement)) {
      lastFocusedElement.focus();
    }
    lastFocusedElement = null;
    autoDetectAfterTransparency = false;
  }

  function togglePipetteMode() {
    isPipetteActive = !isPipetteActive;
    if (btnTransparencyPicker) {
      if (isPipetteActive) {
        btnTransparencyPicker.classList.add('btn-pipette-active');
        showToast('プレビュー画像から透過したい色をクリックしてください。');
      } else {
        btnTransparencyPicker.classList.remove('btn-pipette-active');
      }
    }
  }

  function handlePreviewClick(e) {
    if (!isPipetteActive) return;

    const rect = transparencyPreviewCanvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * transparencyPreviewCanvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * transparencyPreviewCanvas.height;

    const ctx = transparencyPreviewCanvas.getContext('2d');
    const imgData = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1);
    const r = imgData.data[0];
    const g = imgData.data[1];
    const b = imgData.data[2];

    const rgbToHex = (r, g, b) => '#' + [r, g, b].map(x => {
      const hex = x.toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    }).join('');

    const hexColor = rgbToHex(r, g, b);

    if (transparencyColor) {
      transparencyColor.value = hexColor;
      if (transparencyColorPreview) transparencyColorPreview.style.backgroundColor = hexColor;
      if (transparencyColorHex) transparencyColorHex.textContent = hexColor.toUpperCase();
    }

    // スポイトモード終了
    togglePipetteMode();
    updateTransparencyPreview();
  }

  function updateTransparencyPreview() {
    if (!previewSourceCanvas || !transparencyPreviewCanvas) return;

    const previewCtx = transparencyPreviewCanvas.getContext('2d');
    
    // パラメータ取得
    const tolerance = parseInt(transparencyTolerance.value, 10);
    const feather = parseInt(transparencyFeather.value, 10);
    const choke = parseInt(transparencyChoke.value, 10);
    const defringe = transparencyDefringe.checked;
    const color = transparencyColor.value;
    
    const rangeRadioSlice = document.querySelector('input[name="transparency-range"][value="slice"]');
    const applyRange = (rangeRadioSlice && rangeRadioSlice.checked && !rangeRadioSlice.disabled) ? 'slice' : 'all';

    // プレビュー用に縮小されたサイズ
    const w = transparencyPreviewCanvas.width;
    const h = transparencyPreviewCanvas.height;

    // プレビュー描画用テンポラリキャンバス（縮小元データ）
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d');
    
    // 縮小した元画像を描画
    tempCtx.drawImage(previewSourceCanvas, 0, 0, w, h);

    // 選択中スライスのバウンディングボックスをプレビュー座標系にスケール
    let bounds = null;
    if (applyRange === 'slice') {
      const activeSlice = slices.find(s => s.id === selectedSliceId);
      if (activeSlice) {
        const scaleX = w / imgState.width;
        const scaleY = h / imgState.height;
        bounds = {
          x: activeSlice.x * scaleX,
          y: activeSlice.y * scaleY,
          w: activeSlice.w * scaleX,
          h: activeSlice.h * scaleY
        };
      }
    }

    // 透過処理を実行
    processTransparency(tempCtx, previewCtx, w, h, {
      color,
      tolerance,
      feather,
      choke,
      defringe
    }, bounds);
  }

  function applyTransparency() {
    if (!imgState.element || !previewSourceCanvas) return;
    if (imgState.width * imgState.height > MAX_TRANSPARENCY_PIXELS) {
      showToast(`背景透過は ${MAX_TRANSPARENCY_PIXELS.toLocaleString()} 画素までです。縮小してから処理してください。`, 'danger');
      return;
    }

    // パラメータ取得
    const tolerance = parseInt(transparencyTolerance.value, 10);
    const feather = parseInt(transparencyFeather.value, 10);
    const choke = parseInt(transparencyChoke.value, 10);
    const defringe = transparencyDefringe.checked;
    const color = transparencyColor.value;
    
    const rangeRadioSlice = document.querySelector('input[name="transparency-range"][value="slice"]');
    const applyRange = (rangeRadioSlice && rangeRadioSlice.checked && !rangeRadioSlice.disabled) ? 'slice' : 'all';
    const shouldAutoDetect = autoDetectAfterTransparency && applyRange === 'all';
    autoDetectAfterTransparency = false;

    // 履歴保存 (Undo対応)
    saveHistory();

    const targetCtx = imgState.element.getContext('2d');
    const sourceCtx = previewSourceCanvas.getContext('2d');
    const w = imgState.width;
    const h = imgState.height;

    let bounds = null;
    if (applyRange === 'slice') {
      const activeSlice = slices.find(s => s.id === selectedSliceId);
      if (activeSlice) {
        bounds = {
          x: activeSlice.x,
          y: activeSlice.y,
          w: activeSlice.w,
          h: activeSlice.h
        };
      }
    }

    // 高解像度での処理実行
    processTransparency(sourceCtx, targetCtx, w, h, {
      color,
      tolerance,
      feather,
      choke,
      defringe
    }, bounds);

    // キャンバス更新
    renderCanvas();

    // 選択中のスライスプレビューも更新
    if (selectedSliceId !== null) {
      const selectedSlice = slices.find(s => s.id === selectedSliceId);
      if (selectedSlice) {
        renderSlicePreview(selectedSlice);
      }
    }

    closeTransparencyModal();
    if (shouldAutoDetect) {
      detectSlicesAuto(true);
      showToast(
        slices.length > 0
          ? `緑背景を透過し、${slices.length}個のスライスを自動検出しました。`
          : '緑背景を透過しました。自動検出で切り出したい範囲を確認してください。'
      );
    } else {
      showToast('透過処理を適用しました。');
    }
  }

  /**
   * 透過処理のコアピクセル操作アルゴリズム
   */
  function processTransparency(sourceCtx, targetCtx, width, height, params, bounds = null) {
    const srcImgData = sourceCtx.getImageData(0, 0, width, height);
    const tarImgData = targetCtx.createImageData(width, height);
    
    const srcData = srcImgData.data;
    const tarData = tarImgData.data;
    
    const keyColor = params.color;
    const tolerance = params.tolerance;
    const feather = params.feather;
    const choke = params.choke;
    const defringe = params.defringe;
    
    const rKey = parseInt(keyColor.slice(1, 3), 16);
    const gKey = parseInt(keyColor.slice(3, 5), 16);
    const bKey = parseInt(keyColor.slice(5, 7), 16);
    
    const maxDist = Math.sqrt(255 * 255 * 3);
    
    const xMin = bounds ? Math.max(0, Math.floor(bounds.x)) : 0;
    const yMin = bounds ? Math.max(0, Math.floor(bounds.y)) : 0;
    const xMax = bounds ? Math.min(width, Math.ceil(bounds.x + bounds.w)) : width;
    const yMax = bounds ? Math.min(height, Math.ceil(bounds.y + bounds.h)) : height;

    const alphaMap = new Uint8Array(width * height);
    
    // tolerance: 0.0 ~ 1.0 にマップ
    const tolThreshold = tolerance / 100;
    // feather範囲
    const featherRange = Math.max(0.001, (feather * 2) / 100); 

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        
        if (x < xMin || x >= xMax || y < yMin || y >= yMax) {
          tarData[idx] = srcData[idx];
          tarData[idx+1] = srcData[idx+1];
          tarData[idx+2] = srcData[idx+2];
          tarData[idx+3] = srcData[idx+3];
          alphaMap[y * width + x] = srcData[idx+3];
          continue;
        }
        
        const r = srcData[idx];
        const g = srcData[idx+1];
        const b = srcData[idx+2];
        const a = srcData[idx+3];
        
        if (a === 0) {
          alphaMap[y * width + x] = 0;
          continue;
        }
        
        const dist = Math.sqrt((r - rKey) ** 2 + (g - gKey) ** 2 + (b - bKey) ** 2) / maxDist;
        
        let newA = a;
        if (dist <= tolThreshold) {
          newA = 0;
        } else if (dist < tolThreshold + featherRange) {
          const ratio = (dist - tolThreshold) / featherRange;
          newA = Math.round(a * ratio);
        }
        
        alphaMap[y * width + x] = newA;
        tarData[idx] = r;
        tarData[idx+1] = g;
        tarData[idx+2] = b;
      }
    }
    
    // マスク収縮 (Choke)
    let finalAlphaMap = alphaMap;
    if (choke > 0) {
      finalAlphaMap = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          
          if (x < xMin || x >= xMax || y < yMin || y >= yMax) {
            finalAlphaMap[idx] = alphaMap[idx];
            continue;
          }
          
          let minA = alphaMap[idx];
          for (let dy = -choke; dy <= choke; dy++) {
            const ny = y + dy;
            if (ny < yMin || ny >= yMax) continue;
            for (let dx = -choke; dx <= choke; dx++) {
              const nx = x + dx;
              if (nx < xMin || nx >= xMax) continue;
              
              if (dx*dx + dy*dy <= choke*choke) {
                const nIdx = ny * width + nx;
                if (alphaMap[nIdx] < minA) {
                  minA = alphaMap[nIdx];
                }
              }
            }
          }
          finalAlphaMap[idx] = minA;
        }
      }
    }
    
    // フリンジ除去 (De-fringe)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const aIdx = y * width + x;
        const newA = finalAlphaMap[aIdx];
        
        tarData[idx+3] = newA;
        
        if (x < xMin || x >= xMax || y < yMin || y >= yMax) {
          tarData[idx] = srcData[idx];
          tarData[idx+1] = srcData[idx+1];
          tarData[idx+2] = srcData[idx+2];
          tarData[idx+3] = srcData[idx+3];
          continue;
        }
        
        if (defringe && newA > 0 && newA < 255) {
          let sumR = 0, sumG = 0, sumB = 0, count = 0;
          const radius = 2;
          
          for (let dy = -radius; dy <= radius; dy++) {
            const ny = y + dy;
            if (ny < yMin || ny >= yMax) continue;
            for (let dx = -radius; dx <= radius; dx++) {
              const nx = x + dx;
              if (nx < xMin || nx >= xMax) continue;
              
              const nIdx = (ny * width + nx) * 4;
              const nAIdx = ny * width + nx;
              
              if (finalAlphaMap[nAIdx] >= 240) {
                sumR += srcData[nIdx];
                sumG += srcData[nIdx+1];
                sumB += srcData[nIdx+2];
                count++;
              }
            }
          }
          
          if (count > 0) {
            const avgR = sumR / count;
            const avgG = sumG / count;
            const avgB = sumB / count;
            
            const blendRatio = newA / 255;
            tarData[idx] = Math.round(srcData[idx] * blendRatio + avgR * (1 - blendRatio));
            tarData[idx+1] = Math.round(srcData[idx+1] * blendRatio + avgG * (1 - blendRatio));
            tarData[idx+2] = Math.round(srcData[idx+2] * blendRatio + avgB * (1 - blendRatio));
          } else {
            tarData[idx] = srcData[idx];
            tarData[idx+1] = srcData[idx+1];
            tarData[idx+2] = srcData[idx+2];
          }
        } else {
          tarData[idx] = srcData[idx];
          tarData[idx+1] = srcData[idx+1];
          tarData[idx+2] = srcData[idx+2];
        }
      }
    }
    
    targetCtx.putImageData(tarImgData, 0, 0);
  }

  // ==========================================================================
  // キャンバス操作・描画 (Canvas Interaction & Rendering)
  // ==========================================================================
  
  // ズームリセット
  function resetZoomAndPan() {
    if (!imgState.element) return;
    
    // ラッパーサイズに収まるようにデフォルトズームを計算
    const wrapperWidth = canvasWrapper.clientWidth;
    const wrapperHeight = canvasWrapper.clientHeight;
    
    const zoomX = (wrapperWidth - 40) / imgState.width;
    const zoomY = (wrapperHeight - 40) / imgState.height;
    
    // 最大でも等倍 (1.0) に収める
    canvasState.zoom = Math.min(1.0, Math.min(zoomX, zoomY));
    // 極端に小さい画像は等倍にする
    if (canvasState.zoom < 0.25) canvasState.zoom = 0.25;
    if (imgState.width < wrapperWidth && imgState.height < wrapperHeight) {
      canvasState.zoom = 1.0;
    }
    
    canvasState.offsetX = 0;
    canvasState.offsetY = 0;
    
    updateZoomUI();
    applyCanvasTransform();
    renderCanvas();
  }

  function adjustZoom(delta) {
    const newZoom = Math.max(0.1, Math.min(10.0, canvasState.zoom + delta));
    canvasState.zoom = parseFloat(newZoom.toFixed(2));
    canvasState.offsetX = 0;
    canvasState.offsetY = 0;
    updateZoomUI();
    applyCanvasTransform();
    renderCanvas();
  }

  function updateZoomUI() {
    zoomValue.textContent = `${Math.round(canvasState.zoom * 100)}%`;
  }

  function applyCanvasTransform() {
    // CSSの transform で拡大縮小と並行移動を行う
    canvasContainer.style.transform = `translate(${canvasState.offsetX}px, ${canvasState.offsetY}px) scale(${canvasState.zoom})`;
  }

  // キャンバス再描画
  function renderCanvas() {
    if (!imgState.element) return;
    
    // キャンバス自体をクリアして再描画
    mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);

    const drag = canvasState.dragState;
    if (drag.type === 'move-image' || drag.type === 'rotate' || drag.type === 'rotate-ui') {
      // 画像ピクセルの移動・回転中の描画
      // 1. 移動箇所が透明になった背景画像を描画
      mainCtx.drawImage(drag.tempCanvas, 0, 0);
      
      // 2. 移動中のスライス画像を新しい位置に描画
      const sliceIndex = slices.findIndex(s => s.id === selectedSliceId);
      if (sliceIndex !== -1) {
        const slice = slices[sliceIndex];
        const tempSliceCanvas = document.createElement('canvas');
        tempSliceCanvas.width = drag.originalSlice.w;
        tempSliceCanvas.height = drag.originalSlice.h;
        tempSliceCanvas.getContext('2d').putImageData(drag.sliceImageData, 0, 0);
        
        if (slice.rotation && slice.rotation !== 0) {
          mainCtx.save();
          const cx = drag.currentPixelX + drag.originalSlice.w / 2;
          const cy = drag.currentPixelY + drag.originalSlice.h / 2;
          mainCtx.translate(cx, cy);
          mainCtx.rotate(slice.rotation * Math.PI / 180);
          mainCtx.drawImage(tempSliceCanvas, -drag.originalSlice.w / 2, -drag.originalSlice.h / 2);
          mainCtx.restore();
        } else {
          mainCtx.drawImage(tempSliceCanvas, drag.currentPixelX, drag.currentPixelY);
        }
      }
    } else if (drag.wasInMoveImageMode && drag.sliceCanvas && drag.type.startsWith('resize-')) {
      // 画像編集モードのリサイズ中：背景（画像が消えた状態）を描画してから、スケールしたプレビューを半透明で重ねる
      mainCtx.drawImage(drag.tempCanvas, 0, 0);

      // 現在のリサイズ後スライスの位置・サイズを取得
      const sliceIndex = slices.findIndex(s => s.id === selectedSliceId);
      if (sliceIndex !== -1) {
        const slice = slices[sliceIndex];
        const destX = Math.max(0, Math.min(imgState.width, slice.x));
        const destY = Math.max(0, Math.min(imgState.height, slice.y));
        const destW = Math.max(1, Math.min(imgState.width - destX, slice.w));
        const destH = Math.max(1, Math.min(imgState.height - destY, slice.h));

        mainCtx.save();
        mainCtx.globalAlpha = 0.65; // 半透明で表示
        mainCtx.imageSmoothingEnabled = true;
        mainCtx.imageSmoothingQuality = 'high';
        mainCtx.drawImage(
          drag.sliceCanvas,
          0, 0, drag.originalSlice.w, drag.originalSlice.h,
          destX, destY, destW, destH
        );
        mainCtx.restore();
      }
    } else {
      // 通常描画
      mainCtx.drawImage(imgState.element, 0, 0);
    }



    // スライス範囲の描画
    slices.forEach((slice) => {
      const isSelected = slice.id === selectedSliceId;
      drawSliceBox(slice, isSelected);
    });

    // 手動範囲選択のドラッグ中の枠描画
    if (canvasState.isDrawing && activeMode === 'manual') {
      drawDrawingBox();
    }

    // 消しゴム・復元ブラシツールのブラシプレビュー円を描画
    if ((isEraserMode || isRestoreMode) && isMouseInCanvas && !canvasState.isPanning && !isSpacePressed) {
      mainCtx.save();
      mainCtx.beginPath();
      mainCtx.arc(eraserMouseX, eraserMouseY, eraserSize / 2, 0, Math.PI * 2);
      
      if (isRestoreMode) {
        // 復元モードは青色の境界線にする
        mainCtx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
        mainCtx.lineWidth = 2.0 / canvasState.zoom;
      } else {
        // 暗い背景用（白線）
        mainCtx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        mainCtx.lineWidth = 1.5 / canvasState.zoom;
      }
      mainCtx.stroke();
      
      mainCtx.beginPath();
      mainCtx.arc(eraserMouseX, eraserMouseY, eraserSize / 2, 0, Math.PI * 2);
      if (isRestoreMode) {
        mainCtx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
        mainCtx.lineWidth = 0.5 / canvasState.zoom;
      } else {
        // 明るい背景用（細い黒線）
        mainCtx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        mainCtx.lineWidth = 0.5 / canvasState.zoom;
      }
      mainCtx.stroke();
      
      mainCtx.restore();

      // 選択したブラシの簡易アイコンをプレビュー円の少し右上に描画
      const scale = 1 / canvasState.zoom;
      const radius = eraserSize / 2;
      const offset = radius + 12 * scale;
      const iconX = eraserMouseX + offset;
      const iconY = eraserMouseY - offset;

      mainCtx.save();
      mainCtx.translate(iconX, iconY);
      mainCtx.rotate(-45 * Math.PI / 180); // 45度傾ける

      if (isRestoreMode) {
        // 復元ブラシ（筆）
        // 1. 柄の部分（茶色）
        mainCtx.fillStyle = '#8b5a2b';
        mainCtx.fillRect(-2 * scale, 2 * scale, 4 * scale, 12 * scale);
        // 2. 金具部分（グレー）
        mainCtx.fillStyle = '#9ca3af';
        mainCtx.fillRect(-2 * scale, -2 * scale, 4 * scale, 4 * scale);
        // 3. 毛先（青）
        mainCtx.fillStyle = '#3b82f6';
        mainCtx.beginPath();
        mainCtx.moveTo(-2 * scale, -2 * scale);
        mainCtx.lineTo(2 * scale, -2 * scale);
        mainCtx.lineTo(0, -10 * scale);
        mainCtx.closePath();
        mainCtx.fill();

        // 輪郭を描画して視認性を高める
        mainCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        mainCtx.lineWidth = 0.5 * scale;
        mainCtx.strokeRect(-2 * scale, 2 * scale, 4 * scale, 12 * scale);
        mainCtx.strokeRect(-2 * scale, -2 * scale, 4 * scale, 4 * scale);
        mainCtx.beginPath();
        mainCtx.moveTo(-2 * scale, -2 * scale);
        mainCtx.lineTo(2 * scale, -2 * scale);
        mainCtx.lineTo(0, -10 * scale);
        mainCtx.closePath();
        mainCtx.stroke();
      } else {
        // 消しゴム
        // 1. ゴム部分（赤ピンク）
        mainCtx.fillStyle = '#ff8a8a';
        mainCtx.fillRect(-4 * scale, -8 * scale, 8 * scale, 8 * scale);
        // 2. スリーブ（白）
        mainCtx.fillStyle = '#ffffff';
        mainCtx.fillRect(-4 * scale, 0, 8 * scale, 8 * scale);

        // 3. 輪郭と境界線を描画
        mainCtx.strokeStyle = '#374151';
        mainCtx.lineWidth = 1 * scale;
        mainCtx.strokeRect(-4 * scale, -8 * scale, 8 * scale, 16 * scale);

        mainCtx.beginPath();
        mainCtx.moveTo(-4 * scale, 0);
        mainCtx.lineTo(4 * scale, 0);
        mainCtx.strokeStyle = '#374151';
        mainCtx.stroke();
        
        // 白地の部分が見えやすいように、白枠で少しフチ取る（スリーブ用）
        mainCtx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        mainCtx.lineWidth = 0.5 * scale;
        mainCtx.strokeRect(-4.5 * scale, -8.5 * scale, 9 * scale, 17 * scale);
      }
      mainCtx.restore();
    }
  }



  // スライス枠の描画
  function drawSliceBox(slice, isSelected) {
    mainCtx.save();
    
    const cx = slice.x + slice.w / 2;
    const cy = slice.y + slice.h / 2;
    const angle = (slice.rotation || 0) * Math.PI / 180;
    
    mainCtx.translate(cx, cy);
    mainCtx.rotate(angle);
    
    // 枠線の太さをズーム倍率で調整
    const lineWidth = Math.max(1, Math.min(3, 1.5 / canvasState.zoom));
    
    if (isSelected) {
      // 選択中のスライス
      mainCtx.strokeStyle = '#6366f1'; // Indigo-500
      mainCtx.fillStyle = 'rgba(99, 102, 241, 0.15)';
      mainCtx.lineWidth = lineWidth + 1;
    } else {
      // 通常のスライス
      mainCtx.strokeStyle = '#10b981'; // Success (Emerald-500)
      mainCtx.fillStyle = 'rgba(16, 185, 129, 0.05)';
      mainCtx.lineWidth = lineWidth;
    }
    
    // 四角形の描画（中心原点基準）
    const rx = -slice.w / 2;
    const ry = -slice.h / 2;
    mainCtx.fillRect(rx, ry, slice.w, slice.h);
    mainCtx.strokeRect(rx, ry, slice.w, slice.h);
    
    // 角のアンカー描画（選択中の場合のみ）
    if (isSelected) {
      const anchorSize = Math.max(4, 5 / canvasState.zoom);
      mainCtx.fillStyle = '#ffffff';
      mainCtx.strokeStyle = '#4f46e5';
      mainCtx.lineWidth = 1 / canvasState.zoom;
      
      const corners = [
        {x: rx, y: ry},
        {x: rx + slice.w, y: ry},
        {x: rx, y: ry + slice.h},
        {x: rx + slice.w, y: ry + slice.h}
      ];
      
      corners.forEach(corner => {
        mainCtx.beginPath();
        mainCtx.arc(corner.x, corner.y, anchorSize, 0, Math.PI * 2);
        mainCtx.fill();
        mainCtx.stroke();
      });

      // ピクセル移動モード中のみ、回転ハンドルの描画
      if (isMoveImageMode) {
        const handleOffset = Math.max(15, 20 / canvasState.zoom);
        const handleY = ry - handleOffset;
        
        mainCtx.beginPath();
        mainCtx.moveTo(0, ry);
        mainCtx.lineTo(0, handleY);
        mainCtx.strokeStyle = '#4f46e5';
        mainCtx.lineWidth = 1 / canvasState.zoom;
        mainCtx.stroke();
        
        const handleSize = Math.max(5, 6 / canvasState.zoom);
        mainCtx.beginPath();
        mainCtx.arc(0, handleY, handleSize, 0, Math.PI * 2);
        mainCtx.fillStyle = '#3b82f6';
        mainCtx.strokeStyle = '#ffffff';
        mainCtx.lineWidth = 1.5 / canvasState.zoom;
        mainCtx.fill();
        mainCtx.stroke();
      }
    }

    // ラベルの描画
    if (canvasState.showLabels) {
      const baseName = imgState.name || 'sprite';
      const category = activeCategoryName;
      const slicePrefix = category ? `${baseName}_${category}` : baseName;
      const labelText = slice.name || `${slicePrefix}_${slice.id}`;
      mainCtx.font = `${Math.max(10, 11 / canvasState.zoom)}px var(--font-family-sans)`;
      
      const textWidth = mainCtx.measureText(labelText).width;
      const textHeight = Math.max(10, 11 / canvasState.zoom);
      
      const labelX = rx;
      let labelY = ry - 4;
      if (isSelected) {
        // 回転ハンドルと重ならないように、下側に表示する
        labelY = ry + slice.h + textHeight + 4;
      } else {
        if (labelY < textHeight) {
          labelY = ry + textHeight + 2;
        }
      }
      
      // ラベル背景
      mainCtx.fillStyle = isSelected ? '#6366f1' : '#10b981';
      mainCtx.fillRect(labelX, labelY - textHeight, textWidth + 8, textHeight + 4);
      
      // ラベル文字
      mainCtx.fillStyle = '#ffffff';
      mainCtx.fillText(labelText, labelX + 4, labelY - 1);
    }
    
    mainCtx.restore();
  }

  // 手動ドラッグ中の枠描画
  function drawDrawingBox() {
    const x = Math.min(canvasState.drawStartX, canvasState.drawCurrentX);
    const y = Math.min(canvasState.drawStartY, canvasState.drawCurrentY);
    const w = Math.abs(canvasState.drawStartX - canvasState.drawCurrentX);
    const h = Math.abs(canvasState.drawStartY - canvasState.drawCurrentY);
    
    mainCtx.save();
    mainCtx.strokeStyle = '#6366f1';
    mainCtx.fillStyle = 'rgba(99, 102, 241, 0.1)';
    mainCtx.lineWidth = 2 / canvasState.zoom;
    mainCtx.setLineDash([4, 4]);
    
    mainCtx.fillRect(x, y, w, h);
    mainCtx.strokeRect(x, y, w, h);
    
    mainCtx.restore();
  }

  // ==========================================================================
  // キャンバス マウス/タッチ操作イベント (Interaction Logic)
  // ==========================================================================
  
  canvasContainer.addEventListener('mouseenter', () => {
    isMouseInCanvas = true;
    if (isEraserMode || isRestoreMode) {
      renderCanvas();
    }
  });

  canvasContainer.addEventListener('mouseleave', () => {
    isMouseInCanvas = false;
    if (isErasing || isRestoring) {
      isErasing = false;
      isRestoring = false;
      updateSliceList();
      updateCodeOutput();
      if (selectedSliceId !== null) {
        const slice = slices.find(s => s.id === selectedSliceId);
        if (slice) {
          renderSlicePreview(slice);
        }
      }
    }
    renderCanvas();
  });

  // マウスダウン
  canvasContainer.addEventListener('mousedown', (e) => {
    if (!imgState.element) return;

    // クリック開始のスクリーン座標を保存
    canvasState.lastMouseDownX = e.clientX;
    canvasState.lastMouseDownY = e.clientY;

    // キャンバス上の座標を取得
    const rect = mainCanvas.getBoundingClientRect();
    // キャンバス座標系にスケール逆変換
    const clickX = Math.floor((e.clientX - rect.left) / canvasState.zoom);
    const clickY = Math.floor((e.clientY - rect.top) / canvasState.zoom);

    // 選択中のスライスがあれば、アンカー、回転ハンドル、または内側クリックを判定
    let clickedAnchor = 'none';
    let isInsideSlice = false;
    let selectedSlice = null;

    if (selectedSliceId !== null) {
      selectedSlice = slices.find(s => s.id === selectedSliceId);
      if (selectedSlice) {
        const w = selectedSlice.w;
        const h = selectedSlice.h;
        const hitRadius = Math.min(12 / canvasState.zoom, w / 2.5, h / 2.5);

        const dist = (x1, y1, x2, y2) => Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);

        // ローカル座標に変換して判定
        const local = getLocalCoords(selectedSlice, clickX, clickY);
        const rx = local.rx;
        const ry = local.ry;

        if (rx >= -w / 2 && rx <= w / 2 && ry >= -h / 2 && ry <= h / 2) {
          isInsideSlice = true;
        }

        if (isMoveImageMode) {
          // 画像編集モード中は回転ハンドルとリサイズアンカーの両方を判定する
          const handleOffset = Math.max(15, 20 / canvasState.zoom);
          const handleX = 0;
          const handleY = -h / 2 - handleOffset;
          if (dist(rx, ry, handleX, handleY) <= hitRadius) {
            clickedAnchor = 'rotate';
          } else if (dist(rx, ry, -w / 2, -h / 2) <= hitRadius) clickedAnchor = 'resize-tl';
          else if (dist(rx, ry, w / 2, -h / 2) <= hitRadius) clickedAnchor = 'resize-tr';
          else if (dist(rx, ry, -w / 2, h / 2) <= hitRadius) clickedAnchor = 'resize-bl';
          else if (dist(rx, ry, w / 2, h / 2) <= hitRadius) clickedAnchor = 'resize-br';
        } else {
          // 通常時はリサイズアンカーの判定のみ行う
          if (dist(rx, ry, -w / 2, -h / 2) <= hitRadius) clickedAnchor = 'resize-tl';
          else if (dist(rx, ry, w / 2, -h / 2) <= hitRadius) clickedAnchor = 'resize-tr';
          else if (dist(rx, ry, -w / 2, h / 2) <= hitRadius) clickedAnchor = 'resize-bl';
          else if (dist(rx, ry, w / 2, h / 2) <= hitRadius) clickedAnchor = 'resize-br';
        }
      }
    }

    // ホイールクリック、またはShiftキー押しながらのドラッグ、または
    // 「手動モード・消しゴムモード以外の通常ドラッグで、かつスライス操作（変形や移動）ではない場合」は「パン」
    const isSliceInteraction = !isEraserMode && !isRestoreMode && (clickedAnchor !== 'none' || (isInsideSlice && !isMoveImageMode));
    const isPanMode = e.button === 1 || e.shiftKey || isSpacePressed || (!isEraserMode && !isRestoreMode && activeMode !== 'manual' && !isMoveImageMode && !isSliceInteraction);

    if (isPanMode) {
      // パンの開始
      canvasState.isPanning = true;
      canvasState.panStartX = e.clientX - canvasState.offsetX;
      canvasState.panStartY = e.clientY - canvasState.offsetY;
      canvasContainer.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }

    if (isEraserMode) {
      // 消しゴム処理の開始
      isErasing = true;
      lastEraserX = clickX;
      lastEraserY = clickY;
      
      saveHistory(); // 消去前に履歴保存
      erasePixel(clickX, clickY);
      
      e.preventDefault();
      return;
    }

    if (isRestoreMode) {
      // 復元処理の開始
      isRestoring = true;
      lastRestoreX = clickX;
      lastRestoreY = clickY;
      
      saveHistory(); // 復元前に履歴保存
      restorePixel(clickX, clickY);
      
      e.preventDefault();
      return;
    }

    const isImageManipStart = isMoveImageMode && selectedSlice && (isInsideSlice || clickedAnchor === 'rotate') && !clickedAnchor.startsWith('resize-');

    if (isImageManipStart) {
      // 画像ピクセルの移動・回転処理の開始
      canvasState.dragState.type = clickedAnchor === 'rotate' ? 'rotate' : 'move-image';
      canvasState.dragState.startMouseX = clickX;
      canvasState.dragState.startMouseY = clickY;
      canvasState.dragState.originalSlice = { ...selectedSlice };
      canvasState.dragState.currentPixelX = selectedSlice.x;
      canvasState.dragState.currentPixelY = selectedSlice.y;
      
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = imgState.width;
      tempCanvas.height = imgState.height;
      const tempCtx = tempCanvas.getContext('2d');
      tempCtx.drawImage(imgState.element, 0, 0);
      
      // スライス用のキャンバス
      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = selectedSlice.w;
      sliceCanvas.height = selectedSlice.h;
      const sliceCtx = sliceCanvas.getContext('2d');

      // 常に直立枠で切り取る
      const x1 = Math.max(0, Math.min(imgState.width, selectedSlice.x));
      const y1 = Math.max(0, Math.min(imgState.height, selectedSlice.y));
      const x2 = Math.max(0, Math.min(imgState.width, selectedSlice.x + selectedSlice.w));
      const y2 = Math.max(0, Math.min(imgState.height, selectedSlice.y + selectedSlice.h));
      const overlapW = x2 - x1;
      const overlapH = y2 - y1;

      if (overlapW > 0 && overlapH > 0) {
        const srcCtx = imgState.element.getContext('2d');
        const imgData = srcCtx.getImageData(x1, y1, overlapW, overlapH);
        sliceCtx.putImageData(imgData, x1 - selectedSlice.x, y1 - selectedSlice.y);
        tempCtx.clearRect(x1, y1, overlapW, overlapH);
      }
      
      const sliceImageData = sliceCtx.getImageData(0, 0, selectedSlice.w, selectedSlice.h);
      
      canvasState.dragState.tempCanvas = tempCanvas;
      canvasState.dragState.sliceImageData = sliceImageData;

      // 回転用の初期角度と元の角度を保存
      const cx = selectedSlice.x + selectedSlice.w / 2;
      const cy = selectedSlice.y + selectedSlice.h / 2;
      canvasState.dragState.startAngle = Math.atan2(clickY - cy, clickX - cx);
      canvasState.dragState.originalRotation = selectedSlice.rotation || 0;
      
      saveHistory(); // ドラッグ前に履歴保存
      e.preventDefault();
    } else if (clickedAnchor !== 'none' || isInsideSlice) {
      // スライスの移動・リサイズドラッグ開始
      canvasState.dragState.type = clickedAnchor !== 'none' ? clickedAnchor : 'move';
      canvasState.dragState.startMouseX = clickX;
      canvasState.dragState.startMouseY = clickY;
      canvasState.dragState.originalSlice = { ...selectedSlice };
      // 画像編集モード中のリサイズは、事前に画像データを退避しておく
      canvasState.dragState.wasInMoveImageMode = false;
      if (isMoveImageMode && clickedAnchor.startsWith('resize-') && selectedSlice) {
        canvasState.dragState.wasInMoveImageMode = true;
        // バックグラウンドキャンバスを複製して退避
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = imgState.width;
        tempCanvas.height = imgState.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(imgState.element, 0, 0);
        // スライス範囲の画像ピクセルを退避
        const sliceCanvas = document.createElement('canvas');
        sliceCanvas.width = selectedSlice.w;
        sliceCanvas.height = selectedSlice.h;
        const sliceCtx = sliceCanvas.getContext('2d');
        const x1 = Math.max(0, Math.min(imgState.width, selectedSlice.x));
        const y1 = Math.max(0, Math.min(imgState.height, selectedSlice.y));
        const x2 = Math.max(0, Math.min(imgState.width, selectedSlice.x + selectedSlice.w));
        const y2 = Math.max(0, Math.min(imgState.height, selectedSlice.y + selectedSlice.h));
        const overlapW = x2 - x1;
        const overlapH = y2 - y1;
        if (overlapW > 0 && overlapH > 0) {
          const srcCtx = imgState.element.getContext('2d');
          const imgData = srcCtx.getImageData(x1, y1, overlapW, overlapH);
          sliceCtx.putImageData(imgData, x1 - selectedSlice.x, y1 - selectedSlice.y);
          // 退避キャンバスからは元の範囲をクリア
          tempCtx.clearRect(x1, y1, overlapW, overlapH);
        }
        canvasState.dragState.tempCanvas = tempCanvas;
        canvasState.dragState.sliceCanvas = sliceCanvas;
      }
      // ドラッグ前に状態を履歴に保存（元に戻せるように）
      saveHistory();
      e.preventDefault();
    } else if (activeMode === 'manual' && !isMoveImageMode) {
      // 新規スライス範囲選択 of manual mode
      canvasState.isDrawing = true;
      canvasState.drawStartX = Math.max(0, Math.min(imgState.width, clickX));
      canvasState.drawStartY = Math.max(0, Math.min(imgState.height, clickY));
      canvasState.drawCurrentX = canvasState.drawStartX;
      canvasState.drawCurrentY = canvasState.drawStartY;
    }
  });

  // マウスムーブ
  window.addEventListener('mousemove', (e) => {
    if (!imgState.element) return;

    const rect = mainCanvas.getBoundingClientRect();
    const currentMouseX = Math.floor((e.clientX - rect.left) / canvasState.zoom);
    const currentMouseY = Math.floor((e.clientY - rect.top) / canvasState.zoom);

    // 消しゴム・復元ブラシツール時のマウス座標の更新とプレビュー円描画
    if ((isEraserMode || isRestoreMode) && !isSpacePressed) {
      eraserMouseX = currentMouseX;
      eraserMouseY = currentMouseY;
      
      // ドラッグしていない時も、ブラシの円プレビューを表示するために再描画
      if (!isErasing && !isRestoring) {
        renderCanvas();
      }
    }

    if (canvasState.isPanning) {
      // パン処理
      canvasState.offsetX = e.clientX - canvasState.panStartX;
      canvasState.offsetY = e.clientY - canvasState.panStartY;
      applyCanvasTransform();
    } 
    else if (isEraserMode && isErasing) {
      // 消しゴムでのドラッグ消去処理
      erasePixelLine(lastEraserX, lastEraserY, currentMouseX, currentMouseY);
      lastEraserX = currentMouseX;
      lastEraserY = currentMouseY;
    }
    else if (isRestoreMode && isRestoring) {
      // 復元ブラシでのドラッグ処理
      restorePixelLine(lastRestoreX, lastRestoreY, currentMouseX, currentMouseY);
      lastRestoreX = currentMouseX;
      lastRestoreY = currentMouseY;
    }
    else if (canvasState.isDrawing) {
      // 新規範囲描画処理
      canvasState.drawCurrentX = Math.max(0, Math.min(imgState.width, currentMouseX));
      canvasState.drawCurrentY = Math.max(0, Math.min(imgState.height, currentMouseY));
      renderCanvas();
    }
    else if (canvasState.dragState.type !== 'none') {
      // スライスの移動・リサイズ処理
      const drag = canvasState.dragState;
      const original = drag.originalSlice;
      const dx = currentMouseX - drag.startMouseX;
      const dy = currentMouseY - drag.startMouseY;

      const sliceIndex = slices.findIndex(s => s.id === selectedSliceId);
      if (sliceIndex !== -1) {
        let updated = { ...slices[sliceIndex] };

        if (drag.type === 'move-image') {
          // 画像ピクセルの移動処理（スライス枠も同時に移動）
          let newX = original.x + dx;
          let newY = original.y + dy;

          // クランプ範囲を緩和（画像の外側1スライス分まで許容）
          newX = Math.max(-original.w, Math.min(imgState.width, newX));
          newY = Math.max(-original.h, Math.min(imgState.height, newY));

          drag.currentPixelX = newX;
          drag.currentPixelY = newY;
          
          // スライス枠の座標も更新して追従させる
          slices[sliceIndex].x = newX;
          slices[sliceIndex].y = newY;

          // 詳細パネルの座標とスライスリストの表示を同期
          if (sliceXInput) sliceXInput.value = newX;
          if (sliceYInput) sliceYInput.value = newY;
          
          const detailsEl = document.querySelector(`.slice-item[data-id="${updated.id}"] .slice-item-details`);
          if (detailsEl) {
            detailsEl.textContent = `X: ${newX} Y: ${newY} (${updated.w}x${updated.h})`;
          }
          
          renderCanvas();
          return; // slicesの更新をスキップ
        }
        else if (drag.type === 'move') {
          // 移動処理
          let newX = original.x + dx;
          let newY = original.y + dy;

          // 画像境界にクランプ
          newX = Math.max(0, Math.min(imgState.width - original.w, newX));
          newY = Math.max(0, Math.min(imgState.height - original.h, newY));

          updated.x = newX;
          updated.y = newY;
        } 
        else if (drag.type === 'rotate') {
          // 回転処理
          const cx = original.x + original.w / 2;
          const cy = original.y + original.h / 2;
          const currentAngle = Math.atan2(currentMouseY - cy, currentMouseX - cx);
          let angleDiff = (currentAngle - drag.startAngle) * 180 / Math.PI;
          let newRotation = drag.originalRotation + angleDiff;

          while (newRotation > 180) newRotation -= 360;
          while (newRotation < -180) newRotation += 360;
          newRotation = Math.round(newRotation);

          updated.rotation = newRotation;

          if (sliceRotationInput) sliceRotationInput.value = newRotation;
          if (sliceRotationNumInput) sliceRotationNumInput.value = newRotation;
        }
        else {
          // リサイズ処理（対角固定の回転対応リサイズアルゴリズム）
          const minW = 4;
          const minH = 4;
          const dir = drag.type.replace('resize-', '');
          const angle = (original.rotation || 0) * Math.PI / 180;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);

          const cx = original.x + original.w / 2;
          const cy = original.y + original.h / 2;

          let fx = 0, fy = 0;
          if (dir === 'tl') { fx = original.w / 2; fy = original.h / 2; }
          else if (dir === 'tr') { fx = -original.w / 2; fy = original.h / 2; }
          else if (dir === 'bl') { fx = original.w / 2; fy = -original.h / 2; }
          else if (dir === 'br') { fx = -original.w / 2; fy = -original.h / 2; }

          const gfx = cx + fx * cos - fy * sin;
          const gfy = cy + fx * sin + fy * cos;

          const mdx = currentMouseX - gfx;
          const mdy = currentMouseY - gfy;
          const rx = mdx * cos + mdy * sin;
          const ry = -mdx * sin + mdy * cos;

          let w = original.w;
          let h = original.h;
          if (dir === 'tl') { w = -rx; h = -ry; }
          else if (dir === 'tr') { w = rx; h = -ry; }
          else if (dir === 'bl') { w = -rx; h = ry; }
          else if (dir === 'br') { w = rx; h = ry; }

          // Shiftキーを押しながらのリサイズは元のアスペクト比を保持する
          if (e.shiftKey && original.w > 0 && original.h > 0) {
            const aspectRatio = original.w / original.h;
            // wとhそれぞれの変化率を比較し、より大きく動いた方を基準にする
            const wRatio = w / original.w;
            const hRatio = h / original.h;
            if (Math.abs(wRatio - 1) >= Math.abs(hRatio - 1)) {
              h = w / aspectRatio;
            } else {
              w = h * aspectRatio;
            }
          }

          w = Math.max(minW, w);
          h = Math.max(minH, h);

          // minW/minH クランプ後も等比を維持する
          if (e.shiftKey && original.w > 0 && original.h > 0) {
            const aspectRatio = original.w / original.h;
            if (w === minW) h = minW / aspectRatio;
            if (h === minH) w = minH * aspectRatio;
          }

          let rx_new = rx;
          let ry_new = ry;
          if (dir === 'tl') { rx_new = -w; ry_new = -h; }
          else if (dir === 'tr') { rx_new = w; ry_new = -h; }
          else if (dir === 'bl') { rx_new = -w; ry_new = h; }
          else if (dir === 'br') { rx_new = w; ry_new = h; }

          const cx_new = gfx + (rx_new / 2) * cos - (ry_new / 2) * sin;
          const cy_new = gfy + (rx_new / 2) * sin + (ry_new / 2) * cos;

          updated.w = Math.round(w);
          updated.h = Math.round(h);
          updated.x = Math.round(cx_new - updated.w / 2);
          updated.y = Math.round(cy_new - updated.h / 2);
        }

        slices[sliceIndex] = updated;

        // リスト表示上の詳細テキスト更新
        const detailsEl = document.querySelector(`.slice-item[data-id="${updated.id}"] .slice-item-details`);
        if (detailsEl) {
          const rotText = updated.rotation ? ` R: ${updated.rotation}°` : '';
          detailsEl.textContent = `X: ${updated.x} Y: ${updated.y} (${updated.w}x${updated.h})${rotText}`;
        }

        // 詳細パネルの座標入力欄の値を同期
        if (sliceXInput) sliceXInput.value = updated.x;
        if (sliceYInput) sliceYInput.value = updated.y;
        if (sliceWInput) sliceWInput.value = updated.w;
        if (sliceHInput) sliceHInput.value = updated.h;

        renderSlicePreview(updated);
        renderCanvas();
        updateCodeOutput();
      }
    }
    else {
      // ドラッグ中でない場合のマウスカーソルのホバー形状更新
      updateMouseCursor(currentMouseX, currentMouseY);
    }
  });

  // マウスアップ
  window.addEventListener('mouseup', (e) => {
    if (canvasState.isPanning) {
      canvasState.isPanning = false;
      canvasContainer.style.cursor = (isEraserMode || isRestoreMode) ? 'none' : (activeMode === 'manual' ? 'crosshair' : 'grab');
    } 
    else if (isEraserMode && isErasing) {
      isErasing = false;
      
      // ドラッグ完了後にサムネイルリストやコード出力を最終同期
      updateSliceList();
      updateCodeOutput();
      
      // 選択されているスライスのプレビューも更新
      if (selectedSliceId !== null) {
        const slice = slices.find(s => s.id === selectedSliceId);
        if (slice) {
          renderSlicePreview(slice);
        }
      }
    }
    else if (isRestoreMode && isRestoring) {
      isRestoring = false;
      
      // ドラッグ完了後にサムネイルリストやコード出力を最終同期
      updateSliceList();
      updateCodeOutput();
      
      // 選択されているスライスのプレビューも更新
      if (selectedSliceId !== null) {
        const slice = slices.find(s => s.id === selectedSliceId);
        if (slice) {
          renderSlicePreview(slice);
        }
      }
    }
    else if (canvasState.dragState.type !== 'none') {
      const drag = canvasState.dragState;
      try {
        if (drag.type === 'move-image' || drag.type === 'rotate') {
          const sliceIndex = slices.findIndex(s => s.id === selectedSliceId);
          if (sliceIndex !== -1) {
            const slice = slices[sliceIndex];
            
            // 1. 退避した背景画像に対して、移動・回転したピクセルデータを新しい位置に上書き描画
            const finalCtx = drag.tempCanvas.getContext('2d');
            const tempSliceCanvas = document.createElement('canvas');
            tempSliceCanvas.width = drag.originalSlice.w;
            tempSliceCanvas.height = drag.originalSlice.h;
            tempSliceCanvas.getContext('2d').putImageData(drag.sliceImageData, 0, 0);
            
            if (slice.rotation && slice.rotation !== 0) {
              finalCtx.save();
              const cx = drag.currentPixelX + drag.originalSlice.w / 2;
              const cy = drag.currentPixelY + drag.originalSlice.h / 2;
              finalCtx.translate(cx, cy);
              finalCtx.rotate(slice.rotation * Math.PI / 180);
              finalCtx.drawImage(tempSliceCanvas, -drag.originalSlice.w / 2, -drag.originalSlice.h / 2);
              finalCtx.restore();
            } else {
              finalCtx.drawImage(tempSliceCanvas, drag.currentPixelX, drag.currentPixelY);
            }
            
            // 2. 元の画像データを新しいキャンバスで差し替える（同期更新）
            imgState.element = drag.tempCanvas;
            imgState.width = drag.tempCanvas.width;
            imgState.height = drag.tempCanvas.height;
            
            // スライスの座標を最終確定
            slice.x = drag.currentPixelX;
            slice.y = drag.currentPixelY;
            
            // スライス枠自体の回転パラメータを同期する
            if (sliceRotationInput) sliceRotationInput.value = slice.rotation || 0;
            if (sliceRotationNumInput) sliceRotationNumInput.value = slice.rotation || 0;
            
            updateSliceList();
            renderCanvas();
            updateCodeOutput();
            if (selectedSliceId !== null) {
              const currentSlice = slices.find(s => s.id === selectedSliceId);
              if (currentSlice) {
                renderSlicePreview(currentSlice);
              }
            }
            showToast('画像ピクセルを変形・適用しました。');
          }
        } else if (drag.wasInMoveImageMode && drag.type.startsWith('resize-')) {
          // 画像編集モード中のリサイズ確定：退避した画像を新しいサイズに拡縮して元キャンバスへ書き込む
          const sliceIndex = slices.findIndex(s => s.id === selectedSliceId);
          if (sliceIndex !== -1 && drag.tempCanvas && drag.sliceCanvas) {
            const slice = slices[sliceIndex];
            const finalCtx = drag.tempCanvas.getContext('2d');

            // 新しいスライスサイズに画像をスケールして描画
            const destX = Math.max(0, Math.min(imgState.width, slice.x));
            const destY = Math.max(0, Math.min(imgState.height, slice.y));
            const destW = Math.max(0, Math.min(imgState.width - destX, slice.w));
            const destH = Math.max(0, Math.min(imgState.height - destY, slice.h));

            if (destW > 0 && destH > 0) {
              finalCtx.imageSmoothingEnabled = true;
              finalCtx.imageSmoothingQuality = 'high';
              finalCtx.drawImage(
                drag.sliceCanvas,
                0, 0, drag.originalSlice.w, drag.originalSlice.h,
                destX, destY, destW, destH
              );
            }

            // 元の画像を差し替え
            imgState.element = drag.tempCanvas;
            imgState.width = drag.tempCanvas.width;
            imgState.height = drag.tempCanvas.height;

            updateSliceList();
            renderCanvas();
            updateCodeOutput();
            if (selectedSliceId !== null) {
              const currentSlice = slices.find(s => s.id === selectedSliceId);
              if (currentSlice) renderSlicePreview(currentSlice);
            }
            showToast('画像ごとリサイズしました。');
          }
        }
      } catch (err) {
        console.error(err);
        showToast('画像編集の適用中にエラーが発生しました。', 'danger');
      } finally {
        canvasState.dragState.type = 'none';
        canvasState.dragState.originalSlice = null;
        canvasState.dragState.tempCanvas = null;
        canvasState.dragState.sliceImageData = null;
        canvasState.dragState.sliceCanvas = null;
        canvasState.dragState.wasInMoveImageMode = false;
        
        // リスト全体の再描画（サムネイルなども同期）
        // ※画像編集モードは自動解除せず、スライス外クリック時に解除する
        updateSliceList();
      }
    }
    else if (canvasState.isDrawing && imgState.element) {
      canvasState.isDrawing = false;
      
      const x = Math.min(canvasState.drawStartX, canvasState.drawCurrentX);
      const y = Math.min(canvasState.drawStartY, canvasState.drawCurrentY);
      const w = Math.abs(canvasState.drawStartX - canvasState.drawCurrentX);
      const h = Math.abs(canvasState.drawStartY - canvasState.drawCurrentY);

      // 一定以上の大きさのみスライスとして追加（誤クリックによる点状スライスを防ぐ）
      if (w >= 3 && h >= 3) {
        saveHistory(); // 追加前に履歴保存
        const id = nextSliceId++;
        const baseName = imgState.name || 'sprite';
        const category = activeCategoryName;
        const slicePrefix = category ? `${baseName}_${category}` : baseName;
        const newSlice = {
          id,
          name: getUniqueSliceName(`${slicePrefix}_${id}`, getUsedSliceNames(), `sprite_${id}`),
          x, y, w, h,
          rotation: 0
        };
        slices.push(newSlice);
        selectedSliceId = id;
        
        updateSliceList();
        showSelectionDetail(newSlice, false);
        updateCodeOutput();
        btnExportZip.disabled = false;
      }
      renderCanvas();
    }
  });

  // 座標 (px, py) をスライス (slice) の中心を基準に逆回転投影したローカル座標を返す
  function getLocalCoords(slice, px, py) {
    const cx = slice.x + slice.w / 2;
    const cy = slice.y + slice.h / 2;
    const angle = (slice.rotation || 0) * Math.PI / 180;
    const dx = px - cx;
    const dy = py - cy;
    const rx = dx * Math.cos(-angle) - dy * Math.sin(-angle);
    const ry = dx * Math.sin(-angle) + dy * Math.cos(-angle);
    return { rx, ry };
  }

  // 点 (px, py) がスライス内にあるか判定
  function isPointInSlice(slice, px, py) {
    return px >= slice.x && px <= slice.x + slice.w && py >= slice.y && py <= slice.y + slice.h;
  }

  // マウスカーソル形状更新ヘルパー
  function updateMouseCursor(mouseX, mouseY) {
    if (isEraserMode || isRestoreMode) {
      if (canvasContainer) canvasContainer.style.cursor = 'none';
      return;
    }

    if (selectedSliceId === null || !imgState.element) {
      canvasContainer.style.cursor = activeMode === 'manual' ? 'crosshair' : 'grab';
      return;
    }

    const selectedSlice = slices.find(s => s.id === selectedSliceId);
    if (!selectedSlice) {
      canvasContainer.style.cursor = activeMode === 'manual' ? 'crosshair' : 'grab';
      return;
    }

    const w = selectedSlice.w;
    const h = selectedSlice.h;
    const hitRadius = Math.min(12 / canvasState.zoom, w / 2.5, h / 2.5);

    // ローカル座標に変換
    const local = getLocalCoords(selectedSlice, mouseX, mouseY);
    const rx = local.rx;
    const ry = local.ry;

    const dist = (x1, y1, x2, y2) => Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);

    if (isMoveImageMode) {
      const handleOffset = Math.max(15, 20 / canvasState.zoom);
      const handleX = 0;
      const handleY = -h / 2 - handleOffset;
      if (dist(rx, ry, handleX, handleY) <= hitRadius) {
        canvasContainer.style.cursor = 'crosshair';
        return;
      }
    }

    if (dist(rx, ry, -w / 2, -h / 2) <= hitRadius) {
      canvasContainer.style.cursor = 'nwse-resize';
    } else if (dist(rx, ry, w / 2, -h / 2) <= hitRadius) {
      canvasContainer.style.cursor = 'nesw-resize';
    } else if (dist(rx, ry, -w / 2, h / 2) <= hitRadius) {
      canvasContainer.style.cursor = 'nesw-resize';
    } else if (dist(rx, ry, w / 2, h / 2) <= hitRadius) {
      canvasContainer.style.cursor = 'nwse-resize';
    } else if (rx >= -w / 2 && rx <= w / 2 && ry >= -h / 2 && ry <= h / 2) {
      canvasContainer.style.cursor = 'move';
    } else {
      canvasContainer.style.cursor = activeMode === 'manual' ? 'crosshair' : 'grab';
    }
  }

  // キャンバスクリック（スライス選択）
  canvasContainer.addEventListener('click', (e) => {
    // ドラッグやパンが行われなかったクリックの場合のみ選択処理
    if (canvasState.isDrawing || canvasState.isPanning || !imgState.element) return;
    
    // マウスダウン位置からの移動距離を計算し、ドラッグされた場合は無視
    const moveDistance = Math.sqrt(
      Math.pow(e.clientX - canvasState.lastMouseDownX, 2) +
      Math.pow(e.clientY - canvasState.lastMouseDownY, 2)
    );
    if (moveDistance > 5) return;
    
    // スペースキーが押されている場合はパン用のクリックとして無視
    if (e.shiftKey) return;

    // 手動モードでドラッグで枠を作成した場合もクリック処理は行わない
    const rect = mainCanvas.getBoundingClientRect();
    const clickX = Math.floor((e.clientX - rect.left) / canvasState.zoom);
    const clickY = Math.floor((e.clientY - rect.top) / canvasState.zoom);

    // クリック地点を含むスライスをすべて取得
    const clickedSlices = slices.filter(slice => isPointInSlice(slice, clickX, clickY));

    let foundSlice = null;
    if (clickedSlices.length > 0) {
      // 1. 現在選択されていないスライスの中から、最も面積の小さいスライスを探す
      const unselectedSlices = clickedSlices.filter(s => s.id !== selectedSliceId);
      if (unselectedSlices.length > 0) {
        let minArea = Infinity;
        unselectedSlices.forEach(slice => {
          const area = slice.w * slice.h;
          if (area < minArea) {
            minArea = area;
            foundSlice = slice;
          }
        });
      } else {
        // 2. 未選択のスライスがなければ、現在選択中のスライスの中から最も面積の小さいものを選ぶ
        let minArea = Infinity;
        clickedSlices.forEach(slice => {
          const area = slice.w * slice.h;
          if (area < minArea) {
            minArea = area;
            foundSlice = slice;
          }
        });
      }
    }

    if (foundSlice) {
      // 別のスライスをクリックしたときは画像編集モードを解除
      if (isMoveImageMode && foundSlice.id !== selectedSliceId) {
        isMoveImageMode = false;
        updateMoveImageButton();
      }
      selectedSliceId = foundSlice.id;
      showSelectionDetail(foundSlice);
      
      // リスト内の要素へスクロール
      const listEl = document.querySelector(`.slice-item[data-id="${foundSlice.id}"]`);
      if (listEl) {
        listEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } else {
      // スライス外をクリックした場合は画像編集モードを解除
      if (isMoveImageMode) {
        isMoveImageMode = false;
        updateMoveImageButton();
      }
      // 手動モードのみ選択解除
      if (activeMode === 'manual') {
        selectedSliceId = null;
        hideSelectionDetail();
      }
    }
    renderCanvas();
  });

  // マウスホイールでのズームイン・アウト
  canvasWrapper.addEventListener('wheel', (e) => {
    if (!imgState.element) return;
    e.preventDefault();

    // ズーム比率の増減
    const zoomFactor = 1.1;
    let nextZoom = canvasState.zoom;
    if (e.deltaY < 0) {
      nextZoom = Math.min(10.0, canvasState.zoom * zoomFactor);
    } else {
      nextZoom = Math.max(0.1, canvasState.zoom / zoomFactor);
    }

    nextZoom = parseFloat(nextZoom.toFixed(2));
    
    // 常に画像が画面の中央に来るようにオフセットをリセット
    canvasState.offsetX = 0;
    canvasState.offsetY = 0;

    canvasState.zoom = nextZoom;

    updateZoomUI();
    applyCanvasTransform();
    renderCanvas();
  }, { passive: false });

  // ==========================================================================
  // スライス切り分けアルゴリズム (Slicing Algorithms)
  // ==========================================================================

  // 1. 自動検出 (Connected Component Labeling based on BFS)
  function detectSlicesAuto(isInitialLoad = false) {
    if (!imgState.element) return;

    const width = imgState.width;
    const height = imgState.height;
    const pixelCount = width * height;
    if (pixelCount > MAX_AUTO_DETECT_PIXELS) {
      showToast(`自動検出は ${MAX_AUTO_DETECT_PIXELS.toLocaleString()} 画素までです。手動範囲選択をご利用ください。`, 'danger');
      return;
    }

    // トランスルーセントまたは不透明ピクセルを検出するために一時キャンバスを利用
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(imgState.element, 0, 0);

    let imgData;
    try {
      imgData = tempCtx.getImageData(0, 0, width, height);
    } catch (e) {
      console.error('Canvasのピクセルデータ取得に失敗しました (CORS制限の可能性があります):', e);
      showToast('ブラウザのセキュリティ制限により自動検出を実行できません。', 'danger');
      return;
    }
    const pixels = imgData.data;

    const tolerance = Math.max(0, Math.min(255, parseInt(toleranceInput.value, 10) || 0));
    const minSize = Math.max(1, parseInt(minSizeInput.value, 10) || 1);

    // BFS用の連続メモリ。配列/オブジェクトをピクセルごとに作らず大画像での負荷を抑える。
    const visited = new Uint8Array(pixelCount);
    const queue = new Int32Array(pixelCount);
    const detectedSlices = [];

    // ピクセル走査
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        
        // すでに探索済みならスキップ
        if (visited[idx] === 1) continue;

        // アルファ値 (A) を取得 (R, G, B, A の順)
        const alpha = pixels[idx * 4 + 3];

        if (alpha > tolerance) {
          // 不透明なピクセルを発見。ここからBFSで連結成分を走査
          let minX = x;
          let maxX = x;
          let minY = y;
          let maxY = y;

          // キューを使用したBFS (再帰によるスタックオーバーフローを防ぐ)
          visited[idx] = 1;
          let qHead = 0;
          let qTail = 0;
          queue[qTail++] = idx;
          while (qHead < qTail) {
            const curIdx = queue[qHead++];
            const curX = curIdx % width;
            const curY = Math.floor(curIdx / width);

            // バウンディングボックスの更新
            if (curX < minX) minX = curX;
            if (curX > maxX) maxX = curX;
            if (curY < minY) minY = curY;
            if (curY > maxY) maxY = curY;

            // 隣接4ピクセルを走査 (上下左右)。一時配列を作らない。
            let nIdx;
            if (curX + 1 < width) {
              nIdx = curIdx + 1;
              if (visited[nIdx] === 0) {
                visited[nIdx] = 1;
                if (pixels[nIdx * 4 + 3] > tolerance) queue[qTail++] = nIdx;
              }
            }
            if (curX > 0) {
              nIdx = curIdx - 1;
              if (visited[nIdx] === 0) {
                visited[nIdx] = 1;
                if (pixels[nIdx * 4 + 3] > tolerance) queue[qTail++] = nIdx;
              }
            }
            if (curY + 1 < height) {
              nIdx = curIdx + width;
              if (visited[nIdx] === 0) {
                visited[nIdx] = 1;
                if (pixels[nIdx * 4 + 3] > tolerance) queue[qTail++] = nIdx;
              }
            }
            if (curY > 0) {
              nIdx = curIdx - width;
              if (visited[nIdx] === 0) {
                visited[nIdx] = 1;
                if (pixels[nIdx * 4 + 3] > tolerance) queue[qTail++] = nIdx;
              }
            }
          }

          // 矩形の幅・高さを決定
          const w = maxX - minX + 1;
          const h = maxY - minY + 1;

          // 最小ノイズフィルタリング
          if (w >= minSize && h >= minSize) {
            if (detectedSlices.length >= MAX_DETECTED_SLICES) {
              showToast(`検出できるスライス数は ${MAX_DETECTED_SLICES.toLocaleString()} 個までです。最小サイズを大きくしてください。`, 'danger');
              return;
            }
            detectedSlices.push({ x: minX, y: minY, w, h });
          }
        } else {
          visited[idx] = 1;
        }
      }
    }

    // 自動検出結果が0個だった場合
    if (detectedSlices.length === 0) {
      if (!isInitialLoad) {
        showToast('スライスが検出されませんでした。閾値を下げてみてください。', 'danger');
      }
      return;
    }

    // 検出スライスをソート (Y座標順、次にX座標順にするとリストが見やすくなります)
    detectedSlices.sort((a, b) => {
      if (Math.abs(a.y - b.y) < 5) return a.x - b.x; // 同じ行付近ならX座標順
      return a.y - b.y;
    });

    if (!isInitialLoad) {
      saveHistory(); // 自動検出前に履歴保存
    }

    // IDと名前を割り当て
    const baseName = imgState.name || 'sprite';
    const category = activeCategoryName;
    const slicePrefix = category ? `${baseName}_${category}` : baseName;
    const usedNames = new Set();
    slices = detectedSlices.map((s, index) => {
      const id = index + 1;
      return {
        id,
        name: getUniqueSliceName(`${slicePrefix}_${id}`, usedNames, `sprite_${id}`),
        x: s.x,
        y: s.y,
        w: s.w,
        h: s.h,
        rotation: 0
      };
    });

    nextSliceId = slices.length + 1;
    selectedSliceId = slices.length > 0 ? slices[0].id : null;

    updateSliceList();
    if (slices.length > 0) {
      showSelectionDetail(slices[0], false);
      btnExportZip.disabled = false;
    } else {
      hideSelectionDetail();
      btnExportZip.disabled = true;
    }
    
    renderCanvas();
    updateCodeOutput();
    
    if (!isInitialLoad) {
      showToast(`${slices.length}個のスライスを自動検出しました。`);
    }
  }



  // ==========================================================================
  // スライス詳細 & リスト更新 (Detail Panels & List Rendering)
  // ==========================================================================

  /**
   * 選択されたスライスの詳細情報を表示し、必要に応じて自動命名を行う
   * @param {Object} slice - 対象のスライスオブジェクト
   * @param {boolean} applyAutoRename - 自動命名を適用するかどうか
   */
  function showSelectionDetail(slice, applyAutoRename = true) {
    selectedSliceId = slice.id;
    selectionDetailPanel.classList.remove('hidden');

    // アクティブなカテゴリーが設定されている場合、自動命名を適用
    if (applyAutoRename && activeCategoryName) {
      const baseName = imgState.name || 'sprite';
      const currentCounter = categoryCounters[activeCategoryName] || 1;
      const autoName = getUniqueSliceName(
        `${baseName}_${activeCategoryName}_${currentCounter}`,
        getUsedSliceNames(slice.id),
        `sprite_${slice.id}`
      );

      if (slice.name !== autoName) {
        saveHistory(); // 変更前に履歴保存
        slice.name = autoName;
        categoryCounters[activeCategoryName] = currentCounter + 1;
        showToast(`${slice.name} に自動変換しました。`);
        updateSliceList();
        renderCanvas();
        updateCodeOutput();
      }
    }
    
    sliceNameInput.value = slice.name;
    if (sliceXInput) sliceXInput.value = slice.x;
    if (sliceYInput) sliceYInput.value = slice.y;
    if (sliceWInput) sliceWInput.value = slice.w;
    if (sliceHInput) sliceHInput.value = slice.h;

    if (sliceRotationInput) sliceRotationInput.value = slice.rotation || 0;
    if (sliceRotationNumInput) sliceRotationNumInput.value = slice.rotation || 0;

    // リストのアイテムをアクティブにする
    document.querySelectorAll('.slice-item').forEach(el => {
      el.classList.remove('active');
    });
    const activeItem = document.querySelector(`.slice-item[data-id="${slice.id}"]`);
    if (activeItem) {
      activeItem.classList.add('active');
    }

    renderSlicePreview(slice);
    updateShortcutHints();
  }

  function hideSelectionDetail() {
    selectionDetailPanel.classList.add('hidden');
    selectedSliceId = null;
    isMoveImageMode = false;
    updateMoveImageButton();
    
    document.querySelectorAll('.slice-item').forEach(el => {
      el.classList.remove('active');
    });
    updateShortcutHints();
  }

  /**
   * スライス範囲の画像を安全に（はみ出しによる IndexSizeError を防いで）描画する
   * @param {CanvasRenderingContext2D} destCtx - 描画先のコンテキスト
   * @param {Object} slice - 対象のスライス
   * @param {number} destX - 描画先X座標（通常は0）
   * @param {number} destY - 描画先Y座標（通常は0）
   * @param {number} destW - 描画先幅（通常は slice.w）
   * @param {number} destH - 描画先高さ（通常は slice.h）
   */
  function drawSliceImageSafely(destCtx, slice, destX = 0, destY = 0, destW = slice.w, destH = slice.h) {
    if (!imgState.element) return;

    destCtx.save();

    const scaleX = destW / slice.w;
    const scaleY = destH / slice.h;

    if (slice.rotation && slice.rotation !== 0) {
      const angleRad = slice.rotation * Math.PI / 180;
      const destCenterX = destX + destW / 2;
      const destCenterY = destY + destH / 2;
      
      destCtx.translate(destCenterX, destCenterY);
      destCtx.rotate(-angleRad);
      
      destCtx.drawImage(
        imgState.element,
        slice.x, slice.y, slice.w, slice.h,
        -destW / 2, -destH / 2, destW, destH
      );
    } else {
      const x1 = Math.max(0, Math.min(imgState.width, slice.x));
      const y1 = Math.max(0, Math.min(imgState.height, slice.y));
      const x2 = Math.max(0, Math.min(imgState.width, slice.x + slice.w));
      const y2 = Math.max(0, Math.min(imgState.height, slice.y + slice.h));
      const overlapW = x2 - x1;
      const overlapH = y2 - y1;

      if (overlapW > 0 && overlapH > 0) {
        const relX = x1 - slice.x;
        const relY = y1 - slice.y;

        const dx = destX + relX * scaleX;
        const dy = destY + relY * scaleY;
        const dw = overlapW * scaleX;
        const dh = overlapH * scaleY;

        destCtx.drawImage(
          imgState.element,
          x1, y1, overlapW, overlapH,
          dx, dy, dw, dh
        );
      }
    }

    destCtx.restore();
  }

  // スライスのプレビューキャンバス描画
  function renderSlicePreview(slice) {
    const ctx = slicePreviewCanvas.getContext('2d');
    ctx.clearRect(0, 0, slicePreviewCanvas.width, slicePreviewCanvas.height);
    
    if (!imgState.element) return;

    // 比率を保ってプレビュー内にフィットさせる
    const maxDimension = 100;
    let dw = slice.w;
    let dh = slice.h;
    
    if (slice.w > maxDimension || slice.h > maxDimension) {
      const ratio = Math.min(maxDimension / slice.w, Math.min(maxDimension / slice.h, 1.0));
      dw = slice.w * ratio;
      dh = slice.h * ratio;
    }

    const dx = (slicePreviewCanvas.width - dw) / 2;
    const dy = (slicePreviewCanvas.height - dh) / 2;

    // 画質が劣化しないようピクセル補間を無効化
    ctx.imageSmoothingEnabled = false;
    
    // 原寸の中間Canvasを作らず、プレビューへ直接縮小描画する。
    // 大きなスライスが多数あるZIPでもメモリを使い切らないためのガード。
    drawSliceImageSafely(ctx, slice, dx, dy, dw, dh);
  }

  // スライスリストのDOM構築
  function updateSliceList() {
    sliceCounter.textContent = slices.length;
    
    if (slices.length === 0) {
      sliceListContainer.innerHTML = `
        <div class="empty-list-message">
          スライスが定義されていません。自動検出を実行するか、画像上をドラッグして作成してください。
        </div>
      `;
      return;
    }

    sliceListContainer.innerHTML = '';
    
    slices.forEach((slice, index) => {
      const item = document.createElement('div');
      item.className = 'slice-item';
      if (slice.id === selectedSliceId) {
        item.classList.add('active');
      }
      item.dataset.id = slice.id;

      // リスト内サムネイル用のキャンバス
      const thumbContainer = document.createElement('div');
      thumbContainer.className = 'slice-item-thumb';
      
      const thumbImg = document.createElement('canvas');
      thumbImg.width = 32;
      thumbImg.height = 32;
      const thumbCtx = thumbImg.getContext('2d');
      thumbCtx.imageSmoothingEnabled = false;

      // サムネイルに収まるように描画
      const ratio = Math.min(32 / slice.w, 32 / slice.h);
      const tw = slice.w * ratio;
      const th = slice.h * ratio;
      const tx = (32 - tw) / 2;
      const ty = (32 - th) / 2;

      // 原寸の中間Canvasを作らず、32pxサムネイルへ直接描画する。
      drawSliceImageSafely(thumbCtx, slice, tx, ty, tw, th);

      thumbContainer.appendChild(thumbImg);

      // 情報テキスト
      const info = document.createElement('div');
      info.className = 'slice-item-info';
      
      const name = document.createElement('div');
      name.className = 'slice-item-name';
      const baseName = imgState.name || 'sprite';
      const category = activeCategoryName;
      const slicePrefix = category ? `${baseName}_${category}` : baseName;
      name.textContent = slice.name || `${slicePrefix}_${slice.id}`;
      
      const details = document.createElement('div');
      details.className = 'slice-item-details';
      const rotText = slice.rotation ? ` R: ${slice.rotation}°` : '';
      details.textContent = `X: ${slice.x} Y: ${slice.y} (${slice.w}x${slice.h})${rotText}`;
      
      info.appendChild(name);
      info.appendChild(details);

      // 削除ボタン
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-delete-item';
      deleteBtn.title = 'スライスを削除';
      deleteBtn.innerHTML = '<i data-lucide="trash-2"></i>';
      
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // 行クリックイベントを防止
        deleteSlice(slice.id);
      });

      item.appendChild(thumbContainer);
      item.appendChild(info);
      item.appendChild(deleteBtn);

      // クリックイベント（別のスライスを選択するとピクセル移動モードを解除する）
      item.addEventListener('click', () => {
        if (isMoveImageMode && slice.id !== selectedSliceId) {
          isMoveImageMode = false;
          updateMoveImageButton();
        }
        showSelectionDetail(slice);
        renderCanvas();
      });

      sliceListContainer.appendChild(item);
    });

    lucide.createIcons({
      attrs: {
        class: 'inline-icon'
      },
      nameAttr: 'data-lucide'
    });
  }

  // スライスのコピー
  function copySlice(slice) {
    if (!slice) return;
    copiedSlice = {
      name: slice.name,
      w: slice.w,
      h: slice.h,
      x: slice.x,
      y: slice.y,
      rotation: slice.rotation || 0
    };
    showToast(`${slice.name} をコピーしました。`);
  }

  // コピーされたスライスの貼り付け
  function pasteSlice() {
    if (!copiedSlice || !imgState.element) return;

    saveHistory(); // 貼り付け前に履歴保存

    const id = nextSliceId++;
    
    // 貼り付け位置の計算（右下に10pxずらし、はみ出さないようにクランプする）
    let newX = copiedSlice.x + 10;
    let newY = copiedSlice.y + 10;
    newX = Math.max(0, Math.min(imgState.width - copiedSlice.w, newX));
    newY = Math.max(0, Math.min(imgState.height - copiedSlice.h, newY));

    // 新しいスライス名を作成
    const originalName = copiedSlice.name;
    let newName = '';
    
    // 末尾の _copy, _copy2 などを考慮して名前を自動調整する
    const copyMatch = originalName.match(/(.+)_copy(\d*)$/);
    if (copyMatch) {
      const base = copyMatch[1];
      const num = copyMatch[2] ? parseInt(copyMatch[2], 10) + 1 : 2;
      newName = `${base}_copy${num}`;
    } else {
      newName = `${originalName}_copy`;
    }

    // 名前がすでに重複している場合は連番を付ける
    const uniqueName = getUniqueSliceName(newName, getUsedSliceNames(), `sprite_${id}`);

    const newSlice = {
      id,
      name: uniqueName,
      x: newX,
      y: newY,
      w: copiedSlice.w,
      h: copiedSlice.h,
      rotation: copiedSlice.rotation || 0
    };

    slices.push(newSlice);
    selectedSliceId = id;

    updateSliceList();
    showSelectionDetail(newSlice, false);
    renderCanvas();
    updateCodeOutput();
    btnExportZip.disabled = false;

    showToast(`${newSlice.name} を貼り付けました。`);
  }

  // スライスの削除
  function deleteSlice(id) {
    const currentIndex = slices.findIndex(s => s.id === id);

    saveHistory(); // 削除前に履歴保存
    slices = slices.filter(s => s.id !== id);
    if (selectedSliceId === id) {
      if (slices.length > 0) {
        // 削除された位置の直後（繰り上がった要素）または末尾ならその直前を選択
        let nextIndex = currentIndex;
        if (nextIndex >= slices.length) {
          nextIndex = slices.length - 1;
        }
        const nextSlice = slices[nextIndex];
        selectedSliceId = nextSlice.id;
        showSelectionDetail(nextSlice, false);
      } else {
        hideSelectionDetail();
        btnExportZip.disabled = true;
      }
    }
    
    updateSliceList();
    renderCanvas();
    updateCodeOutput();
    showToast('スライスを削除しました。');
  }

  // ==========================================================================
  // 履歴管理 (Undo / Redo ロジック)
  // ==========================================================================

  /**
   * Canvas要素をディープコピーして新しいCanvas要素を返す
   * 単純な参照保存だと後の編集で過去の履歴も変わってしまうため、必ずコピーを取る
   * @param {HTMLCanvasElement} sourceCanvas - コピー元のCanvas
   * @returns {HTMLCanvasElement} コピーされた新しいCanvas
   */
  function cloneCanvas(sourceCanvas) {
    const copy = document.createElement('canvas');
    copy.width = sourceCanvas.width;
    copy.height = sourceCanvas.height;
    copy.getContext('2d').drawImage(sourceCanvas, 0, 0);
    return copy;
  }

  function getHistoryCapacity() {
    const imageBytes = Math.max(1, imgState.width * imgState.height * 4);
    const memoryBound = Math.floor(HISTORY_MEMORY_BUDGET_BYTES / imageBytes);
    return Math.max(1, Math.min(historyState.maxSize, memoryBound));
  }

  function trimHistoryStack(stack) {
    const capacity = getHistoryCapacity();
    while (stack.length > capacity) stack.shift();
  }

  function saveHistory() {
    const currentState = {
      slices: JSON.parse(JSON.stringify(slices)),
      selectedSliceId: selectedSliceId,
      nextSliceId: nextSliceId,
      registeredCategories: [...registeredCategories],
      activeCategoryName: activeCategoryName,
      categoryCounters: JSON.parse(JSON.stringify(categoryCounters)),
      // Canvas要素をコピーして保存（参照ではなくイミュータブルなスナップショット）
      imageElement: imgState.element ? cloneCanvas(imgState.element) : null
    };
    
    historyState.undoStack.push(currentState);
    trimHistoryStack(historyState.undoStack);
    
    // 新規操作なのでRedoスタックはクリア
    historyState.redoStack = [];
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    btnUndo.disabled = historyState.undoStack.length === 0;
    btnRedo.disabled = historyState.redoStack.length === 0;
  }

  function undo() {
    if (historyState.undoStack.length === 0) return;

    isMoveImageMode = false;
    updateMoveImageButton();

    const currentState = {
      slices: JSON.parse(JSON.stringify(slices)),
      selectedSliceId: selectedSliceId,
      nextSliceId: nextSliceId,
      registeredCategories: [...registeredCategories],
      activeCategoryName: activeCategoryName,
      categoryCounters: JSON.parse(JSON.stringify(categoryCounters)),
      // Canvas要素をコピーして退避（参照のままだとRedo後の編集で過去のスタックに影響する）
      imageElement: imgState.element ? cloneCanvas(imgState.element) : null
    };
    historyState.redoStack.push(currentState);
    trimHistoryStack(historyState.redoStack);

    const prevState = historyState.undoStack.pop();
    slices = prevState.slices;
    selectedSliceId = prevState.selectedSliceId;
    nextSliceId = prevState.nextSliceId;
    registeredCategories = Array.isArray(prevState.registeredCategories) ? [...prevState.registeredCategories] : [];
    activeCategoryName = registeredCategories.includes(prevState.activeCategoryName) ? prevState.activeCategoryName : null;
    categoryCounters = Object.assign(Object.create(null), prevState.categoryCounters || {});
    renderCategoryTags();

    // 画像エレメントの復元（同期処理）
    if (prevState.imageElement) {
      imgState.element = prevState.imageElement;
      imgState.width = prevState.imageElement.width;
      imgState.height = prevState.imageElement.height;
      imageSizeInfo.textContent = `${imgState.width} x ${imgState.height} px`;
      mainCanvas.width = imgState.width;
      mainCanvas.height = imgState.height;
    }

    updateSliceList();
    if (selectedSliceId !== null) {
      const selectedSlice = slices.find(s => s.id === selectedSliceId);
      if (selectedSlice) {
        showSelectionDetail(selectedSlice, false);
      } else {
        hideSelectionDetail();
      }
    } else {
      hideSelectionDetail();
    }

    btnExportZip.disabled = slices.length === 0;
    renderCanvas();
    updateCodeOutput();
    updateHistoryButtons();
    showToast('元に戻しました。');
  }

  function redo() {
    if (historyState.redoStack.length === 0) return;

    isMoveImageMode = false;
    updateMoveImageButton();

    const currentState = {
      slices: JSON.parse(JSON.stringify(slices)),
      selectedSliceId: selectedSliceId,
      nextSliceId: nextSliceId,
      registeredCategories: [...registeredCategories],
      activeCategoryName: activeCategoryName,
      categoryCounters: JSON.parse(JSON.stringify(categoryCounters)),
      // Canvas要素をコピーして退避（参照のままだとUndo後の編集で過去のスタックに影響する）
      imageElement: imgState.element ? cloneCanvas(imgState.element) : null
    };
    historyState.undoStack.push(currentState);
    trimHistoryStack(historyState.undoStack);

    const nextState = historyState.redoStack.pop();
    slices = nextState.slices;
    selectedSliceId = nextState.selectedSliceId;
    nextSliceId = nextState.nextSliceId;
    registeredCategories = Array.isArray(nextState.registeredCategories) ? [...nextState.registeredCategories] : [];
    activeCategoryName = registeredCategories.includes(nextState.activeCategoryName) ? nextState.activeCategoryName : null;
    categoryCounters = Object.assign(Object.create(null), nextState.categoryCounters || {});
    renderCategoryTags();

    // 画像エレメントの復元（同期処理）
    if (nextState.imageElement) {
      imgState.element = nextState.imageElement;
      imgState.width = nextState.imageElement.width;
      imgState.height = nextState.imageElement.height;
      imageSizeInfo.textContent = `${imgState.width} x ${imgState.height} px`;
      mainCanvas.width = imgState.width;
      mainCanvas.height = imgState.height;
    }

    updateSliceList();
    if (selectedSliceId !== null) {
      const selectedSlice = slices.find(s => s.id === selectedSliceId);
      if (selectedSlice) {
        showSelectionDetail(selectedSlice, false);
      } else {
        hideSelectionDetail();
      }
    } else {
      hideSelectionDetail();
    }

    btnExportZip.disabled = slices.length === 0;
    renderCanvas();
    updateCodeOutput();
    updateHistoryButtons();
    showToast('やり直しました。');
  }

  // ==========================================================================
  // ユーティリティ・DB管理
  // ==========================================================================

  function initDB() {
    return new Promise((resolve, reject) => {
      if (!isIndexedDBSupported) {
        resolve(null);
        return;
      }
      try {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: 'slotId' });
          }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => {
          isIndexedDBSupported = false;
          resolve(null);
        };
      } catch (err) {
        isIndexedDBSupported = false;
        resolve(null);
      }
    });
  }

  async function dbSaveSlot(slotId, data) {
    if (!isIndexedDBSupported) {
      memorySaveSlots[slotId] = { slotId, ...data };
      return;
    }
    const db = await initDB();
    if (!db) {
      memorySaveSlots[slotId] = { slotId, ...data };
      return;
    }
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.put({ slotId, ...data });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      } catch (err) {
        memorySaveSlots[slotId] = { slotId, ...data };
        resolve();
      }
    });
  }

  async function dbGetSlot(slotId) {
    if (!isIndexedDBSupported) {
      return memorySaveSlots[slotId] || null;
    }
    const db = await initDB();
    if (!db) {
      return memorySaveSlots[slotId] || null;
    }
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.get(slotId);
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
      } catch (err) {
        resolve(memorySaveSlots[slotId] || null);
      }
    });
  }

  async function dbDeleteSlot(slotId) {
    if (!isIndexedDBSupported) {
      delete memorySaveSlots[slotId];
      return;
    }
    const db = await initDB();
    if (!db) {
      delete memorySaveSlots[slotId];
      return;
    }
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.delete(slotId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      } catch (err) {
        delete memorySaveSlots[slotId];
        resolve();
      }
    });
  }

  async function dbClearAllSlots() {
    Object.keys(memorySaveSlots).forEach(slotId => delete memorySaveSlots[slotId]);
    if (!isIndexedDBSupported) return;

    const db = await initDB();
    if (!db) return;
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      } catch (err) {
        resolve();
      }
    });
  }

  async function dbGetAllSlots() {
    if (!isIndexedDBSupported) {
      return Object.values(memorySaveSlots);
    }
    const db = await initDB();
    if (!db) {
      return Object.values(memorySaveSlots);
    }
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.getAll();
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
      } catch (err) {
        resolve(Object.values(memorySaveSlots));
      }
    });
  }

  // ==========================================================================
  // コード出力ジェネレーター (Code Generator Logic)
  // ==========================================================================

  function getSafeOutputSlices() {
    const usedNames = new Set();
    return slices.map((slice, index) => ({
      ...slice,
      name: getUniqueSliceName(slice.name, usedNames, `sprite_${slice.id || index + 1}`)
    }));
  }

  function updateCodeOutput() {
    if (!imgState.element || slices.length === 0) {
      codeOutput.textContent = '// 画像を読み込んでスライスを定義してください';
      return;
    }

    let codeString = '';
    const outputSlices = getSafeOutputSlices();

    if (activeTab === 'json') {
      // JSON 形式
      const jsonStructure = {
        meta: {
          image: `${imgState.name}_edited.png`,
          size: { w: imgState.width, h: imgState.height },
          version: "1.0"
        },
        frames: Object.create(null)
      };

      outputSlices.forEach(slice => {
        jsonStructure.frames[slice.name] = {
          frame: { x: slice.x, y: slice.y, w: slice.w, h: slice.h },
          rotated: (slice.rotation !== 0),
          rotation: slice.rotation || 0,
          spriteSourceSize: { x: 0, y: 0, w: slice.w, h: slice.h },
          sourceSize: { w: slice.w, h: slice.h }
        };
      });

      codeString = JSON.stringify(jsonStructure, null, 2);
    } 
    else if (activeTab === 'css') {
      // CSS 形式
      codeString = `/* スプライトシート基本定義 */\n.sprite-${imgState.name} {\n  background-image: url('${imgState.name}_edited.png');\n  background-repeat: no-repeat;\n  display: inline-block;\n}\n\n`;
      
      outputSlices.forEach(slice => {
        const rotStyle = slice.rotation ? `  transform: rotate(${slice.rotation}deg);\n` : '';
        codeString += `/* ${slice.name} */\n.sprite-${imgState.name}-${slice.name} {\n  width: ${slice.w}px;\n  height: ${slice.h}px;\n  background-position: -${slice.x}px -${slice.y}px;\n${rotStyle}}\n\n`;
      });
    } 
    else if (activeTab === 'js') {
      // JS (Canvas drawImage) 形式
      codeString = `// スプライト定義オブジェクト\nconst ${imgState.name}Sprites = {\n`;
      
      outputSlices.forEach((slice, index) => {
        const isLast = index === outputSlices.length - 1;
        codeString += `  ${JSON.stringify(slice.name)}: { x: ${slice.x}, y: ${slice.y}, w: ${slice.w}, h: ${slice.h}, r: ${slice.rotation || 0} }${isLast ? '' : ','}\n`;
      });

      codeString += `};\n\n`;
      codeString += `// 描画ヘルパー関数\nfunction drawSprite(ctx, image, spriteName, dx, dy) {\n`;
      codeString += `  const sprite = ${imgState.name}Sprites[spriteName];\n`;
      codeString += `  if (!sprite) return;\n`;
      codeString += `  ctx.save();\n`;
      codeString += `  if (sprite.r) {\n`;
      codeString += `    const cx = dx + sprite.w / 2;\n`;
      codeString += `    const cy = dy + sprite.h / 2;\n`;
      codeString += `    ctx.translate(cx, cy);\n`;
      codeString += `    ctx.rotate(sprite.r * Math.PI / 180);\n`;
      codeString += `    ctx.drawImage(\n`;
      codeString += `      image,\n`;
      codeString += `      sprite.x, sprite.y, sprite.w, sprite.h,\n`;
      codeString += `      -sprite.w / 2, -sprite.h / 2, sprite.w, sprite.h\n`;
      codeString += `    );\n`;
      codeString += `  } else {\n`;
      codeString += `    ctx.drawImage(\n`;
      codeString += `      image,\n`;
      codeString += `      sprite.x, sprite.y, sprite.w, sprite.h,\n`;
      codeString += `      dx, dy, sprite.w, sprite.h\n`;
      codeString += `    );\n`;
      codeString += `  }\n`;
      codeString += `  ctx.restore();\n`;
      codeString += `}\n\n`;
      codeString += `// 使用例:\n// drawSprite(context, imgEl, ${JSON.stringify(outputSlices[0].name)}, 10, 10);`;
    }

    codeOutput.textContent = codeString;
  }

  // ==========================================================================
  // ZIP エクスポート (ZIP Exporter)
  // ==========================================================================

  function exportSlicesToZip() {
    if (!imgState.element || slices.length === 0) return;

    // JSZipライブラリが存在するか確認
    if (typeof JSZip === 'undefined') {
      showToast('ZIP保存ライブラリが読み込めません。ページを再読み込みしてください。', 'danger');
      return;
    }

    const exportableSlices = [];
    const usedNames = new Set();
    let renamedSliceCount = 0;
    let totalSlicePixels = 0;
    for (const slice of slices) {
      const frame = getValidFrameBounds(slice, imgState.width, imgState.height);
      if (!frame) {
        showToast('画像範囲外または不正なスライスがあるため、ZIP保存を中止しました。座標を修正してください。', 'danger');
        return;
      }
      totalSlicePixels += frame.w * frame.h;
      if (totalSlicePixels > MAX_EXPORT_SLICE_PIXELS) {
        showToast(`ZIP保存できる切り出し画像の合計は ${MAX_EXPORT_SLICE_PIXELS.toLocaleString()} 画素までです。分けて保存してください。`, 'danger');
        return;
      }
      const safeName = getUniqueSliceName(slice.name, usedNames, `sprite_${slice.id}`);
      if (safeName !== slice.name) renamedSliceCount++;
      exportableSlices.push({ ...slice, ...frame, name: safeName });
    }

    if (renamedSliceCount > 0) {
      showToast(`${renamedSliceCount}個のスライス名を安全な出力名に調整しました。`);
    }

    btnExportZip.disabled = true;
    btnExportZip.innerHTML = '<i data-lucide="loader" class="animate-spin inline-icon"></i> 処理中...';
    safeCreateIcons();

    try {
      const zip = new JSZip();
      
      // 編集した一枚に全ての画像が収納されたpngシート（編集後スプライトシート）を出力
      const editedDataUrl = imgState.element.toDataURL('image/png');
      const editedBase64 = editedDataUrl.split(',')[1];
      if (editedBase64) {
        zip.file(`${imgState.name}_edited.png`, editedBase64, { base64: true });
      }
      const folder = zip.folder(`${imgState.name}_slices`);
      
      // 一時描画用のキャンバス
      const sliceCanvas = document.createElement('canvas');
      const sliceCtx = sliceCanvas.getContext('2d');
      
      let processedCount = 0;

      exportableSlices.forEach((slice) => {
        const sw = slice.w;
        const sh = slice.h;
        sliceCanvas.width = sw;
        sliceCanvas.height = sh;
        sliceCtx.clearRect(0, 0, sw, sh);
        
        // 安全に切り出し描画を実行（IndexSizeError防止ガード）
        drawSliceImageSafely(sliceCtx, slice);

        // DataURLに変換後、Base64データを取り出してZIPへ追加
        const dataUrl = sliceCanvas.toDataURL('image/png');
        const base64Data = dataUrl.split(',')[1];
        
        if (base64Data) {
          folder.file(`${slice.name}.png`, base64Data, { base64: true });
          processedCount++;
        }
      });

      // メタデータJSONやCSS定義も親切にZIPに同梱する
      const jsonMeta = {
        meta: {
          image: `${imgState.name}_edited.png`,
          size: { w: imgState.width, h: imgState.height }
        },
        frames: Object.create(null)
      };
      exportableSlices.forEach(s => {
        jsonMeta.frames[s.name] = {
          frame: { x: s.x, y: s.y, w: s.w, h: s.h },
          rotated: Boolean(s.rotation),
          rotation: s.rotation || 0,
          spriteSourceSize: { x: 0, y: 0, w: s.w, h: s.h },
          sourceSize: { w: s.w, h: s.h }
        };
      });
      zip.file("sprites.json", JSON.stringify(jsonMeta, null, 2));

      let cssCode = `.sprite-${imgState.name} { background-image: url('${imgState.name}_edited.png'); background-repeat: no-repeat; display: inline-block; }\n`;
      exportableSlices.forEach(s => {
        cssCode += `.sprite-${imgState.name}-${s.name} { width: ${s.w}px; height: ${s.h}px; background-position: -${s.x}px -${s.y}px; }\n`;
      });
      zip.file("sprites.css", cssCode);

      // ZIPの生成とダウンロード
      zip.generateAsync({ type: 'blob' }).then((blob) => {
        const link = document.createElement('a');
        const objectUrl = URL.createObjectURL(blob);
        link.href = objectUrl;
        link.download = `${imgState.name}_slices.zip`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        
        // ボタン表示の復元
        btnExportZip.disabled = false;
        btnExportZip.innerHTML = '<i data-lucide="download"></i> すべてをZIPで保存';
        safeCreateIcons();
        
        showToast(`${processedCount}個の画像とメタデータをZIP保存しました。`);
      }).catch(err => {
        console.error(err);
        showToast('ZIPの生成に失敗しました。', 'danger');
        btnExportZip.disabled = false;
        btnExportZip.innerHTML = '<i data-lucide="download"></i> すべてをZIPで保存';
        safeCreateIcons();
      });
    } catch (e) {
      console.error(e);
      showToast(`ZIP保存処理でエラーが発生しました。CORS制限等がないか確認してください。`, 'danger');
      btnExportZip.disabled = false;
      btnExportZip.innerHTML = '<i data-lucide="download"></i> すべてをZIPで保存';
      safeCreateIcons();
    }
  }

  // ==========================================================================
  // トースト通知 (Toast Notifications)
  // ==========================================================================

  function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    // アイコンの選定
    let iconName = 'check-circle';
    if (type === 'danger') {
      iconName = 'alert-triangle';
    }
    
    // XSSを防ぐために要素を個別に作成してテキストを挿入
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', iconName);
    
    const msgDiv = document.createElement('div');
    msgDiv.className = 'toast-message';
    msgDiv.textContent = message;
    
    toast.appendChild(icon);
    toast.appendChild(msgDiv);
    
    toastContainer.appendChild(toast);
    safeCreateIcons();

    // 3秒後に消去
    setTimeout(() => {
      toast.style.animation = 'slideOutToast 0.3s forwards cubic-bezier(0.16, 1, 0.3, 1)';
      toast.addEventListener('animationend', () => {
        toast.remove();
      });
    }, 3000);
  }

  // ==========================================================================
  // 隣接スライス選択移動
  // ==========================================================================

  function selectAdjacentSlice(direction) {
    if (slices.length === 0) return;

    // 現在何も選択されていない場合は最初の要素を選択
    if (selectedSliceId === null) {
      const firstSlice = slices[0];
      selectedSliceId = firstSlice.id;
      showSelectionDetail(firstSlice, false);
      renderCanvas();
      return;
    }

    const current = slices.find(s => s.id === selectedSliceId);
    if (!current) return;

    const cx = current.x + current.w / 2;
    const cy = current.y + current.h / 2;

    let candidates = [];

    slices.forEach(other => {
      if (other.id === selectedSliceId) return;

      const ox = other.x + other.w / 2;
      const oy = other.y + other.h / 2;

      const dx = ox - cx;
      const dy = oy - cy;

      if (direction === 'left' && dx < 0) {
        candidates.push({ slice: other, dx: -dx, dy: Math.abs(dy) });
      } else if (direction === 'right' && dx > 0) {
        candidates.push({ slice: other, dx: dx, dy: Math.abs(dy) });
      } else if (direction === 'up' && dy < 0) {
        candidates.push({ slice: other, dx: Math.abs(dx), dy: -dy });
      } else if (direction === 'down' && dy > 0) {
        candidates.push({ slice: other, dx: Math.abs(dx), dy: dy });
      }
    });

    if (candidates.length === 0) return;

    // 距離スコア計算 (直交方向のズレのペナルティを2倍にする)
    candidates.forEach(c => {
      if (direction === 'left' || direction === 'right') {
        c.score = c.dx + c.dy * 2;
      } else {
        c.score = c.dy + c.dx * 2;
      }
    });

    // スコアの最も小さいスライスを取得
    candidates.sort((a, b) => a.score - b.score);
    const target = candidates[0].slice;

    selectedSliceId = target.id;
    showSelectionDetail(target, false);
    renderCanvas();

    // スライスリスト内の要素へスクロール追従
    const listEl = document.querySelector(`.slice-item[data-id="${target.id}"]`);
    if (listEl) {
      listEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  async function initializeSaveSlots() {
    try {
      saveSlotSelect.innerHTML = '';
      const allSaves = await dbGetAllSlots();
      const saveMap = new Map(allSaves.map(s => [s.slotId, s]));

      for (let i = 1; i <= 20; i++) {
        const option = document.createElement('option');
        option.value = i;
        
        const save = saveMap.get(i);
        if (save) {
          option.textContent = `スロット ${i} (${save.name})`;
        } else {
          option.textContent = `スロット ${i} (空)`;
        }
        saveSlotSelect.appendChild(option);
      }
      
      await updateSlotInfo();
    } catch (err) {
      console.error(err);
      showToast('セーブスロットの初期化に失敗しました。', 'danger');
    }
  }

  async function updateSlotInfo() {
    const slotId = parseInt(saveSlotSelect.value, 10);
    try {
      const save = await dbGetSlot(slotId);
      
      if (save) {
        saveSlotName.value = save.name || '';
        slotInfoBox.replaceChildren();
        const details = document.createElement('div');
        const addRow = (label, value) => {
          const labelEl = document.createElement('strong');
          labelEl.textContent = `${label}: `;
          details.append(labelEl, document.createTextNode(value), document.createElement('br'));
        };
        addRow('画像', String(save.imageName || '不明'));
        if (!isIndexedDBSupported) {
          const memoryNote = document.createElement('span');
          memoryNote.textContent = '(メモリ保存中)';
          memoryNote.style.cssText = 'font-size:0.8em;color:var(--text-muted);';
          details.append(memoryNote, document.createElement('br'));
        }
        addRow('サイズ', `${Number(save.imageWidth) || 0} x ${Number(save.imageHeight) || 0} px`);
        addRow('スライス数', `${Array.isArray(save.slices) ? save.slices.length : 0}個`);
        addRow('日時', Number.isFinite(Number(save.timestamp)) ? new Date(Number(save.timestamp)).toLocaleString() : '不明');
        slotInfoBox.appendChild(details);
        btnLoadSlot.disabled = false;
        btnDeleteSlotDB.disabled = false;
      } else {
        saveSlotName.value = '';
        slotInfoBox.textContent = '未保存のスロットです';
        btnLoadSlot.disabled = true;
        btnDeleteSlotDB.disabled = true;
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function handleSaveSlot() {
    if (!imgState.element) {
      showToast('保存する画像がありません。先に画像を読み込んでください。', 'danger');
      return;
    }

    const slotId = parseInt(saveSlotSelect.value, 10);
    
    // 編集中の画像を canvas で DataURL に変換
    const canvas = document.createElement('canvas');
    canvas.width = imgState.width;
    canvas.height = imgState.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgState.element, 0, 0);
    const imageData = canvas.toDataURL('image/png');

    // 編集前のオリジナル画像を canvas で DataURL に変換
    let originalImageData = null;
    if (imgState.originalElement) {
      const origCanvas = document.createElement('canvas');
      origCanvas.width = imgState.width;
      origCanvas.height = imgState.height;
      const origCtx = origCanvas.getContext('2d');
      origCtx.drawImage(imgState.originalElement, 0, 0);
      originalImageData = origCanvas.toDataURL('image/png');
    }

    const nameInput = saveSlotName.value.trim();
    const defaultName = `${imgState.name} (${slices.length}スライス)`;
    const saveName = nameInput || defaultName;

    const saveData = {
      name: saveName,
      timestamp: Date.now(),
      imageName: imgState.name,
      imageWidth: imgState.width,
      imageHeight: imgState.height,
      imageData: imageData,
      originalImageData: originalImageData,
      slices: JSON.parse(JSON.stringify(slices)),
      selectedSliceId: selectedSliceId,
      nextSliceId: nextSliceId,
      registeredCategories: [...registeredCategories],
      activeCategoryName: activeCategoryName,
      categoryCounters: { ...categoryCounters }
    };

    try {
      btnSaveSlot.disabled = true;
      btnSaveSlot.innerHTML = '<i data-lucide="loader" class="animate-spin inline-icon"></i> 保存中...';
      safeCreateIcons();

      await dbSaveSlot(slotId, saveData);
      showToast(`スロット ${slotId} に一時保存しました。`);
      
      btnSaveSlot.disabled = false;
      btnSaveSlot.innerHTML = '<i data-lucide="save"></i> 保存';
      safeCreateIcons();

      await initializeSaveSlots();
      saveSlotSelect.value = slotId;
      await updateSlotInfo();
    } catch (err) {
      console.error(err);
      showToast('保存に失敗しました。', 'danger');
      btnSaveSlot.disabled = false;
      btnSaveSlot.innerHTML = '<i data-lucide="save"></i> 保存';
      safeCreateIcons();
    }
  }

  async function handleLoadSlot() {
    const slotId = parseInt(saveSlotSelect.value, 10);
    try {
      const save = await dbGetSlot(slotId);
      if (!save) return;

      if (confirm(`スロット ${slotId} のセーブデータを読み込みますか？ 現在の編集状態は上書きされます。`)) {
        btnLoadSlot.disabled = true;
        btnLoadSlot.innerHTML = '<i data-lucide="loader" class="animate-spin inline-icon"></i> 復元中...';
        safeCreateIcons();

        const loadSlotImages = async () => {
          if (!isSafeStoredImageDataUrl(save.imageData)) {
            throw new Error('Saved image data is invalid');
          }

          // 編集後画像の読み込み
          const img = await new Promise((resolve, reject) => {
            const tempImg = new Image();
            tempImg.onload = () => resolve(tempImg);
            tempImg.onerror = () => reject(new Error('Failed to load edited image'));
            tempImg.src = save.imageData;
          });
          if (!isImageSizeSupported(img.width, img.height)) {
            throw new Error('Saved image is too large');
          }

          // オリジナル画像の読み込み（存在する場合）
          let origImg = null;
          if (isSafeStoredImageDataUrl(save.originalImageData)) {
            origImg = await new Promise((resolve, reject) => {
              const tempImg = new Image();
              tempImg.onload = () => resolve(tempImg);
              tempImg.onerror = () => reject(new Error('Failed to load original image'));
              tempImg.src = save.originalImageData;
            });
            if (!isImageSizeSupported(origImg.width, origImg.height) || origImg.width !== img.width || origImg.height !== img.height) {
              origImg = null;
            }
          }

          const normalizedSave = normalizeSavedSlices(save.slices, img.width, img.height);
          if (normalizedSave.error) {
            throw new Error(normalizedSave.error);
          }

          // 現在の状態を履歴保存（Undoできるように）
          saveHistory();

          // 編集用Canvasの作成
          const offscreenCanvas = document.createElement('canvas');
          offscreenCanvas.width = img.width;
          offscreenCanvas.height = img.height;
          const offscreenCtx = offscreenCanvas.getContext('2d');
          offscreenCtx.drawImage(img, 0, 0);

          // オリジナル画像Canvasの作成
          const originalCanvas = document.createElement('canvas');
          originalCanvas.width = img.width;
          originalCanvas.height = img.height;
          const originalCtx = originalCanvas.getContext('2d');
          if (origImg) {
            originalCtx.drawImage(origImg, 0, 0);
          } else {
            // originalImageDataが無い場合は編集用画像をコピー
            originalCtx.drawImage(img, 0, 0);
          }

          // 画像状態を復元
          imgState.element = offscreenCanvas;
          imgState.originalElement = originalCanvas;
          imgState.width = img.width;
          imgState.height = img.height;
          imgState.name = getSafeImageName(String(save.imageName || 'spritesheet'));

          // UI表示の更新
          imageSizeInfo.textContent = `${img.width} x ${img.height} px`;
          mainCanvas.width = img.width;
          mainCanvas.height = img.height;
          dropZone.classList.add('hidden');
          canvasWrapper.classList.remove('hidden');

          resetZoomAndPan();

          // スライスデータを検証・正規化して復元
          slices = normalizedSave.slices;
          selectedSliceId = slices.length > 0 ? slices[0].id : null;
          nextSliceId = slices.length + 1;
          categoryCounters = Object.assign(Object.create(null), save.categoryCounters || {});
          registeredCategories = (Array.isArray(save.registeredCategories)
            ? save.registeredCategories
            : Object.keys(categoryCounters))
            .filter(category => typeof category === 'string')
            .map(category => sanitizeSliceName(category, 'category'))
            .filter((category, index, all) => all.indexOf(category) === index);
          const normalizedActiveCategory = typeof save.activeCategoryName === 'string'
            ? sanitizeSliceName(save.activeCategoryName, 'category')
            : null;
          activeCategoryName = normalizedActiveCategory && registeredCategories.includes(normalizedActiveCategory)
            ? normalizedActiveCategory
            : null;
          registeredCategories.forEach(category => {
            if (!(category in categoryCounters)) categoryCounters[category] = 1;
          });
          renderCategoryTags();

          // 履歴スタックのリセット（別画像のデータをロードした場合は履歴はクリアするのが安全）
          historyState.undoStack = [];
          historyState.redoStack = [];
          updateHistoryButtons();

          updateSliceList();
          if (selectedSliceId !== null) {
            const selectedSlice = slices.find(s => s.id === selectedSliceId);
            if (selectedSlice) {
              showSelectionDetail(selectedSlice, false);
            } else {
              hideSelectionDetail();
            }
          } else {
            hideSelectionDetail();
          }

          renderCanvas();
          updateCodeOutput();
          btnExportZip.disabled = slices.length === 0;

          btnLoadSlot.disabled = false;
          btnLoadSlot.innerHTML = '<i data-lucide="folder-open"></i> 復元';
          safeCreateIcons();

          const skippedText = normalizedSave.skippedCount > 0 ? `（不正な${normalizedSave.skippedCount}個を除外）` : '';
          showToast(`スロット ${slotId} からデータを復元しました。${skippedText}`);
        };

        loadSlotImages().catch(err => {
          console.error(err);
          showToast('画像の読み込みに失敗したため、復元できませんでした。', 'danger');
          btnLoadSlot.disabled = false;
          btnLoadSlot.innerHTML = '<i data-lucide="folder-open"></i> 復元';
          safeCreateIcons();
        });
      }
    } catch (err) {
      console.error(err);
      showToast('復元に失敗しました。', 'danger');
      btnLoadSlot.disabled = false;
      btnLoadSlot.innerHTML = '<i data-lucide="folder-open"></i> 復元';
      safeCreateIcons();
    }
  }

  async function handleDeleteSlot() {
    const slotId = parseInt(saveSlotSelect.value, 10);
    if (confirm(`スロット ${slotId} のセーブデータを削除しますか？`)) {
      try {
        await dbDeleteSlot(slotId);
        showToast(`スロット ${slotId} のデータを削除しました。`);
        await initializeSaveSlots();
        saveSlotSelect.value = slotId;
        await updateSlotInfo();
      } catch (err) {
        console.error(err);
        showToast('削除に失敗しました。', 'danger');
      }
    }
  }

  async function handleClearAllSaves() {
    if (!confirm('すべての一時保存画像と編集データを、このブラウザから削除しますか？ この操作は元に戻せません。')) {
      return;
    }

    try {
      await dbClearAllSlots();
      saveSlotName.value = '';
      await initializeSaveSlots();
      showToast('すべての一時保存データを削除しました。');
    } catch (err) {
      console.error(err);
      showToast('一時保存データの削除に失敗しました。', 'danger');
    }
  }

  function renameSlicesAuto() {
    if (slices.length === 0) {
      showToast('スライスが定義されていません。', 'danger');
      return;
    }

    // スライスを位置関係（Y座標、次にX座標）でソートして名前を振り直す
    saveHistory(); // 変更前に履歴保存

    slices.sort((a, b) => {
      if (Math.abs(a.y - b.y) < 5) return a.x - b.x; // 同じ行付近ならX座標順
      return a.y - b.y;
    });

    const baseName = imgState.name || 'sprite';
    const category = activeCategoryName;
    const slicePrefix = category ? `${baseName}_${category}` : baseName;
    const usedNames = new Set();
    slices.forEach((slice, index) => {
      const newNum = index + 1;
      slice.id = newNum; // IDも位置順に連番にする
      slice.name = getUniqueSliceName(`${slicePrefix}_${newNum}`, usedNames, `sprite_${newNum}`);
    });

    nextSliceId = slices.length + 1;
    selectedSliceId = slices.length > 0 ? slices[0].id : null;

    showToast('スライス名を順番に振り直しました。');
    updateSliceList();
    if (selectedSliceId !== null) {
      showSelectionDetail(slices[0], false);
    } else {
      hideSelectionDetail();
    }
    renderCanvas();
    updateCodeOutput();
  }

  function renderCategoryTags() {
    categoryTagsContainer.innerHTML = '';
    
    if (registeredCategories.length === 0) {
      registeredCategoriesSection.classList.add('hidden');
      activeCategoryName = null;
      return;
    }

    registeredCategories.forEach(cat => {
      const tag = document.createElement('div');
      tag.className = 'category-tag';
      if (cat === activeCategoryName) {
        tag.classList.add('active');
      }
      
      const nameSpan = document.createElement('span');
      nameSpan.textContent = cat;
      tag.appendChild(nameSpan);

      // タグ自体のクリックイベント（アクティブ切り替え）
      tag.addEventListener('click', (e) => {
        // ×ボタンのクリックによるバブリングを防ぐ
        if (e.target.closest('.category-tag-remove')) return;

        if (activeCategoryName === cat) {
          activeCategoryName = null;
          showToast('カテゴリー選択を解除しました。');
        } else {
          activeCategoryName = cat;
          categoryCounters[cat] = 1; // 選択したタイミングで連番を1からリセット
          showToast(`カテゴリー ${cat} をアクティブにしました。1番から自動命名を開始します。`);
        }
        renderCategoryTags();
      });

      // 削除ボタン
      const removeBtn = document.createElement('button');
      removeBtn.className = 'category-tag-remove';
      removeBtn.title = 'カテゴリーを削除';
      removeBtn.innerHTML = '<i data-lucide="x"></i>';
      
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        registeredCategories = registeredCategories.filter(c => c !== cat);
        if (activeCategoryName === cat) {
          activeCategoryName = null;
        }
        renderCategoryTags();
      });

      tag.appendChild(removeBtn);
      categoryTagsContainer.appendChild(tag);
    });

    // Lucideアイコンの再描画
    safeCreateIcons();
  }

});
