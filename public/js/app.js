// メルカリ写真 — たくさんの写真を、正方形・明るく整えて、まとめ写真も使って10枚に収める
// すべてiPhoneの中で処理する（写真はどこにも送らない）

const SIZE = 1080;            // メルカリ向けの出力サイズ
const OUT_COUNT = 10;         // 収める枚数
const JPEG_QUALITY = 0.92;
const MAX_PHOTOS = 80;
const SRC_LONG = 1440;        // 読み込んだ写真はこの大きさに縮めて持っておく（メモリ節約）
const GAP = 14;               // まとめ写真のすき間
const RADIUS = 14;            // まとめ写真の角の丸み

const state = {
  items: [],                  // { name, src: Blob, thumb: url, w, h, params, crop: {cx, cy, z} }
  order: [],                  // 並び順（items の番号）
  outputs: [],                // { blob, url, name, count, key }
  selected: null,             // 並びの中で選んでいる位置
  singles: null,              // 1枚で見せる写真の数（null = おまかせ）
  bright: 50,
  pink: 50,                   // 色味の強さ 0-100
  tint: 'pinkbeige',          // 色味（下の TINTS の id か 'custom'）
  custom: '#e8b4c8',          // 自分で選んだ色
  mode: 'normal',             // 'normal' = ふつうの商品 / 'black' = 黒い商品
  busy: false,
  runId: 0,
};

// 色味の候補。d = 強さ100のときの R,G,B のかけ算の増減（白い背景には効かない）
const TINTS = [
  { id: 'none', name: 'そのまま', swatch: null, d: [0, 0, 0] },
  { id: 'pinkbeige', name: 'ピンクベージュ', swatch: '#e9c3c3', d: [0.07, -0.03, 0.04] },
  { id: 'beige', name: 'ベージュ', swatch: '#e6d2b5', d: [0.05, 0.01, -0.06] },
  { id: 'brown', name: 'ブラウン', swatch: '#c49a74', d: [0.06, -0.01, -0.09] },
  { id: 'green', name: 'グリーン', swatch: '#a9c9a4', d: [-0.04, 0.05, -0.02] },
  { id: 'blue', name: 'ブルー', swatch: '#a8bfe0', d: [-0.05, -0.01, 0.07] },
];

function hexToDelta(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mean = (v[0] + v[1] + v[2]) / 3 || 1;
  return v.map((x) => Math.max(-0.15, Math.min(0.15, 0.3 * (x / mean - 1))));
}

function currentDelta() {
  if (state.tint === 'custom') return hexToDelta(state.custom);
  const t = TINTS.find((x) => x.id === state.tint);
  return t ? t.d : [0, 0, 0];
}

const $ = (s) => document.querySelector(s);
const els = {};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('mp-settings') || '{}');
    if (typeof s.bright === 'number') state.bright = s.bright;
    if (typeof s.pink === 'number') state.pink = s.pink;
    if (s.mode === 'black') state.mode = 'black';
    if (s.tint && (s.tint === 'custom' || TINTS.some((t) => t.id === s.tint))) state.tint = s.tint;
    if (/^#[0-9a-f]{6}$/i.test(s.custom || '')) state.custom = s.custom;
  } catch (_) {}
}
function saveSettings() {
  try {
    localStorage.setItem('mp-settings', JSON.stringify({ bright: state.bright, pink: state.pink, mode: state.mode, tint: state.tint, custom: state.custom }));
  } catch (_) {}
}

// ---------- 分け方（10枚に収める） ----------

// 1枚で見せる写真の数の範囲
function singlesRange(n) {
  if (n <= OUT_COUNT) return { min: n, max: n, auto: n };
  // まとめ写真は1枚に2〜9枚。収まる「1枚で見せる数」の範囲を調べる
  let min = OUT_COUNT, max = 0;
  for (let s = 1; s < OUT_COUNT; s++) {
    const c = OUT_COUNT - s, r = n - s;
    if (r >= c * 2 && r <= c * 9) { min = Math.min(min, s); max = Math.max(max, s); }
  }
  if (!max) return { min: 1, max: 1, auto: 1 };
  // おまかせ：まとめ写真1枚に入れる数を 4 → 6 → 9 の順で増やして、1枚の写真をなるべく多く残す
  let auto = min;
  for (const cap of [4, 6, 9]) {
    const a = Math.floor((OUT_COUNT * cap - n) / (cap - 1));
    if (a >= 1) { auto = a; break; }
  }
  return { min, max, auto: Math.min(max, Math.max(min, auto)) };
}

