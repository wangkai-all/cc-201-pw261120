const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  documents: [],
  rules: [],
  jobs: [],
  stats: null,
  currentDocId: null,
  detail: null,
  selectedPosition: null,
  showOverlap: true,
  search: '',
  activeTab: 'chunks',
  pendingRuleId: null,
  exportManifest: null,
};

class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message ?? `请求失败（${status}）`);
    this.status = status;
    this.code = payload?.error?.code ?? 'ERROR';
    this.details = payload?.error?.details;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

function toast(message, kind = 'info', timeout = 3600) {
  const stack = $('#toasts');
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  stack.append(node);
  setTimeout(() => node.remove(), timeout);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function plural(n, unit) {
  return `${n} ${unit}`;
}

function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function shortHash(hash) {
  return `${hash.slice(0, 10)}…`;
}

function codePoints(text) {
  return [...text]
    .map((char) => {
      const cp = char.codePointAt(0);
      return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    })
    .join(' ');
}

function newlineLabel(breakText) {
  if (breakText === '\r\n') return 'CRLF';
  if (breakText === '\n') return 'LF';
  if (breakText === '\r') return 'CR';
  if (breakText === '\u2028') return 'U+2028';
  if (breakText === '\u2029') return 'U+2029';
  if (breakText === '\u0085') return 'U+0085';
  return '换行';
}

/* ---------------- data loading ---------------- */

async function refreshState({ keepSelection = true } = {}) {
  const data = await api('/api/state');
  state.documents = data.documents;
  state.rules = data.rules;
  state.jobs = data.jobs;
  state.stats = data.stats;
  if (state.currentDocId && !state.documents.some((doc) => doc.id === state.currentDocId)) {
    state.currentDocId = state.documents[0]?.id ?? null;
    state.detail = null;
    state.selectedPosition = null;
  }
  if (!state.currentDocId && state.documents.length > 0) {
    state.currentDocId = state.documents[0].id;
  }
  if (keepSelection && state.currentDocId) {
    await loadDocument(state.currentDocId, { silent: true });
  }
  renderAll();
}

async function loadDocument(documentId, { silent = false } = {}) {
  state.currentDocId = documentId;
  const detail = await api(`/api/documents/${documentId}`);
  state.detail = detail;
  const positions = new Set(detail.chunks.map((chunk) => chunk.position));
  if (state.selectedPosition === null || !positions.has(state.selectedPosition)) {
    state.selectedPosition = detail.chunks[0]?.position ?? null;
  }
  if (!silent) renderAll();
}

function renderAll() {
  renderStats();
  renderDocumentList();
  renderRuleSummary();
  renderJobs();
  renderWorkspace();
}

function renderStats() {
  const stats = state.stats ?? {};
  $('[data-stat="documents"]').textContent = `文档 ${stats.documents ?? '—'}`;
  $('[data-stat="chunkContents"]').textContent = `片段内容 ${stats.chunkContents ?? '—'}`;
  $('[data-stat="references"]').textContent = `引用 ${stats.references ?? '—'}`;
  $('[data-stat="sharedChunks"]').textContent = `共享 ${stats.sharedChunks ?? '—'}`;
}

function renderDocumentList() {
  const list = $('#doc-list');
  list.replaceChildren();
  $('#doc-count').textContent = String(state.documents.length);
  if (state.documents.length === 0) {
    list.append(el('p', 'empty', '还没有文档。上传文本或载入合成样例。'));
    return;
  }
  for (const doc of state.documents) {
    const button = el('button', 'doc-item');
    button.type = 'button';
    if (doc.id === state.currentDocId) button.classList.add('active');
    button.append(el('span', 'doc-name', doc.name));
    const sub = el('span', 'doc-sub');
    sub.append(
      el('span', '', `${doc.charCount ?? 0} 字`),
      el('span', '', `${doc.chunkCount ?? 0} 片`),
      el('span', '', doc.ruleVersion ? `v${doc.ruleVersion}` : '未切分'),
    );
    button.append(sub);
    button.addEventListener('click', async () => {
      if (doc.id === state.currentDocId) return;
      state.selectedPosition = null;
      await loadDocument(doc.id);
    });
    list.append(button);
  }
}

function renderRuleSummary() {
  const latest = state.rules[0];
  const box = $('#rule-summary');
  box.replaceChildren();
  if (!latest) {
    box.append(el('p', 'empty', '尚未配置规则。'));
    return;
  }
  $('#rule-version').textContent = `v${latest.version}`;
  const rows = [
    ['段落', latest.config.paragraphMode === 'blank-line' ? '空行分段'
      : latest.config.paragraphMode === 'line' ? '每行一段'
        : `正则：${latest.config.paragraphRegex}`],
    ['块长', `${latest.config.maxChars} 字符`],
    ['重叠', `${latest.config.overlapChars} 字符`],
    ['规范化', latest.config.normalization === 'none' ? '不处理' : latest.config.normalization],
    ['换行', latest.config.newline === 'lf' ? '统一 LF' : latest.config.newline === 'crlf' ? '统一 CRLF' : '保持原样'],
  ];
  for (const [label, value] of rows) {
    const line = el('div');
    line.append(el('span', '', `${label}：`), el('code', '', value));
    box.append(line);
  }
  if (latest.note) box.append(el('p', 'empty', `说明：${latest.note}`));
}

function renderJobs() {
  const list = $('#job-list');
  list.replaceChildren();
  $('#job-count').textContent = String(state.jobs.length);
  if (state.jobs.length === 0) {
    list.append(el('li', '', '还没有作业记录'));
    return;
  }
  for (const job of state.jobs.slice(0, 12)) {
    const cls = job.status === 'succeeded' ? 'ok' : job.status === 'partial' ? 'warn' : job.status === 'failed' ? 'err' : '';
    const when = formatTime(job.finishedAt ?? job.createdAt);
    list.append(
      el(
        'li',
        cls,
        `v${job.ruleVersion ?? '?'} 重算 · ${job.status} · 重切 ${job.done} / 复用 ${job.skipped} / 失败 ${job.failed} · ${when}`,
      ),
    );
  }
}

/* ---------------- workspace ---------------- */

function renderWorkspace() {
  const hero = $('#hero');
  const workspace = $('#workspace');
  if (!state.detail) {
    hero.classList.remove('hidden');
    workspace.classList.add('hidden');
    return;
  }
  hero.classList.add('hidden');
  workspace.classList.remove('hidden');

  const { document: doc, revision, analysis, chunks } = state.detail;
  $('#doc-title').textContent = doc.name;
  $('#doc-rule-badge').textContent = `规则 v${revision.ruleVersion}`;
  const reuseBadge = $('#doc-reuse-badge');
  reuseBadge.textContent = revision.reused ? `复用切分 · ${revision.reuseReason}` : `重新切分 · ${revision.reuseReason}`;
  $('#doc-meta').textContent =
    `原文 ${plural(doc.charCount, '字符')} · ${plural(doc.byteCount, '字节')} · 清洗后 ${analysis.cleanLength} 单元 · `
    + `${analysis.stats.paragraphs} 段 / ${analysis.stats.chunks} 片 · 清洗改变 ${analysis.stats.changedAtoms} 个字素 · 版本 ${formatTime(revision.createdAt)}`;

  renderTabs();
  renderChunkList();
  renderChunkDetail();
  renderRaw();
  renderShared();
  renderRevisions();
}

function renderTabs() {
  for (const tab of $$('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === state.activeTab);
    tab.setAttribute('aria-selected', String(tab.dataset.tab === state.activeTab));
  }
  for (const panel of $$('.tab-panel')) {
    panel.classList.toggle('hidden', panel.dataset.panel !== state.activeTab);
  }
}

function selectedChunk() {
  if (!state.detail) return null;
  return state.detail.chunks.find((chunk) => chunk.position === state.selectedPosition) ?? null;
}

function chunkSharedInfo(chunk) {
  return state.detail.shared[chunk.contentHash] ?? { otherDocuments: [], localRepeats: 0 };
}

function renderChunkList() {
  const list = $('#chunk-list');
  list.replaceChildren();
  if (!state.detail) return;
  const chunks = state.detail.chunks;
  const query = state.search.trim().toLowerCase();
  const filtered = query ? chunks.filter((chunk) => chunk.text.toLowerCase().includes(query)) : chunks;
  if (filtered.length === 0) {
    list.append(el('li', 'empty', query ? '没有匹配的片段' : '没有片段'));
    return;
  }
  const limit = 400;
  for (const chunk of filtered.slice(0, limit)) {
    list.append(chunkCard(chunk));
  }
  if (filtered.length > limit) {
    list.append(el('li', 'empty', `仅显示前 ${limit} 个片段，请使用筛选缩小范围。`));
  }
}

function chunkCard(chunk) {
  const info = chunkSharedInfo(chunk);
  const card = el('li', 'chunk-card');
  if (info.otherDocuments.length > 0) card.classList.add('is-shared');
  if (chunk.position === state.selectedPosition) card.classList.add('selected');
  card.tabIndex = 0;

  const top = el('div', 'chunk-top');
  top.append(
    el('span', 'pos', `#${chunk.position + 1}`),
    el('span', 'tag', `${chunk.charCount} 字`),
    el('span', 'tag', `原文 ${chunk.rawStart}–${chunk.rawEnd}`),
  );
  if (chunk.overlapChars > 0) {
    top.append(el('span', 'tag overlap', `重叠 ${chunk.overlapChars}`));
  }
  if (info.localRepeats > 1) top.append(el('span', 'tag repeat', `本文件 ×${info.localRepeats}`));
  if (info.otherDocuments.length > 0) {
    top.append(el('span', 'tag shared', `另 ${info.otherDocuments.length} 个文档`));
  }
  card.append(top);

  const text = el('p', 'chunk-text');
  if (state.showOverlap && chunk.overlap) {
    const prefixLength = chunk.overlap.cleanEnd - chunk.cleanStart;
    if (prefixLength > 0) {
      text.append(el('span', 'overlap-mark', chunk.text.slice(0, prefixLength)));
      text.append(document.createTextNode(chunk.text.slice(prefixLength)));
    } else {
      text.textContent = chunk.text;
    }
  } else {
    text.textContent = chunk.text;
  }
  card.append(text);

  const select = () => selectChunk(chunk.position);
  card.addEventListener('click', select);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select();
    }
  });
  return card;
}

