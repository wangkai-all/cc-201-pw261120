import { createHash } from 'node:crypto';

/**
 * Text cleaning, offset mapping and deterministic chunking.
 *
 * Offsets are UTF-16 code-unit offsets, matching JavaScript string semantics.
 * "Characters" for chunk sizing are extended grapheme clusters of the ORIGINAL
 * text. An emoji ZWJ family counts as one, a base letter plus its combining
 * marks counts as one, and CRLF counts as one newline. The original grapheme
 * clusters are the atoms of the mapping: cleaning normalises each atom in
 * isolation, so a chunk boundary can never split a surrogate pair, a combining
 * sequence or a Hangul syllable that was composed during cleaning.
 */

export const DEFAULT_CONFIG = Object.freeze({
  paragraphMode: 'blank-line',
  paragraphRegex: '',
  maxChars: 180,
  overlapChars: 24,
  trimParagraphs: true,
  normalization: 'NFC',
  newline: 'lf',
});

export const CONFIG_FIELDS = Object.freeze([
  'paragraphMode',
  'paragraphRegex',
  'maxChars',
  'overlapChars',
  'trimParagraphs',
  'normalization',
  'newline',
]);

export const LIMITS = Object.freeze({
  maxTextUnits: 500_000,
  maxChars: 4_000,
  maxParagraphs: 20_000,
  maxChunksPerDocument: 20_000,
});

const PARAGRAPH_MODES = new Set(['blank-line', 'line', 'regex']);
const NORMALIZATIONS = new Set(['none', 'NFC', 'NFD', 'NFKC', 'NFKD']);
const NEWLINES = new Set(['lf', 'crlf', 'keep']);

const LINE_BREAK_RE = /\r\n|[\r\n\u2028\u2029\u0085]/g;
const SINGLE_LINE_BREAK_RE = /^(?:\r\n|[\r\n\u2028\u2029\u0085])$/;
const BLANK_LINE_RE = /^[ \t\f\v\u00a0]*$/u;
const WHITESPACE_ATOM_RE = /^[\s\u00a0\u2007\u202f]+$/u;

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

export class TextConfigError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'TextConfigError';
    this.code = 'INVALID_CONFIG';
    this.field = field;
  }
}

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pickConfig(input) {
  const out = {};
  for (const key of CONFIG_FIELDS) {
    if (Object.hasOwn(input, key)) out[key] = input[key];
  }
  return out;
}

export function validateConfig(input = {}, base = DEFAULT_CONFIG) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TextConfigError('规则配置必须是一个对象');
  }
  const config = { ...base, ...pickConfig(input) };

  if (!PARAGRAPH_MODES.has(config.paragraphMode)) {
    throw new TextConfigError('不支持的段落模式', 'paragraphMode');
  }
  if (typeof config.paragraphRegex !== 'string') {
    throw new TextConfigError('段落正则必须是字符串', 'paragraphRegex');
  }
  if (config.paragraphMode === 'regex') {
    if (config.paragraphRegex.length === 0) {
      throw new TextConfigError('段落模式为正则时必须填写分隔表达式', 'paragraphRegex');
    }
    try {
      new RegExp(config.paragraphRegex, 'gm');
    } catch (error) {
      throw new TextConfigError(`段落正则无效：${error.message}`, 'paragraphRegex');
    }
  }
  if (!Number.isInteger(config.maxChars) || config.maxChars < 8 || config.maxChars > LIMITS.maxChars) {
    throw new TextConfigError(`最长块字符数必须是 8–${LIMITS.maxChars} 的整数`, 'maxChars');
  }
  if (!Number.isInteger(config.overlapChars) || config.overlapChars < 0) {
    throw new TextConfigError('重叠字符数必须是非负整数', 'overlapChars');
  }
  if (config.overlapChars >= config.maxChars) {
    throw new TextConfigError('重叠字符数必须小于最长块字符数', 'overlapChars');
  }
  if (typeof config.trimParagraphs !== 'boolean') {
    throw new TextConfigError('段落首尾清理必须是布尔值', 'trimParagraphs');
  }
  if (!NORMALIZATIONS.has(config.normalization)) {
    throw new TextConfigError('不支持的 Unicode 规范化形式', 'normalization');
  }
  if (!NEWLINES.has(config.newline)) {
    throw new TextConfigError('不支持的换行统一方式', 'newline');
  }
  return Object.freeze(config);
}

export function configKey(config) {
  const canonical = {};
  for (const key of CONFIG_FIELDS) canonical[key] = config[key];
  return sha256(JSON.stringify(canonical));
}