// 写真の番号を、10枚ぶんのグループに分ける
function makeGroups(n, singles) {
  if (n <= OUT_COUNT) return Array.from({ length: n }, (_, i) => [i]);
  const groups = [];
  for (let i = 0; i < singles; i++) groups.push([i]);
  const c = OUT_COUNT - singles;
  const r = n - singles;
  const base = Math.floor(r / c), extra = r % c;
  let idx = singles;
  for (let k = 0; k < c; k++) {
    const size = base + (k >= c - extra ? 1 : 0);   // 多いほうを後ろに
    const g = [];
    for (let j = 0; j < size; j++) g.push(idx++);
    groups.push(g);
  }
  return groups;
}

// まとめ写真のレイアウト（縦の列に分けて、列の中を上下に分ける）
function columnsFor(n) {
  const cols = n <= 5 ? Math.min(n, 2) : 3;
  const per = Array(cols).fill(Math.floor(n / cols));
  for (let i = 0; i < n % cols; i++) per[cols - 1 - i]++;   // 左の列を少なく（大きく見せる）
  return per;
}

function panelRects(n) {
  const per = columnsFor(n);
  const cols = per.length;
  const cw = (SIZE - GAP * (cols + 1)) / cols;
  const rects = [];
  per.forEach((rows, ci) => {
    const rh = (SIZE - GAP * (rows + 1)) / rows;
    for (let ri = 0; ri < rows; ri++) {
      rects.push({ x: GAP + ci * (cw + GAP), y: GAP + ri * (rh + GAP), w: cw, h: rh });
    }
  });
  return rects;
}

// ---------- 画像処理 ----------

function percentile95(d, gr = 1, gg = 1, gb = 1) {
  const hist = new Uint32Array(1024);
  let n = 0;
  for (let i = 0; i < d.length; i += 16) {
    const m = (d[i] * gr + d[i + 1] * gg + d[i + 2] * gb) / 3;
    hist[Math.min(1023, Math.max(0, Math.round(m * 4)))]++;
    n++;
  }
  const target = n * 0.95;
  let acc = 0;
  for (let k = 0; k < 1024; k++) {
    acc += hist[k];
    if (acc >= target) return k / 4 / 255;
  }
  return 1;
}

// 写真1枚まるごとを見て、白の基準と明るさを決める
function analyze(d) {
  const thr = percentile95(d);
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  for (let i = 0; i < d.length; i += 16) {
    const m = (d[i] + d[i + 1] + d[i + 2]) / 3 / 255;
    if (m >= thr) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; cnt++; }
  }
  let gr = 1, gg = 1, gb = 1, hasWhite = false;
  if (cnt > 0) {
    const r = sr / cnt, g = sg / cnt, b = sb / cnt, mean = (r + g + b) / 3;
    const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / mean;
    // 明るくて色の薄い背景があるときだけ、それを白の基準にする（アップ写真で商品の色を消さない）
    if (mean / 255 > 0.7 && chroma < 0.15) {
      hasWhite = true;
      gr = 1 + 0.8 * (mean / r - 1);
      gg = 1 + 0.8 * (mean / g - 1);
      gb = 1 + 0.8 * (mean / b - 1);
    }
  }
  const bright = percentile95(d, gr, gg, gb) || 1;
  const expo = Math.min(0.985 / bright, hasWhite ? 1.2 : 1.1);
  return { gr: gr * expo / 255, gg: gg * expo / 255, gb: gb * expo / 255 };
}