function selectChunk(position, { switchTab = false } = {}) {
  state.selectedPosition = position;
  if (switchTab) state.activeTab = 'original';
  renderChunkList();
  renderChunkDetail();
  renderTabs();
  renderRaw();
  if (switchTab) {
    const mark = $('.raw-text mark.core');
    mark?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function renderChunkDetail() {
  const box = $('#chunk-detail');
  box.replaceChildren();
  const chunk = selectedChunk();
  if (!chunk) {
    $('#chunk-detail-label').textContent = '未选择';
    box.append(el('p', 'empty', '从左侧选择一个片段，查看文本与原文坐标。'));
    return;
  }
  $('#chunk-detail-label').textContent = `#${chunk.position + 1}`;
  const info = chunkSharedInfo(chunk);

  const text = el('pre', 'detail-text');
  if (chunk.overlap) {
    const prefixLength = chunk.overlap.cleanEnd - chunk.cleanStart;
    if (prefixLength > 0) text.append(el('span', 'overlap-mark', chunk.text.slice(0, prefixLength)));
    text.append(document.createTextNode(chunk.text.slice(Math.max(0, prefixLength))));
  } else {
    text.textContent = chunk.text;
  }
  box.append(text);

  const grid = el('div', 'coord-grid');
  const coords = [
    ['原文起止', `${chunk.rawStart} → ${chunk.rawEnd}`],
    ['清洗后起止', `${chunk.cleanStart} → ${chunk.cleanEnd}`],
    ['字符 / 核心 / 重叠', `${chunk.charCount} / ${chunk.coreChars} / ${chunk.overlapChars}`],
    ['段落', `第 ${chunk.paragraph + 1} 段`],
    ['内容指纹', shortHash(chunk.contentHash)],
    ['原文切片长度', `${chunk.rawEnd - chunk.rawStart} 个 UTF-16 单元`],
  ];
  for (const [label, value] of coords) {
    const cell = el('div', 'coord');
    cell.append(el('span', '', label), el('strong', '', value));
    grid.append(cell);
  }
  box.append(grid);

  const rawSection = el('div', 'detail-section');
  rawSection.append(el('h4', '', '真正的原文切片（含原始换行）'));
  rawSection.append(el('pre', 'raw-snippet', state.detail.document.rawText.slice(chunk.rawStart, chunk.rawEnd)));
  if (chunk.overlap) {
    const overlapRaw = state.detail.document.rawText.slice(chunk.overlap.rawStart, chunk.overlap.rawEnd);
    rawSection.append(el('h4', '', '重叠部分的原文'));
    rawSection.append(el('pre', 'raw-snippet', overlapRaw));
  }
  box.append(rawSection);

  const changes = (state.detail.analysis.mapping?.changes ?? []).filter(
    (change) => change.rawStart < chunk.rawEnd && change.rawEnd > chunk.rawStart,
  );
  if (changes.length > 0) {
    const section = el('div', 'detail-section');
    section.append(el('h4', '', `本片段内被清洗改变的字符（${changes.length} 处）`));
    for (const change of changes.slice(0, 6)) {
      const line = el('div', 'raw-snippet');
      line.textContent = `${codePoints(change.raw)} → ${codePoints(change.clean)}`;
      section.append(line);
    }
    if (changes.length > 6) section.append(el('p', 'empty', '仅列出前 6 处'));
    box.append(section);
  }

  const actions = el('div', 'inline-controls');
  const locate = el('button', 'btn subtle', '在原文中高亮');
  locate.type = 'button';
  locate.addEventListener('click', () => selectChunk(chunk.position, { switchTab: true }));
  const copy = el('button', 'btn ghost', '复制片段文本');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(chunk.text);
    toast('已复制片段文本', 'success');
  });
  actions.append(locate, copy);
  box.append(actions);

  const refSection = el('div', 'detail-section');
  refSection.append(el('h4', '', '引用与共享'));
  if (info.localRepeats > 1) {
    refSection.append(el('p', 'empty', `本文件内出现 ${info.localRepeats} 次（内容只存一份）。`));
  }
  if (info.otherDocuments.length > 0) {
    const ul = el('ul', 'ref-list');
    for (const other of info.otherDocuments) {
      const li = el('li');
      const name = el('button', 'link-btn ref-name', other.documentName);
      name.type = 'button';
      name.addEventListener('click', () => openDocument(other.documentId));
      li.append(name, el('span', 'ref-pos', `位置 ${other.positions.map((p) => `#${p + 1}`).join(', ')}`));
      ul.append(li);
    }
    refSection.append(ul);
  } else if (info.localRepeats <= 1) {
    refSection.append(el('p', 'empty', '当前没有跨文档重复引用。'));
  }
  const allRefs = el('button', 'link-btn', '查看所有来源');
  allRefs.type = 'button';
  allRefs.addEventListener('click', () => showSharedDialog(chunk.contentHash));
  refSection.append(allRefs);
  box.append(refSection);
}

async function openDocument(documentId) {
  if (documentId === state.currentDocId) return;
  state.selectedPosition = null;
  await loadDocument(documentId);
}

/* ---------------- raw text ---------------- */

function lineRanges(raw) {
  const lines = [];
  const regex = /\r\n|[\r\n\u2028\u2029\u0085]/g;
  let start = 0;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    lines.push({ start, contentEnd: match.index, breakEnd: match.index + match[0].length, breakText: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ start, contentEnd: raw.length, breakEnd: raw.length, breakText: '' });
  return lines;
}

function collectIntervals(chunk) {
  const intervals = [];
  const changes = state.detail.analysis.mapping?.changes ?? [];
  for (const change of changes) {
    intervals.push({ start: change.rawStart, end: change.rawEnd, cls: 'changed', priority: 0 });
  }
  for (const item of state.detail.chunks) {
    const info = chunkSharedInfo(item);
    if (info.otherDocuments.length > 0) {
      intervals.push({ start: item.rawStart, end: item.rawEnd, cls: 'shared', priority: 1, position: item.position });
    }
  }
  if (chunk) {
    if (chunk.overlap && chunk.overlap.rawEnd > chunk.overlap.rawStart) {
      intervals.push({
        start: chunk.overlap.rawStart,
        end: chunk.overlap.rawEnd,
        cls: 'overlap',
        priority: 2,
        position: chunk.position,
      });
    }
    intervals.push({
      start: chunk.coreRawStart ?? chunk.rawStart,
      end: chunk.coreRawEnd ?? chunk.rawEnd,
      cls: 'core',
      priority: 3,
      position: chunk.position,
    });
  }
  return intervals;
}

function renderRaw() {
  const pre = $('#raw-text');
  pre.replaceChildren();
  if (!state.detail) return;
  const raw = state.detail.document.rawText;
  const chunk = selectedChunk();
  const intervals = collectIntervals(chunk);
  const lines = lineRanges(raw);
  const limit = 6000;
  for (const line of lines.slice(0, limit)) {
    const node = el('span', 'raw-line');
    node.dataset.offset = String(line.start);
    paintLine(node, raw, line, intervals);
    if (line.breakText) {
      const badge = el('span', 'line-break', `⏎ ${newlineLabel(line.breakText)}`);
      badge.title = `原始换行：${codePoints(line.breakText)}`;
      node.append(badge);
    }
    pre.append(node);
  }
  if (lines.length > limit) {
    pre.append(el('p', 'empty', `原文共 ${lines.length} 行，仅显示前 ${limit} 行。`));
  }
}

function paintLine(container, raw, line, intervals) {
  const relevant = intervals.filter((iv) => iv.start < line.contentEnd && iv.end > line.start);
  const cuts = new Set([line.start, line.contentEnd]);
  for (const iv of relevant) {
    cuts.add(Math.max(line.start, iv.start));
    cuts.add(Math.min(line.contentEnd, iv.end));
  }
  const points = [...cuts].sort((a, b) => a - b);
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i];
    const to = points[i + 1];
    if (to <= from) continue;
    let winner = null;
    for (const iv of relevant) {
      if (iv.start <= from && iv.end >= to) {
        if (!winner || iv.priority > winner.priority) winner = iv;
      }
    }
    const text = raw.slice(from, to);
    if (!text) continue;
    const node = winner ? el('mark', winner.cls) : el('span');
    node.dataset.offset = String(from);
    node.textContent = text;
    if (winner?.position !== undefined) node.dataset.position = String(winner.position);
    container.append(node);
  }
}