export function countGraphemes(text) {
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

function normaliseNewlineAtom(segment, newline) {
  if (newline === 'keep' || !SINGLE_LINE_BREAK_RE.test(segment)) return segment;
  return newline === 'crlf' ? '\r\n' : '\n';
}

function findBoundary(boundaries, offset) {
  let low = 0;
  let high = boundaries.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const value = boundaries[mid];
    if (value === offset) return mid;
    if (value < offset) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

/**
 * Clean every original grapheme cluster as an isolated atom and record the
 * monotonic bridge between raw and cleaned UTF-16 offsets.
 */
export function cleanWithMapping(raw, configInput) {
  const config = validateConfig(configInput, DEFAULT_CONFIG);
  if (typeof raw !== 'string') throw new TypeError('raw must be a string');
  if (raw.length > LIMITS.maxTextUnits) {
    throw new TextConfigError(`文档超过 ${LIMITS.maxTextUnits} 个 UTF-16 单元的演示上限`, 'rawText');
  }

  const rawStarts = [0];
  const cleanStarts = [0];
  const pieces = [];
  const changes = [];
  let changedCount = 0;
  let cleanLength = 0;
  let atomCount = 0;

  for (const entry of segmenter.segment(raw)) {
    const original = entry.segment;
    let clean = config.normalization === 'none'
      ? original
      : original.normalize(config.normalization);
    clean = normaliseNewlineAtom(clean, config.newline);

    // A grapheme cluster is never empty. Normalisation can expand it (ﬁ -> fi,
    // ½ -> 1⁄2) or contract it (e + combining acute -> é), but it is still one
    // atomic unit for chunk sizing.
    pieces.push(clean);
    cleanLength += clean.length;
    atomCount += 1;
    rawStarts.push(entry.index + original.length);
    cleanStarts.push(cleanLength);

    if (clean !== original) {
      changedCount += 1;
      if (changes.length < 60) {
        changes.push({
          rawStart: entry.index,
          rawEnd: entry.index + original.length,
          cleanStart: cleanLength - clean.length,
          cleanEnd: cleanLength,
          raw: original,
          clean,
        });
      }
    }
  }

  const cleanText = pieces.join('');
  return {
    cleanText,
    cleanHash: sha256(cleanText),
    rawLength: raw.length,
    cleanLength,
    atomCount,
    mapping: {
      rawStarts,
      cleanStarts,
      rawLength: raw.length,
      cleanLength,
      atomCount,
      changedCount,
      changes,
    },
  };
}

export function cleanToRaw(mapping, cleanStart, cleanEnd) {
  const startAtom = findBoundary(mapping.cleanStarts, cleanStart);
  const endAtom = findBoundary(mapping.cleanStarts, cleanEnd);
  if (startAtom < 0 || endAtom < 0 || endAtom < startAtom) {
    throw new RangeError(`清洗偏移 ${cleanStart}–${cleanEnd} 不是合法的原子边界`);
  }
  return {
    start: mapping.rawStarts[startAtom],
    end: mapping.rawStarts[endAtom],
    startAtom,
    endAtom,
  };
}

export function rawToClean(mapping, rawStart, rawEnd) {
  const startAtom = findBoundary(mapping.rawStarts, rawStart);
  const endAtom = findBoundary(mapping.rawStarts, rawEnd);
  if (startAtom < 0 || endAtom < 0 || endAtom < startAtom) {
    throw new RangeError(`原文偏移 ${rawStart}–${rawEnd} 不是合法的原子边界`);
  }
  return {
    start: mapping.cleanStarts[startAtom],
    end: mapping.cleanStarts[endAtom],
    startAtom,
    endAtom,
  };
}

function trimToAtoms(cleanText, cleanStarts, start, end) {
  let startAtom = findBoundary(cleanStarts, start);
  let endAtom = findBoundary(cleanStarts, end);
  if (startAtom < 0 || endAtom < 0) {
    throw new RangeError('段落边界没有落在字素簇边界上');
  }
  while (startAtom < endAtom) {
    const piece = cleanText.slice(cleanStarts[startAtom], cleanStarts[startAtom + 1]);
    if (!WHITESPACE_ATOM_RE.test(piece)) break;
    startAtom += 1;
  }
  while (endAtom > startAtom) {
    const piece = cleanText.slice(cleanStarts[endAtom - 1], cleanStarts[endAtom]);
    if (!WHITESPACE_ATOM_RE.test(piece)) break;
    endAtom -= 1;
  }
  return { start: cleanStarts[startAtom], end: cleanStarts[endAtom] };
}

function lineRanges(text) {
  const lines = [];
  LINE_BREAK_RE.lastIndex = 0;
  let start = 0;
  let match;
  while ((match = LINE_BREAK_RE.exec(text)) !== null) {
    lines.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  lines.push({ start, end: text.length });
  return lines;
}

function parseParagraphRanges(cleanText, config) {
  const ranges = [];

  if (config.paragraphMode === 'regex') {
    let regex;
    try {
      regex = new RegExp(config.paragraphRegex, 'gm');
    } catch (error) {
      throw new TextConfigError(`段落正则无效：${error.message}`, 'paragraphRegex');
    }
    let last = 0;
    let match;
    while ((match = regex.exec(cleanText)) !== null) {
      if (match[0].length === 0) {
        throw new TextConfigError('段落分隔正则不能匹配空字符串（会导致无限循环）', 'paragraphRegex');
      }
      if (match.index > last) ranges.push({ start: last, end: match.index });
      last = match.index + match[0].length;
    }
    if (last < cleanText.length) ranges.push({ start: last, end: cleanText.length });
    return ranges;
  }

  const lines = lineRanges(cleanText);
  if (config.paragraphMode === 'line') {
    for (const line of lines) {
      if (line.end > line.start && !BLANK_LINE_RE.test(cleanText.slice(line.start, line.end))) {
        ranges.push({ start: line.start, end: line.end });
      }
    }
    return ranges;
  }

  // blank-line: consecutive non-blank lines form one paragraph.
  let current = null;
  for (const line of lines) {
    const content = cleanText.slice(line.start, line.end);
    const isBlank = BLANK_LINE_RE.test(content);
    if (isBlank) {
      if (current) {
        ranges.push(current);
        current = null;
      }
      continue;
    }
    if (!current) current = { start: line.start, end: line.end };
    else current.end = line.end;
  }
  if (current) ranges.push(current);
  return ranges;
}

function paragraphAtomCount(cleanStarts, start, end) {
  const a = findBoundary(cleanStarts, start);
  const b = findBoundary(cleanStarts, end);
  return b - a;
}

/**
 * Split each paragraph into windows of at most maxChars original graphemes.
 * Window two and later begin with an overlap prefix copied from the tail of
 * the previous window; overlapChars is stored explicitly on every chunk.
 */
function splitParagraph(cleanText, cleanStarts, paragraph, maxChars, overlapChars) {
  const atomStart = findBoundary(cleanStarts, paragraph.cleanStart);
  const atomEnd = findBoundary(cleanStarts, paragraph.cleanEnd);
  const totalAtoms = atomEnd - atomStart;
  if (totalAtoms <= 0) return [];

  const chunks = [];
  let cursor = atomStart;
  let first = true;

  while (cursor < atomEnd) {
    const endAtom = Math.min(cursor + maxChars, atomEnd);
    const overlapAtoms = first ? 0 : Math.min(overlapChars, endAtom - cursor - 1);
    const coreAtomStart = cursor + overlapAtoms;
    const cleanStart = cleanStarts[cursor];
    const cleanEnd = cleanStarts[endAtom];
    const overlapCleanEnd = cleanStarts[coreAtomStart];
    chunks.push({
      cleanStart,
      cleanEnd,
      overlap: overlapAtoms > 0
        ? { cleanStart, cleanEnd: overlapCleanEnd, chars: overlapAtoms }
        : null,
      coreCleanStart: overlapCleanEnd,
      coreCleanEnd: cleanEnd,
      charCount: endAtom - cursor,
      coreChars: endAtom - coreAtomStart,
      text: cleanText.slice(cleanStart, cleanEnd),
    });
    if (endAtom >= atomEnd) break;
    cursor = endAtom - overlapChars;
    first = false;
  }
  return chunks;
}

/**
 * Return the paragraph/chunk layout without content hashes. Kept separate so
 * callers can compare layouts and avoid re-chunking unaffected documents.
 */
export function shapeDocument(raw, configInput) {
  const config = validateConfig(configInput, DEFAULT_CONFIG);
  const cleaned = cleanWithMapping(raw, config);
  const rawRanges = parseParagraphRanges(cleaned.cleanText, config);
  const paragraphs = [];
  for (const range of rawRanges) {
    let start = range.start;
    let end = range.end;
    if (config.trimParagraphs) {
      ({ start, end } = trimToAtoms(cleaned.cleanText, cleaned.mapping.cleanStarts, start, end));
    }
    if (end <= start) continue;
    if (paragraphs.length >= LIMITS.maxParagraphs) {
      throw new TextConfigError(`段落数超过演示上限 ${LIMITS.maxParagraphs}`, 'paragraphs');
    }
    const rawSpan = cleanToRaw(cleaned.mapping, start, end);
    paragraphs.push({
      index: paragraphs.length,
      cleanStart: start,
      cleanEnd: end,
      rawStart: rawSpan.start,
      rawEnd: rawSpan.end,
      charCount: paragraphAtomCount(cleaned.mapping.cleanStarts, start, end),
    });
  }

  const layoutHash = sha256(
    `${cleaned.cleanHash}\u0000${paragraphs.map((p) => `${p.cleanStart}-${p.cleanEnd}`).join(',')}`,
  );

  return {
    config,
    cleaned,
    paragraphs,
    layoutHash,
    cleanText: cleaned.cleanText,
  };
}

function hydrateChunk(cleanText, mapping, chunk, index) {
  const rawSpan = cleanToRaw(mapping, chunk.cleanStart, chunk.cleanEnd);
  const coreRaw = cleanToRaw(mapping, chunk.coreCleanStart, chunk.coreCleanEnd);
  const overlapRaw = chunk.overlap
    ? cleanToRaw(mapping, chunk.overlap.cleanStart, chunk.overlap.cleanEnd)
    : null;
  return {
    index,
    hash: sha256(chunk.text),
    charCount: chunk.charCount,
    coreChars: chunk.coreChars,
    overlapChars: chunk.overlap ? chunk.overlap.chars : 0,
    text: chunk.text,
    cleanStart: chunk.cleanStart,
    cleanEnd: chunk.cleanEnd,
    rawStart: rawSpan.start,
    rawEnd: rawSpan.end,
    coreCleanStart: chunk.coreCleanStart,
    coreCleanEnd: chunk.coreCleanEnd,
    coreRawStart: coreRaw.start,
    coreRawEnd: coreRaw.end,
    overlap: chunk.overlap
      ? {
          cleanStart: chunk.overlap.cleanStart,
          cleanEnd: chunk.overlap.cleanEnd,
          rawStart: overlapRaw.start,
          rawEnd: overlapRaw.end,
          chars: chunk.overlap.chars,
        }
      : null,
  };
}

function chunksForShape(shape) {
  const config = shape.config;
  const mapping = shape.cleaned.mapping;
  const chunks = [];
  for (const paragraph of shape.paragraphs) {
    const pieces = splitParagraph(
      shape.cleanText,
      mapping.cleanStarts,
      paragraph,
      config.maxChars,
      config.overlapChars,
    );
    for (const piece of pieces) {
      chunks.push(hydrateChunk(shape.cleanText, mapping, piece, chunks.length));
    }
  }
  if (chunks.length > LIMITS.maxChunksPerDocument) {
    throw new TextConfigError(
      `切片数 ${chunks.length} 超过单文档上限 ${LIMITS.maxChunksPerDocument}，请增大块字符数`,
      'maxChars',
    );
  }
  return chunks;
}

function analysisOf(shape, chunks, config) {
  const totalChars = chunks.reduce((sum, chunk) => sum + chunk.charCount, 0);
  const coreChars = chunks.reduce((sum, chunk) => sum + chunk.coreChars, 0);
  const overlapChars = chunks.reduce((sum, chunk) => sum + chunk.overlapChars, 0);
  const chunkSignature = sha256(
    chunks
      .map((chunk) => [
        chunk.hash,
        chunk.cleanStart,
        chunk.cleanEnd,
        chunk.rawStart,
        chunk.rawEnd,
        chunk.overlap ? `${chunk.overlap.cleanStart}-${chunk.overlap.cleanEnd}` : '',
      ].join(':'))
      .join('|'),
  );
  return {
    cleanHash: shape.cleaned.cleanHash,
    layoutHash: shape.layoutHash,
    chunkSignature,
    cleanLength: shape.cleaned.cleanLength,
    atomCount: shape.cleaned.atomCount,
    config,
    configKey: configKey(config),
    maxChars: config.maxChars,
    overlapChars: config.overlapChars,
    mapping: shape.cleaned.mapping,
    paragraphs: shape.paragraphs,
    chunks,
    stats: {
      paragraphs: shape.paragraphs.length,
      chunks: chunks.length,
      chunkChars: totalChars,
      coreChars,
      overlapChars,
      changedAtoms: shape.cleaned.mapping.changedCount,
    },
  };
}

function canReuseChunking(previous, shape) {
  if (!previous) return { reuse: false, reason: '首次切分' };
  if (previous.cleanHash !== shape.cleaned.cleanHash) {
    return { reuse: false, reason: '清洗文本发生变化' };
  }
  if (previous.layoutHash !== shape.layoutHash) {
    return { reuse: false, reason: '段落边界发生变化' };
  }
  if (
    previous.maxChars === shape.config.maxChars
    && previous.overlapChars === shape.config.overlapChars
  ) {
    return { reuse: true, reason: '切分参数未变' };
  }
  const longest = shape.paragraphs.reduce((max, p) => Math.max(max, p.charCount), 0);
  if (longest <= Math.min(previous.maxChars, shape.config.maxChars)) {
    return { reuse: true, reason: '所有段落均不超过块长' };
  }
  return { reuse: false, reason: '块长或重叠参数改变' };
}

function remapReusedChunks(previousChunks, mapping) {
  return previousChunks.map((chunk, index) => {
    const rawSpan = cleanToRaw(mapping, chunk.cleanStart, chunk.cleanEnd);
    const coreCleanStart = chunk.coreCleanStart
      ?? (chunk.overlap ? chunk.overlap.cleanEnd : chunk.cleanStart);
    const coreCleanEnd = chunk.coreCleanEnd ?? chunk.cleanEnd;
    const coreRaw = cleanToRaw(mapping, coreCleanStart, coreCleanEnd);
    const overlapRaw = chunk.overlap
      ? cleanToRaw(mapping, chunk.overlap.cleanStart, chunk.overlap.cleanEnd)
      : null;
    return {
      ...chunk,
      index,
      rawStart: rawSpan.start,
      rawEnd: rawSpan.end,
      coreCleanStart,
      coreCleanEnd,
      coreRawStart: coreRaw.start,
      coreRawEnd: coreRaw.end,
      overlap: overlapRaw
        ? { ...chunk.overlap, rawStart: overlapRaw.start, rawEnd: overlapRaw.end }
        : null,
    };
  });
}

/**
 * Analyze one document. When the previous analysis has the same cleaned text,
 * paragraph layout, and effectively equivalent chunking parameters, the chunk
 * windows are reused; the raw mapping is revalidated and remapped.
 */
export function analyzeDocument(raw, configInput, previous = null) {
  const shape = shapeDocument(raw, configInput);
  const decision = canReuseChunking(previous, shape);
  let chunks;
  if (decision.reuse) {
    chunks = remapReusedChunks(previous.chunks, shape.cleaned.mapping);
  } else {
    chunks = chunksForShape(shape);
  }
  const analysis = analysisOf(shape, chunks, shape.config);
  const changed = previous ? previous.chunkSignature !== analysis.chunkSignature : true;
  return {
    analysis,
    cleanText: shape.cleanText,
    chunkingReused: decision.reuse,
    reuseReason: decision.reason,
    changed,
    previousChunkCount: previous ? previous.chunks.length : 0,
  };
}

function estimateChunks(shape) {
  const config = shape.config;
  let total = 0;
  for (const paragraph of shape.paragraphs) {
    const count = paragraph.charCount;
    if (count <= config.maxChars) {
      total += 1;
      continue;
    }
    const step = config.maxChars - config.overlapChars;
    total += 1 + Math.ceil((count - config.maxChars) / step);
  }
  return total;
}

export function planDocument(raw, configInput, previous = null) {
  const shape = shapeDocument(raw, configInput);
  const decision = canReuseChunking(previous, shape);
  const longest = shape.paragraphs.reduce((max, p) => Math.max(max, p.charCount), 0);
  return {
    affected: !decision.reuse,
    reason: decision.reason,
    cleanHash: shape.cleaned.cleanHash,
    layoutHash: shape.layoutHash,
    paragraphs: shape.paragraphs.length,
    longestParagraphChars: longest,
    cleanLength: shape.cleaned.cleanLength,
    chunkingReused: decision.reuse,
    nextChunks: decision.reuse && previous ? previous.chunks.length : estimateChunks(shape),
    currentChunks: previous ? previous.chunks.length : 0,
  };
}

export function previewChunks(raw, configInput) {
  const shape = shapeDocument(raw, configInput);
  const chunks = chunksForShape(shape);
  return {
    cleanHash: shape.cleaned.cleanHash,
    layoutHash: shape.layoutHash,
    mappingChangedAtoms: shape.cleaned.mapping.changedCount,
    cleanText: shape.cleanText,
    rawLength: shape.cleaned.rawLength,
    cleanLength: shape.cleaned.cleanLength,
    atomCount: shape.cleaned.atomCount,
    paragraphs: shape.paragraphs,
    chunks,
  };
}