function apply(d, w, h, params, brightV, strengthV, mode, delta) {
  const { gr, gg, gb } = params;
  const gamma = 1 - 0.4 * (brightV / 100);
  const isBlack = mode === 'black';
  const LUT_N = 4096;
  const lut = new Float32Array(LUT_N + 1);
  for (let k = 0; k <= LUT_N; k++) {
    const x = k / LUT_N;
    if (isBlack) {
      // 黒い商品：暗いところは持ち上げず、明るい背景だけ白く。黒は少し締める
      let t = (x - 0.35) / 0.45; t = t < 0 ? 0 : t > 1 ? 1 : t; t = t * t * (3 - 2 * t);
      const y = Math.pow(x, 1 + (gamma - 1) * t);
      lut[k] = Math.max(0, (y - 0.025) / 0.975);
    } else {
      lut[k] = Math.pow(x, gamma);
    }
  }
  const p = strengthV / 100;
  const dr = delta[0] * p, dg = delta[1] * p, db = delta[2] * p;
  const hasTint = p > 0 && (dr || dg || db);
  const s = isBlack ? 0.08 : 0.05;
  const curve = (v) => {
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    v = lut[(v * LUT_N) | 0];
    return v + s * (v - 0.5) * (1 - Math.abs(2 * v - 1));
  };

  for (let i = 0; i < d.length; i += 4) {
    let r = curve(d[i] * gr), g = curve(d[i + 1] * gg), b = curve(d[i + 2] * gb);
    if (isBlack) {
      const m = (r + g + b) / 3;
      if (m < 0.4) { const k = 0.35 * (1 - m / 0.4); r += (m - r) * k; g += (m - g) * k; b += (m - b) * k; }
    }
    if (hasTint) {
      // 色のある部分（商品）と、白くない部分（黒・グレーの商品）にだけ色味をのせる。白い背景はそのまま
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), m = (r + g + b) / 3;
      let ws = (mx - mn - 0.04) / 0.15;
      ws = ws < 0 ? 0 : ws > 1 ? 1 : ws;
      let wd = 1 - (m - 0.62) / 0.16;
      wd = wd < 0 ? 0 : wd > 1 ? 1 : wd;
      const wt = Math.max(ws, wd);
      if (wt > 0) {
        const lift = 0.12 * (1 - m);           // 暗い色にも少し色が見えるように
        r += (Math.min(1, r * (1 + dr) + dr * lift) - r) * wt;
        g += (Math.min(1, g * (1 + dg) + dg * lift) - g) * wt;
        b += (Math.min(1, b * (1 + db) + db * lift) - b) * wt;
      }
    }
    d[i] = r * 255 + 0.5; d[i + 1] = g * 255 + 0.5; d[i + 2] = b * 255 + 0.5;
  }
  sharpen(d, w, h, 0.4);
}

function sharpen(d, w, h, amount) {
  const src = new Uint8ClampedArray(d);
  const row = w * 4;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * row + x * 4;
      for (let c = 0; c < 3; c++) {
        const k = i + c;
        const blur = (src[k - 4] + src[k + 4] + src[k - row] + src[k + row]) / 4;
        const diff = src[k] - blur;
        if (diff > 3 || diff < -3) d[k] = src[k] + diff * amount;
      }
    }
  }
}

// 写真を w×h の枠いっぱいに（真ん中で切り抜いて）描いて、仕上げをかける
async function renderPanel(item, w, h) {
  w = Math.round(w); h = Math.round(h);
  const bmp = await createImageBitmap(item.src);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const { sx, sy, sw, sh } = cropRect(bmp.width, bmp.height, w, h, item.crop);
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  try { bmp.close(); } catch (_) {}
  const img = ctx.getImageData(0, 0, w, h);
  apply(img.data, w, h, item.params, state.bright, state.pink, state.mode, currentDelta());
  ctx.putImageData(img, 0, 0);
  return c;
}