function handleRawClick(event) {
  if (!state.detail) return;
  const target = event.target.closest('[data-position]');
  if (target?.dataset.position !== undefined) {
    selectChunk(Number(target.dataset.position));
    return;
  }
  const offsetNode = event.target.closest('[data-offset]');
  if (!offsetNode) return;
  const offset = Number(offsetNode.dataset.offset);
  const candidates = state.detail.chunks.filter(
    (chunk) => chunk.rawStart <= offset && offset < chunk.rawEnd,
  );
  if (candidates.length === 0) return;
  const core = candidates.find(
    (chunk) => chunk.coreRawStart <= offset && offset < chunk.coreRawEnd,
  );
  selectChunk((core ?? candidates[0]).position);
}

/* ---------------- shared ---------------- */

function renderShared() {
  const list = $('#shared-list');
  list.replaceChildren();
  if (!state.detail) return;
  const groups = new Map();
  for (const chunk of state.detail.chunks) {
    const info = chunkSharedInfo(chunk);
    if (info.localRepeats <= 1 && info.otherDocuments.length === 0) continue;
    if (!groups.has(chunk.contentHash)) {
      groups.set(chunk.contentHash, {
        hash: chunk.contentHash,
        text: chunk.text,
        positions: [],
        info,
        chunk,
      });
    }
    groups.get(chunk.contentHash).positions.push(chunk.position);
  }
  $('#shared-count').textContent = String(groups.size);
  if (groups.size === 0) {
    list.append(el('p', 'empty', '当前文档没有重复或跨文档共享的片段。多个文档中相同的段落会自动识别。'));
    return;
  }
  const sorted = [...groups.values()].sort(
    (a, b) => b.info.otherDocuments.length - a.info.otherDocuments.length || b.positions.length - a.positions.length,
  );
  for (const group of sorted) {
    const card = el('div', 'shared-card');
    const top = el('div', 'chunk-top');
    top.append(
      el('span', 'pos', `本文件 ${group.positions.map((p) => `#${p + 1}`).join(', ')}`),
      el('span', 'tag', `${group.chunk.charCount} 字`),
      el('span', 'tag', shortHash(group.hash)),
    );
    card.append(top);
    card.append(el('p', 'shared-text', group.chunk.text));
    const sources = el('div', 'shared-sources');
    if (group.positions.length > 1) {
      sources.append(el('span', 'source-pill', `本文件 ×${group.positions.length}`));
    }
    for (const other of group.info.otherDocuments) {
      const pill = el('button', 'source-pill', `${other.documentName} ×${other.positions.length}`);
      pill.type = 'button';
      pill.addEventListener('click', () => openDocument(other.documentId));
      sources.append(pill);
    }
    sources.append(el('span', 'source-pill', '共享同一份内容'));
    card.append(sources);
    const actions = el('div', 'inline-controls');
    const locate = el('button', 'link-btn', '在原文中查看');
    locate.type = 'button';
    locate.addEventListener('click', () => selectChunk(group.positions[0], { switchTab: true }));
    const all = el('button', 'link-btn', '所有来源');
    all.type = 'button';
    all.addEventListener('click', () => showSharedDialog(group.hash));
    actions.append(locate, all);
    card.append(actions);
    list.append(card);
  }
}

async function showSharedDialog(hash) {
  const dialog = $('#shared-dialog');
  const content = $('#shared-dialog-content');
  content.replaceChildren(el('p', 'empty', '载入中…'));
  dialog.showModal();
  try {
    const data = await api(`/api/chunks/${hash}`);
    content.replaceChildren();
    content.append(el('p', 'hint', `内容指纹 ${data.contentHash} · ${data.charCount} 字 · 被 ${data.documentCount} 个文档引用`));
    const text = el('pre', 'detail-text', data.text);
    content.append(text);
    const list = el('div', 'ref-list');
    for (const ref of data.references) {
      const row = el('div');
      row.style.cssText = 'display:flex;justify-content:space-between;gap:12px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;font-size:12px;';
      const left = el('span');
      left.append(el('strong', '', ref.documentName));
      left.append(el('span', 'ref-pos', ` · 片段 #${ref.position + 1} · 规则版本 ${ref.revisionId.slice(-6)}`));
      const open = el('button', 'link-btn', '打开文档');
      open.type = 'button';
      open.addEventListener('click', async () => {
        dialog.close();
        await openDocument(ref.documentId);
        toast(`已打开「${ref.documentName}」，共享片段仍在其他文档保留`, 'info');
      });
      row.append(left, open);
      list.append(row);
    }
    content.append(list);
  } catch (error) {
    content.replaceChildren(el('p', 'form-error', error.message));
  }
}

/* ---------------- revisions + compare ---------------- */

function renderRevisions() {
  const box = $('#revision-list');
  box.replaceChildren();
  if (!state.detail) return;
  const revisions = state.detail.revisions;
  $('#revision-count').textContent = String(revisions.length);
  if (revisions.length === 0) {
    box.append(el('p', 'empty', '还没有版本。'));
    return;
  }
  for (const revision of revisions) {
    const row = el('div', 'rev-row');
    if (revision.id === state.detail.revision.id) row.classList.add('current');
    row.append(el('span', 'rev-ver', `v${revision.ruleVersion}`));
    row.append(
      el(
        'span',
        'rev-meta',
        `${formatTime(revision.createdAt)} · ${revision.chunkCount} 片 · ${revision.paragraphCount} 段 · ${revision.reused ? '复用切分' : '重新切分'}`,
      ),
    );
    if (revision.id === state.detail.revision.id) {
      row.append(el('span', 'badge', '当前'));
    } else {
      const compare = el('button', 'btn subtle', '与当前对比');
      compare.type = 'button';
      compare.addEventListener('click', () => openCompare(revision.id));
      row.append(compare);
    }
    box.append(row);
  }
}

function openCompare(presetRight = null) {
  if (!state.detail) return;
  const revisions = state.detail.revisions;
  if (revisions.length < 2) {
    toast('至少需要两个版本才能对比', 'error');
    return;
  }
  const left = $('#compare-left');
  const right = $('#compare-right');
  for (const select of [left, right]) {
    select.replaceChildren();
    for (const revision of revisions) {
      const option = el('option', '', `v${revision.ruleVersion} · ${formatTime(revision.createdAt)} · ${revision.chunkCount} 片`);
      option.value = revision.id;
      select.append(option);
    }
  }
  left.value = revisions[0].id;
  right.value = presetRight ?? revisions[revisions.length - 1].id;
  if (right.value === left.value) {
    const alternate = revisions.find((revision) => revision.id !== left.value);
    if (alternate) right.value = alternate.id;
  }
  $('#compare-dialog').showModal();
  runCompare();
}

async function runCompare() {
  if (!state.detail) return;
  const left = $('#compare-left').value;
  const right = $('#compare-right').value;
  const summaryBox = $('#compare-summary');
  const columns = $('#compare-columns');
  summaryBox.replaceChildren(el('span', '', '载入中…'));
  columns.replaceChildren();
  try {
    const data = await api(
      `/api/documents/${state.detail.document.id}/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`,
    );
    summaryBox.replaceChildren(
      el('span', 'same', `保留 ${data.summary.kept}`),
      el('span', 'add', `新增 ${data.summary.added}`),
      el('span', 'del', `消失 ${data.summary.removed}`),
      el('span', '', `新版本 v${data.summary.leftRuleVersion} · ${data.summary.leftChunks} 片`),
      el('span', '', `基准 v${data.summary.rightRuleVersion} · ${data.summary.rightChunks} 片`),
      el('span', '', data.summary.sameLayout ? '切分布局完全一致' : '切分布局发生变化'),
    );
    const addColumn = el('div');
    addColumn.append(el('h4', '', `新增片段（${data.added.length}）`));
    for (const item of data.added.slice(0, 60)) addColumn.append(diffItem(item, 'add'));
    if (data.added.length === 0) addColumn.append(el('p', 'empty', '没有新增片段'));
    const delColumn = el('div');
    delColumn.append(el('h4', '', `消失片段（${data.removed.length}）`));
    for (const item of data.removed.slice(0, 60)) delColumn.append(diffItem(item, 'del'));
    if (data.removed.length === 0) delColumn.append(el('p', 'empty', '没有消失片段'));
    columns.replaceChildren(addColumn, delColumn);
    if (data.kept.length > 0) {
      const keptBox = el('div', 'compare-kept');
      keptBox.append(el('h4', '', `保留片段（${data.kept.length}）`));
      for (const item of data.kept.slice(0, 20)) {
        const node = diffItem(item, 'same');
        keptBox.append(node);
      }
      if (data.kept.length > 20) keptBox.append(el('p', 'empty', '仅列出前 20 个保留片段'));
      columns.append(keptBox);
    }
  } catch (error) {
    summaryBox.replaceChildren(el('span', '', error.message));
  }
}

function diffItem(item, kind) {
  const node = el('div', `diff-item ${kind}`);
  node.append(el('span', 'diff-pos', `字符 ${item.charCount} · 原文 ${item.rawStart}–${item.rawEnd}`));
  node.append(document.createTextNode(item.text));
  return node;
}

/* ---------------- rule editor + impact ---------------- */

function currentRuleOrDefault() {
  return state.rules[0]?.config ?? {
    paragraphMode: 'blank-line',
    paragraphRegex: '',
    maxChars: 180,
    overlapChars: 24,
    trimParagraphs: true,
    normalization: 'NFC',
    newline: 'lf',
  };
}

function openRuleEditor() {
  const config = currentRuleOrDefault();
  $('#f-paragraphMode').value = config.paragraphMode;
  $('#f-paragraphRegex').value = config.paragraphRegex ?? '';
  $('#f-maxChars').value = config.maxChars;
  $('#f-overlapChars').value = config.overlapChars;
  $('#f-normalization').value = config.normalization;
  $('#f-newline').value = config.newline;
  $('#f-trimParagraphs').checked = Boolean(config.trimParagraphs);
  $('#f-note').value = '';
  $('#rule-error').textContent = '';
  $('#next-version').textContent = String((state.rules[0]?.version ?? 0) + 1);
  $('#preview-stats').textContent = state.currentDocId
    ? '调整参数后点击「预览切分」。'
    : '先在左侧选择一份文档，才能按新规则预览。';
  $('#preview-chunks').replaceChildren();
  $('#btn-rule-preview').disabled = !state.currentDocId;
  syncRegexField();
  $('#rule-dialog').showModal();
}

function syncRegexField() {
  $('#regex-field').hidden = $('#f-paragraphMode').value !== 'regex';
}

function readRuleForm() {
  return {
    paragraphMode: $('#f-paragraphMode').value,
    paragraphRegex: $('#f-paragraphRegex').value,
    maxChars: Number($('#f-maxChars').value),
    overlapChars: Number($('#f-overlapChars').value),
    trimParagraphs: $('#f-trimParagraphs').checked,
    normalization: $('#f-normalization').value,
    newline: $('#f-newline').value,
  };
}

async function previewRule() {
  if (!state.currentDocId) {
    toast('请先选择一份文档', 'error');
    return;
  }
  const errorBox = $('#rule-error');
  errorBox.textContent = '';
  const button = $('#btn-rule-preview');
  button.disabled = true;
  try {
    const data = await api(`/api/documents/${state.currentDocId}/preview`, {
      method: 'POST',
      body: { config: readRuleForm() },
    });
    const stats = $('#preview-stats');
    stats.replaceChildren(
      el('span', 'pv', `${data.preview.chunks.length} 片`),
      el('span', 'pv', `${data.preview.paragraphs.length} 段`),
      el('span', 'pv', `原文 ${data.preview.rawLength}`),
      el('span', 'pv', `清洗 ${data.preview.cleanLength}`),
      el('span', 'pv', `改变 ${data.preview.mappingChangedAtoms}`),
      el('span', 'pv', `当前 ${data.plan.currentChunks} → 新 ${data.plan.nextChunks}`),
      el('span', 'pv', data.plan.affected ? '将重新切分' : `可复用：${data.plan.reason}`),
    );
    const list = $('#preview-chunks');
    list.replaceChildren();
    for (const chunk of data.preview.chunks.slice(0, 200)) {
      const card = el('li', 'chunk-card');
      const top = el('div', 'chunk-top');
      top.append(
        el('span', 'pos', `#${chunk.index + 1}`),
        el('span', 'tag', `${chunk.charCount} 字`),
        el('span', 'tag', `原文 ${chunk.rawStart}–${chunk.rawEnd}`),
      );
      if (chunk.overlapChars > 0) top.append(el('span', 'tag overlap', `重叠 ${chunk.overlapChars}`));
      card.append(top);
      card.append(el('p', 'chunk-text', chunk.text));
      list.append(card);
    }
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function saveRule() {
  const errorBox = $('#rule-error');
  errorBox.textContent = '';
  const button = $('#btn-rule-save');
  button.disabled = true;
  try {
    const result = await api('/api/rules', {
      method: 'POST',
      body: { config: readRuleForm(), note: $('#f-note').value },
    });
    toast(`已保存规则 v${result.rule.version}`, 'success');
    const newRuleId = result.rule.id;
    $('#rule-dialog').close();
    await refreshState({ keepSelection: false });
    await showImpact(newRuleId);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function showImpact(ruleId) {
  state.pendingRuleId = ruleId;
  const dialog = $('#impact-dialog');
  const list = $('#impact-list');
  const hint = $('#impact-hint');
  list.replaceChildren(el('p', 'empty', '计算影响范围…'));
  hint.textContent = '';
  dialog.showModal();
  try {
    const data = await api(`/api/rules/${ruleId}/impact`);
    hint.textContent = `规则 v${data.rule.version}：${data.affected} 个文档需要重新切分，${data.unchanged} 个文档可复用原切分。`;
    list.replaceChildren();
    for (const row of data.rows) {
      const node = el('div', `impact-row ${row.affected ? 'affected' : 'unchanged'}`);
      node.append(el('span', 'impact-name', row.name));
      node.append(el('span', 'impact-meta', `${row.affected ? '受影响' : '不受影响'} · ${row.currentChunks} → ${row.nextChunks} 片`));
      node.append(el('span', 'impact-meta', row.reason));
      list.append(node);
    }
    $('#btn-apply-affected').disabled = data.affected === 0;
    $('#btn-apply-affected').textContent = `只重算受影响文档（${data.affected}）`;
    $('#btn-apply-all').textContent = `全部文档应用新规则（${data.rows.length}）`;
  } catch (error) {
    list.replaceChildren(el('p', 'form-error', error.message));
  }
}

async function applyRule(scope) {
  if (!state.pendingRuleId) return;
  const buttons = [$('#btn-apply-affected'), $('#btn-apply-all')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    let documentIds = null;
    if (scope === 'affected') {
      const impact = await api(`/api/rules/${state.pendingRuleId}/impact`);
      documentIds = impact.rows.filter((row) => row.affected).map((row) => row.documentId);
      if (documentIds.length === 0) {
        toast('没有需要重算的文档', 'info');
        return;
      }
    }
    const result = await api(`/api/rules/${state.pendingRuleId}/recalculate`, {
      method: 'POST',
      body: documentIds ? { documentIds } : {},
    });
    const job = result.job;
    toast(
      `规则 v${job.ruleVersion ?? ''} 已应用：重切 ${job.done}，复用 ${job.skipped}，失败 ${job.failed}`,
      job.failed > 0 ? 'error' : 'success',
    );
    $('#impact-dialog').close();
    await refreshState({ keepSelection: true });
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

/* ---------------- upload ---------------- */

async function openUpload() {
  $('#upload-form').reset();
  $('#file-name').textContent = '';
  $('#upload-text').value = '';
  $('#upload-error').textContent = '';
  const select = $('#upload-rule');
  select.replaceChildren();
  for (const rule of state.rules) {
    const option = el('option', '', `v${rule.version}${rule.note ? ` · ${rule.note}` : ''}`);
    option.value = rule.id;
    select.append(option);
  }
  $('#upload-dialog').showModal();
}

async function submitUpload(event) {
  event.preventDefault();
  const errorBox = $('#upload-error');
  errorBox.textContent = '';
  const content = $('#upload-text').value;
  if (!content.trim()) {
    errorBox.textContent = '请粘贴文本或选择一个文本文件。';
    return;
  }
  const submit = $('#upload-submit');
  submit.disabled = true;
  try {
    const result = await api('/api/documents', {
      method: 'POST',
      body: {
        name: $('#upload-name').value,
        content,
        ruleId: $('#upload-rule').value || undefined,
      },
    });
    $('#upload-dialog').close();
    toast(`已切分「${result.document.name}」：${result.revision.chunkCount} 个片段`, 'success');
    state.selectedPosition = null;
    state.currentDocId = result.document.id;
    await refreshState({ keepSelection: false });
    await loadDocument(result.document.id);
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

async function handleFile(file) {
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    toast('文件超过 4 MB 演示上限', 'error');
    return;
  }
  const text = await file.text();
  $('#upload-text').value = text;
  if (!$('#upload-name').value) {
    $('#upload-name').value = file.name.replace(/\.(txt|md)$/i, '');
  }
  $('#file-name').textContent = `${file.name} · ${file.size} 字节 · ${text.length} 个 UTF-16 单元`;
}

/* ---------------- export ---------------- */

async function openExport() {
  const dialog = $('#export-dialog');
  const preview = $('#manifest-preview');
  preview.textContent = '载入中…';
  if (!dialog.open) dialog.showModal();
  try {
    const manifest = await fetchManifest();
    state.exportManifest = manifest;
    preview.textContent = JSON.stringify(
      { ...manifest, chunks: manifest.chunks.slice(0, 8) },
      null,
      2,
    ) + (manifest.chunks.length > 8 ? `\n\n…共 ${manifest.chunks.length} 个片段` : '');
  } catch (error) {
    preview.textContent = error.message;
  }
}

async function fetchManifest() {
  const scope = $('#export-scope').value;
  const params = new URLSearchParams();
  if (scope === 'current' && state.currentDocId) params.set('documentId', state.currentDocId);
  const query = params.toString();
  return api(`/api/export${query ? `?${query}` : ''}`);
}

async function downloadJsonl() {
  try {
    const manifest = await fetchManifest();
    const lines = manifest.chunks.map((chunk) => JSON.stringify(chunk)).join('\n');
    const blob = new Blob([`${lines}\n`], { type: 'application/x-ndjson;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    link.href = url;
    link.download = `corpus-manifest-${stamp}.jsonl`;
    link.click();
    URL.revokeObjectURL(url);
    toast(`已导出 ${manifest.chunks.length} 条训练清单`, 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function copyManifest() {
  try {
    const manifest = await fetchManifest();
    await navigator.clipboard.writeText(JSON.stringify(manifest, null, 2));
    toast('已复制完整 JSON 清单', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ---------------- boot + events ---------------- */

async function loadSamples() {
  try {
    const result = await api('/api/samples/load', { method: 'POST' });
    toast(`已载入 ${result.created.length} 篇合成样例`, 'success');
    state.currentDocId = result.created[0]?.document.id ?? null;
    state.selectedPosition = null;
    await refreshState({ keepSelection: false });
    if (state.currentDocId) await loadDocument(state.currentDocId);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function bindEvents() {
  $('#btn-upload').addEventListener('click', openUpload);
  $('#btn-upload-2').addEventListener('click', openUpload);
  $('#btn-load-samples').addEventListener('click', loadSamples);
  $('#btn-samples-2').addEventListener('click', loadSamples);
  $('#btn-export').addEventListener('click', openExport);
  $('#btn-rule-editor').addEventListener('click', openRuleEditor);

  $('#upload-form').addEventListener('submit', submitUpload);
  $('#file-input').addEventListener('change', (event) => handleFile(event.target.files?.[0]));

  const dropzone = $('#dropzone');
  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', async (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
    await handleFile(event.dataTransfer?.files?.[0]);
  });

  $('#btn-preview').addEventListener('click', openRuleEditor);
  $('#btn-reanalyze').addEventListener('click', async () => {
    if (!state.currentDocId) return;
    try {
      const result = await api(`/api/documents/${state.currentDocId}/reanalyze`, { method: 'POST', body: {} });
      toast(
        result.revision.reused
          ? `已生成新版本（复用切分：${result.revision.reuseReason}）`
          : `已按最新规则重新切分：${result.revision.chunkCount} 片`,
        'success',
      );
      await refreshState({ keepSelection: false });
      await loadDocument(state.currentDocId);
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('#btn-delete').addEventListener('click', async () => {
    if (!state.detail) return;
    const doc = state.detail.document;
    const sharedCount = Object.values(state.detail.shared).filter(
      (info) => info.otherDocuments.length > 0,
    ).length;
    const message = sharedCount > 0
      ? `删除「${doc.name}」？\n\n它有 ${sharedCount} 个被其他文档共享的片段。删除后这些片段仍会保留在其他文档中。`
      : `删除「${doc.name}」？此操作会移除该文档的版本与引用。`;
    if (!confirm(message)) return;
    try {
      const result = await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
      toast(`已删除「${doc.name}」，回收 ${result.chunksGarbageCollected} 个无引用内容`, 'success');
      state.detail = null;
      state.selectedPosition = null;
      state.currentDocId = state.documents.find((item) => item.id !== doc.id)?.id ?? null;
      await refreshState({ keepSelection: false });
      if (state.currentDocId) await loadDocument(state.currentDocId);
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('#btn-compare').addEventListener('click', () => openCompare());

  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      renderTabs();
      renderRaw();
    });
  }

  $('#toggle-overlap').checked = state.showOverlap;
  $('#toggle-overlap').addEventListener('change', (event) => {
    state.showOverlap = event.target.checked;
    renderChunkList();
    renderChunkDetail();
  });

  $('#chunk-search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderChunkList();
  });

  $('#raw-text').addEventListener('click', handleRawClick);

  $('#f-paragraphMode').addEventListener('change', syncRegexField);
  $('#btn-rule-preview').addEventListener('click', previewRule);
  $('#btn-rule-save').addEventListener('click', saveRule);
  $('#btn-rule-reset').addEventListener('click', () => {
    const config = currentRuleOrDefault();
    $('#f-paragraphMode').value = config.paragraphMode;
    $('#f-paragraphRegex').value = config.paragraphRegex ?? '';
    $('#f-maxChars').value = config.maxChars;
    $('#f-overlapChars').value = config.overlapChars;
    $('#f-normalization').value = config.normalization;
    $('#f-newline').value = config.newline;
    $('#f-trimParagraphs').checked = Boolean(config.trimParagraphs);
    syncRegexField();
    $('#rule-error').textContent = '';
  });

  $('#btn-apply-affected').addEventListener('click', () => applyRule('affected'));
  $('#btn-apply-all').addEventListener('click', () => applyRule('all'));

  $('#compare-left').addEventListener('change', runCompare);
  $('#compare-right').addEventListener('change', runCompare);

  for (const button of $$('[data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }

  $('#export-scope').addEventListener('change', openExport);
  $('#btn-download-json').addEventListener('click', downloadJsonl);
  $('#btn-copy-manifest').addEventListener('click', copyManifest);
}

async function main() {
  bindEvents();
  try {
    await refreshState({ keepSelection: false });
    if (state.currentDocId) await loadDocument(state.currentDocId);
  } catch (error) {
    toast(`加载失败：${error.message}`, 'error', 6000);
  }
}

main();