// 枠(w×h)に入れるとき、元写真のどこを使うか（アップの倍率 z と中心 cx, cy）
function cropRect(bw, bh, w, h, crop) {
  const z = crop ? crop.z : 1;
  const scale = Math.max(w / bw, h / bh) * z;
  const sw = w / scale, sh = h / scale;
  const cx = crop ? crop.cx : 0.5, cy = crop ? crop.cy : 0.5;
  const sx = Math.min(bw - sw, Math.max(0, cx * bw - sw / 2));
  const sy = Math.min(bh - sh, Math.max(0, cy * bh - sh / 2));
  return { sx, sy, sw, sh, scale };
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function composeGroup(group) {
  const out = document.createElement('canvas');
  out.width = out.height = SIZE;
  const ctx = out.getContext('2d');
  if (group.length === 1) {
    ctx.drawImage(await renderPanel(state.items[state.order[group[0]]], SIZE, SIZE), 0, 0);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SIZE, SIZE);
    const rects = panelRects(group.length);
    for (let i = 0; i < group.length; i++) {
      const r = rects[i];
      const x = Math.round(r.x), y = Math.round(r.y);
      const panel = await renderPanel(state.items[state.order[group[i]]], r.w, r.h);
      ctx.save();
      roundRectPath(ctx, x, y, panel.width, panel.height, RADIUS);
      ctx.clip();
      ctx.drawImage(panel, x, y);
      ctx.restore();
    }
  }
  return new Promise((res) => out.toBlob(res, 'image/jpeg', JPEG_QUALITY));
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

function currentSingles() {
  const n = state.items.length;
  const rg = singlesRange(n);
  if (state.singles == null) return rg.auto;
  return Math.min(rg.max, Math.max(rg.min, state.singles));
}

function currentGroups() {
  return makeGroups(state.items.length, currentSingles());
}

function groupKey(g) {
  const look = `${state.mode}|${state.bright}|${state.pink}|${currentDelta().join(',')}`;
  return look + '|' + g.map((pos) => {
    const id = state.order[pos], c = state.items[id].crop;
    return `${id}:${c.cx.toFixed(3)},${c.cy.toFixed(3)},${c.z.toFixed(2)}`;
  }).join(';');
}

async function processAll() {
  const n = state.items.length;
  if (!n) return;
  const run = ++state.runId;
  state.busy = true;
  const groups = currentGroups();
  // 変わっていないまとめ写真は作り直さない
  const cache = new Map();
  for (const o of state.outputs) if (o.blob) cache.set(o.key, o);
  const used = new Set();
  state.outputs = groups.map((g, i) => {
    const key = groupKey(g);
    const hit = cache.get(key);
    if (hit) used.add(hit);
    return { blob: hit ? hit.blob : null, url: hit ? hit.url : null, name: `mercari_${i + 1}.jpg`, count: g.length, key };
  });
  for (const o of cache.values()) if (!used.has(o) && o.url) URL.revokeObjectURL(o.url);
  render();
  renderGrid();
  renderArrange();
  const todo = state.outputs.filter((o) => !o.blob).length;
  let done = 0;
  for (let i = 0; i < groups.length; i++) {
    const o = state.outputs[i];
    if (o.blob) continue;
    setStatus(`仕上げ中… ${++done} / ${todo}`);
    await nextFrame();
    let blob = null;
    try { blob = await composeGroup(groups[i]); } catch (e) { console.error(e); }
    if (run !== state.runId) return;            // 途中で設定が変わったらやり直し
    o.blob = blob;
    o.url = blob ? URL.createObjectURL(blob) : null;
    renderGrid();
  }
  state.busy = false;
  setStatus(n > groups.length
    ? `${n}枚の写真を${groups.length}枚に収めました`
    : `${groups.length}枚できました`);
  render();
}

// ---------- 読み込み ----------

async function loadFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png)$/i.test(f.name));
  if (!files.length) return;
  state.runId++;
  clearOutputs();
  for (const it of state.items) if (it.thumb) URL.revokeObjectURL(it.thumb);
  state.items = [];
  state.order = [];
  state.selected = null;
  state.singles = null;
  const picked = files.slice(0, MAX_PHOTOS);
  els.empty.hidden = true; els.work.hidden = false;
  for (const [idx, f] of picked.entries()) {
    setStatus(`読み込み中… ${idx + 1} / ${picked.length}`);
    await nextFrame();
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(f));
      const s = Math.min(1, SRC_LONG / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      try { bmp.close(); } catch (_) {}
      const params = analyze(ctx.getImageData(0, 0, c.width, c.height).data);
      const src = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.95));
      const t = document.createElement('canvas');
      const ts = 240 / Math.min(c.width, c.height);
      t.width = Math.round(c.width * ts); t.height = Math.round(c.height * ts);
      t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
      const thumb = URL.createObjectURL(await new Promise((res) => t.toBlob(res, 'image/jpeg', 0.8)));
      state.order.push(state.items.length);
      state.items.push({ name: f.name, src, thumb, w: c.width, h: c.height, params, crop: { cx: 0.5, cy: 0.5, z: 1 } });
    } catch (e) {
      console.error('読み込めない画像', f.name, e);
    }
  }
  await processAll();
  if (files.length > MAX_PHOTOS) setStatus(`多すぎるので、最初の${MAX_PHOTOS}枚だけ使いました`);
}

function clearOutputs() {
  for (const o of state.outputs) if (o.url) URL.revokeObjectURL(o.url);
  state.outputs = [];
}

// ---------- 保存 ----------

async function saveAll() {
  const ready = state.outputs.filter((o) => o.blob);
  if (!ready.length) return;
  const files = ready.map((o) => new File([o.blob], o.name, { type: 'image/jpeg' }));

  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      setStatus('共有画面で「画像を保存」を選ぶと写真アプリに入ります');
    } catch (e) {
      if (e && e.name === 'AbortError') setStatus('キャンセルしました');
      else setStatus('保存できませんでした。もう一度押してください');
    }
    return;
  }

  // 共有に対応していないブラウザ（パソコンなど）はダウンロード
  for (const o of ready) {
    const a = document.createElement('a');
    a.href = o.url; a.download = o.name;
    document.body.appendChild(a); a.click(); a.remove();
    await new Promise((r) => setTimeout(r, 250));
  }
  setStatus('ダウンロードしました');
}

// ---------- 画面 ----------

function setStatus(t) { if (els.status) els.status.textContent = t; }

function renderGrid() {
  els.grid.innerHTML = '';
  state.outputs.forEach((o, i) => {
    const b = document.createElement('div');
    b.className = 'thumb';
    if (o.url) {
      const img = document.createElement('img');
      img.src = o.url; img.alt = `${i + 1}枚目`;
      b.appendChild(img);
    } else {
      b.classList.add('pending');
    }
    const n = document.createElement('span');
    n.className = 'num';
    n.textContent = o.count > 1 ? `${i + 1}（${o.count}枚まとめ）` : `${i + 1}`;
    b.appendChild(n);
    els.grid.appendChild(b);
  });
}

function render() {
  const n = state.items.length;
  const has = n > 0;
  els.empty.hidden = has;
  els.work.hidden = !has;
  const outN = state.outputs.length;
  els.saveAll.disabled = state.busy || !outN;
  els.saveAll.textContent = outN ? `${outN}枚まとめて保存` : 'まとめて保存';
  els.bright.value = state.bright;
  els.pink.value = state.pink;
  els.brightVal.textContent = state.bright;
  els.pinkVal.textContent = state.pink;
  els.pinkWrap.hidden = state.tint === 'none';
  document.querySelectorAll('[name="mode"]').forEach((r) => { r.checked = r.value === state.mode; });
  document.querySelectorAll('[name="tint"]').forEach((r) => { r.checked = r.value === state.tint; });
  if (els.customColor) els.customColor.value = state.custom;
  if (els.customDot) els.customDot.style.background = state.custom;

  const rg = singlesRange(n);
  const s = currentSingles();
  els.singlesWrap.hidden = n <= OUT_COUNT;
  els.singlesVal.textContent = s;
  els.singlesMinus.disabled = s <= rg.min;
  els.singlesPlus.disabled = s >= rg.max;
  els.summary.textContent = n > OUT_COUNT
    ? `写真${n}枚 → 1枚ずつ${s}枚 ＋ まとめ写真${OUT_COUNT - s}枚`
    : `写真${n}枚`;
}

// ---------- 色味の選択 ----------

function buildTints() {
  const box = els.tints;
  box.innerHTML = '';
  const add = (id, name, color) => {
    const l = document.createElement('label');
    l.className = 'tint';
    const i = document.createElement('input');
    i.type = 'radio'; i.name = 'tint'; i.value = id; i.id = 'tint-' + id;
    i.addEventListener('change', () => { state.tint = id; scheduleReprocess(); });
    const dot = document.createElement('span');
    dot.className = 'dot' + (color ? '' : ' none');
    if (color) dot.style.background = color;
    const t = document.createElement('span');
    t.className = 'tname'; t.textContent = name;
    l.append(i, dot, t);
    box.appendChild(l);
    return { i, dot };
  };
  TINTS.forEach((t) => add(t.id, t.name, t.swatch));
  const c = add('custom', '自分で選ぶ', state.custom);
  els.customDot = c.dot;
  const picker = document.createElement('input');
  picker.type = 'color'; picker.id = 'custom-color'; picker.value = state.custom;
  picker.className = 'picker';
  picker.setAttribute('aria-label', '色を選ぶ');
  picker.addEventListener('click', () => { if (state.tint !== 'custom') { state.tint = 'custom'; scheduleReprocess(); } });
  picker.addEventListener('input', (e) => { state.custom = e.target.value; state.tint = 'custom'; scheduleReprocess(); });
  c.i.closest('label').appendChild(picker);
  els.customColor = picker;
}

// ---------- 並べ替え・アップ ----------

function renderArrange() {
  const box = els.arrange;
  box.innerHTML = '';
  if (!state.items.length) return;
  const groups = currentGroups();
  const srcButton = (pos, label, num) => {
    const it = state.items[state.order[pos]];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'src' + (state.selected === pos ? ' sel' : '') + (it.crop.z > 1.001 ? ' zoomed' : '');
    b.setAttribute('aria-label', label);
    const img = document.createElement('img');
    img.src = it.thumb; img.alt = '';
    b.appendChild(img);
    if (num) {
      const n = document.createElement('span');
      n.className = 'snum'; n.textContent = num;
      b.appendChild(n);
    }
    if (it.crop.z > 1.001) {
      const z = document.createElement('span');
      z.className = 'zbadge'; z.textContent = 'アップ';
      b.appendChild(z);
    }
    b.addEventListener('click', () => onSourceTap(pos));
    return b;
  };
  const section = (title, multi) => {
    const sec = document.createElement('div');
    sec.className = 'agroup' + (multi ? ' multi' : '');
    const h = document.createElement('div');
    h.className = 'ahead'; h.textContent = title;
    const row = document.createElement('div');
    row.className = 'arow';
    sec.append(h, row);
    box.appendChild(sec);
    return row;
  };
  // 1枚ずつの写真はひとまとめに表示して、一覧を短くする
  const singles = groups.filter((g) => g.length === 1);
  if (singles.length) {
    const row = section(`1枚ずつ見せる写真（1〜${singles.length}枚目）`, false);
    groups.forEach((g, gi) => { if (g.length === 1) row.appendChild(srcButton(g[0], `${gi + 1}枚目の写真`, gi + 1)); });
  }
  groups.forEach((g, gi) => {
    if (g.length === 1) return;
    const row = section(`${gi + 1}枚目（${g.length}枚まとめ）`, true);
    g.forEach((pos) => row.appendChild(srcButton(pos, `${gi + 1}枚目のまとめ写真に入る写真`)));
  });
  els.actions.hidden = state.selected == null;
  document.body.classList.toggle('has-actions', state.selected != null);
}

function onSourceTap(pos) {
  if (state.selected == null) {
    state.selected = pos;
  } else if (state.selected === pos) {
    state.selected = null;
  } else {
    const o = state.order;
    [o[state.selected], o[pos]] = [o[pos], o[state.selected]];
    state.selected = null;
    setStatus('入れ替えました');
    scheduleReprocess();
    return;
  }
  renderArrange();
}

// アップ（拡大と位置）の調整
const editor = { pos: null, id: null, crop: null, fw: 0, fh: 0, img: null, drag: null };

function frameAspectFor(pos) {
  const groups = currentGroups();
  for (const g of groups) {
    const k = g.indexOf(pos);
    if (k >= 0) {
      if (g.length === 1) return 1;
      const r = panelRects(g.length)[k];
      return r.w / r.h;
    }
  }
  return 1;
}

function openEditor() {
  const pos = state.selected;
  if (pos == null) return;
  const id = state.order[pos];
  const it = state.items[id];
  editor.pos = pos; editor.id = id;
  editor.crop = { ...it.crop };
  const aspect = frameAspectFor(pos);
  const max = Math.min(window.innerWidth - 32, 420);
  editor.fw = aspect >= 1 ? max : Math.round(max * aspect);
  editor.fh = aspect >= 1 ? Math.round(max / aspect) : max;
  els.frame.style.width = editor.fw + 'px';
  els.frame.style.height = editor.fh + 'px';
  els.editImg.src = URL.createObjectURL(it.src);
  els.zoom.value = editor.crop.z;
  els.editor.hidden = false;
  drawEditor();
}

function drawEditor() {
  const it = state.items[editor.id];
  const { sx, sy, scale } = cropRect(it.w, it.h, editor.fw, editor.fh, editor.crop);
  els.editImg.style.width = it.w * scale + 'px';
  els.editImg.style.height = it.h * scale + 'px';
  els.editImg.style.transform = `translate(${-sx * scale}px, ${-sy * scale}px)`;
  els.zoomVal.textContent = `${editor.crop.z.toFixed(1)}倍`;
}

function clampCrop() {
  const it = state.items[editor.id];
  const { sx, sy, sw, sh } = cropRect(it.w, it.h, editor.fw, editor.fh, editor.crop);
  editor.crop.cx = (sx + sw / 2) / it.w;
  editor.crop.cy = (sy + sh / 2) / it.h;
}

function closeEditor(apply) {
  if (apply) {
    state.items[editor.id].crop = { ...editor.crop };
    setStatus('アップを変えました');
  }
  URL.revokeObjectURL(els.editImg.src);
  els.editor.hidden = true;
  state.selected = null;
  if (apply) scheduleReprocess(); else renderArrange();
}

function initEditor() {
  const f = els.frame;
  const pts = new Map();
  let pinch = null;
  f.addEventListener('pointerdown', (e) => {
    f.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: editor.crop.z };
    }
  });
  f.addEventListener('pointermove', (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pts.set(e.pointerId, cur);
    const it = state.items[editor.id];
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      editor.crop.z = Math.min(4, Math.max(1, pinch.z * d / pinch.d));
      els.zoom.value = editor.crop.z;
    } else if (pts.size === 1) {
      const { scale } = cropRect(it.w, it.h, editor.fw, editor.fh, editor.crop);
      editor.crop.cx -= (cur.x - prev.x) / (it.w * scale);
      editor.crop.cy -= (cur.y - prev.y) / (it.h * scale);
    }
    clampCrop();
    drawEditor();
  });
  const end = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
  f.addEventListener('pointerup', end);
  f.addEventListener('pointercancel', end);
  els.zoom.addEventListener('input', (e) => { editor.crop.z = +e.target.value; clampCrop(); drawEditor(); });
  $('#edit-reset').addEventListener('click', () => { editor.crop = { cx: 0.5, cy: 0.5, z: 1 }; els.zoom.value = 1; drawEditor(); });
  $('#edit-ok').addEventListener('click', () => closeEditor(true));
  $('#edit-cancel').addEventListener('click', () => closeEditor(false));
}

let reTimer = null;
function scheduleReprocess() {
  saveSettings();
  render();
  renderArrange();
  clearTimeout(reTimer);
  reTimer = setTimeout(processAll, 350);
}

function init() {
  loadSettings();
  Object.assign(els, {
    empty: $('#empty'), work: $('#work'), grid: $('#grid'), status: $('#status'),
    input: $('#file'), saveAll: $('#save-all'),
    bright: $('#bright'), pink: $('#pink'), brightVal: $('#bright-val'), pinkVal: $('#pink-val'), pinkWrap: $('#pink-wrap'), tints: $('#tints'),
    singlesWrap: $('#singles-wrap'), singlesVal: $('#singles-val'), singlesMinus: $('#singles-minus'), singlesPlus: $('#singles-plus'),
    summary: $('#summary'), arrange: $('#arrange'), actions: $('#actions'),
    editor: $('#editor'), frame: $('#frame'), editImg: $('#edit-img'), zoom: $('#zoom'), zoomVal: $('#zoom-val'),
  });
  initEditor();
  $('#act-zoom').addEventListener('click', openEditor);
  $('#act-cancel').addEventListener('click', () => { state.selected = null; renderArrange(); });

  els.input.addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });
  document.querySelectorAll('.pick').forEach((b) => b.addEventListener('click', () => els.input.click()));
  els.saveAll.addEventListener('click', saveAll);

  els.bright.addEventListener('input', (e) => { state.bright = +e.target.value; scheduleReprocess(); });
  els.pink.addEventListener('input', (e) => { state.pink = +e.target.value; scheduleReprocess(); });
  document.querySelectorAll('[name="mode"]').forEach((r) =>
    r.addEventListener('change', (e) => { state.mode = e.target.value; scheduleReprocess(); }));
  buildTints();
  els.singlesMinus.addEventListener('click', () => { state.singles = currentSingles() - 1; state.selected = null; scheduleReprocess(); });
  els.singlesPlus.addEventListener('click', () => { state.singles = currentSingles() + 1; state.selected = null; scheduleReprocess(); });

  render();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
