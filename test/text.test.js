import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  analyzeDocument,
  cleanToRaw,
  cleanWithMapping,
  countGraphemes,
  rawToClean,
  previewChunks,
  validateConfig,
} from '../src/text.js';

const base = { ...DEFAULT_CONFIG, maxChars: 20, overlapChars: 5 };

function graphemes(text) {
  return [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)].map(
    (entry) => entry.segment,
  );
}

test('every cleaned atom maps back to exactly one raw grapheme cluster', () => {
  const raw = 'é\r\n👍🏽👨‍👩‍👧‍👦각ﬁ½ \rA\n 🇨🇳';
  const cleaned = cleanWithMapping(raw, { ...base, normalization: 'NFC', newline: 'lf' });
  const rawAtoms = graphemes(raw);
  const cleanAtoms = graphemes(cleaned.cleanText);
  assert.equal(rawAtoms.length, cleaned.atomCount);
  assert.equal(cleanAtoms.length, cleaned.atomCount);
  assert.equal(cleaned.mapping.rawStarts.length, rawAtoms.length + 1);
  assert.equal(cleaned.mapping.cleanStarts.length, rawAtoms.length + 1);

  for (let i = 0; i < rawAtoms.length; i += 1) {
    const rawSlice = raw.slice(
      cleaned.mapping.rawStarts[i],
      cleaned.mapping.rawStarts[i + 1],
    );
    const cleanSlice = cleaned.cleanText.slice(
      cleaned.mapping.cleanStarts[i],
      cleaned.mapping.cleanStarts[i + 1],
    );
    assert.equal(rawSlice, rawAtoms[i]);
    const expected = /^(?:\r\n|[\r\n\u2028\u2029\u0085])$/.test(rawAtoms[i])
      ? '\n'
      : rawAtoms[i].normalize('NFC');
    assert.equal(cleanSlice, expected);
  }
  assert.equal(cleanToRaw(cleaned.mapping, 0, cleaned.cleanLength).end, raw.length);
  assert.equal(rawToClean(cleaned.mapping, 0, raw.length).end, cleaned.cleanLength);
});

test('normalisation that changes UTF-16 length still maps to the full raw range', () => {
  const raw = 'é';
  const nfc = cleanWithMapping(raw, { normalization: 'NFC', newline: 'keep' });
  assert.equal(nfc.cleanText, 'é');
  assert.equal(nfc.cleanLength, 1);
  assert.equal(nfc.rawLength, 2);
  const span = cleanToRaw(nfc.mapping, 0, 1);
  assert.deepEqual([span.start, span.end], [0, 2]);
  assert.equal(nfc.mapping.changedCount, 1);

  const nfkc = cleanWithMapping('½', { normalization: 'NFKC', newline: 'keep' });
  assert.equal(nfkc.cleanText, '1⁄2');
  assert.equal(cleanToRaw(nfkc.mapping, 0, nfkc.cleanLength).end, 1);

  const crlf = cleanWithMapping('a\r\nb', { normalization: 'none', newline: 'lf' });
  assert.equal(crlf.cleanText, 'a\nb');
  const second = cleanToRaw(crlf.mapping, 2, 3);
  assert.deepEqual([second.start, second.end], [3, 4]);
});

test('chunk boundaries never split grapheme clusters and stay within maxChars', () => {
  const raw = [
    '第一段包含组合字符 café 与家庭表情 👨‍👩‍👧‍👦，以及国旗 🇨🇳。',
    '',
    '第二段包含韩文 각 和兼容字符 ﬁ、Ⅳ，还有不同换行。',
  ].join('\r\n\r\n');
  const config = { ...base, maxChars: 12, overlapChars: 4 };
  const { chunks } = previewChunks(raw, config);
  assert.ok(chunks.length > 4);
  for (const chunk of chunks) {
    assert.ok(countGraphemes(chunk.text) <= config.maxChars);
    assert.equal(chunk.rawEnd - chunk.rawStart > 0, true);
    const rawSlice = raw.slice(chunk.rawStart, chunk.rawEnd);
    assert.ok(rawSlice.length > 0);
    assert.ok(!/^[\ud800-\udbff]$/.test(rawSlice[0]), 'must not start with lone high surrogate');
    assert.ok(!/\udc00-\udfff$/u.test(rawSlice), 'must not end with lone low surrogate');
    assert.equal(chunk.coreChars + chunk.overlapChars, chunk.charCount);
  }
  let sawOverlap = false;
  for (const chunk of chunks) {
    if (chunk.overlap === null) continue;
    sawOverlap = true;
    assert.equal(chunk.overlap.chars, config.overlapChars);
    assert.equal(
      raw.slice(chunk.overlap.rawStart, chunk.overlap.rawEnd),
      raw.slice(chunk.rawStart, chunk.rawStart + (chunk.overlap.rawEnd - chunk.overlap.rawStart)),
    );
  }
  assert.equal(sawOverlap, true);
});

test('overlap is copied from the previous window and core windows cover each paragraph once', () => {
  const raw = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const config = { ...base, paragraphMode: 'line', maxChars: 10, overlapChars: 3 };
  const { chunks } = previewChunks(raw, config);
  assert.deepEqual(
    chunks.map((c) => [c.coreCleanStart, c.coreCleanEnd, c.overlapChars]),
    [
      [0, 10, 0],
      [10, 17, 3],
      [17, 24, 3],
      [24, 31, 3],
      [31, 36, 3],
    ],
  );
  assert.equal(chunks[1].text, raw.slice(7, 17));
  for (let i = 1; i < chunks.length; i += 1) {
    const previous = chunks[i - 1];
    assert.equal(
      chunks[i].text.slice(0, chunks[i].overlapChars),
      previous.text.slice(-chunks[i].overlapChars),
    );
  }
  const covered = chunks.reduce((sum, c) => sum + c.coreChars, 0);
  assert.equal(covered, raw.length);
});

test('paragraph modes and trimming produce expected blocks and raw offsets', () => {
  const raw = '  alpha  \r\n\r\n beta\n gamma \r\ndelta';
  const byBlank = previewChunks(raw, {
    ...base,
    paragraphMode: 'blank-line',
    trimParagraphs: true,
    normalization: 'none',
    newline: 'keep',
    maxChars: 100,
  });
  assert.deepEqual(
    byBlank.chunks.map((c) => c.text),
    ['alpha', 'beta\n gamma \r\ndelta'],
  );
  assert.equal(raw.slice(byBlank.chunks[0].rawStart, byBlank.chunks[0].rawEnd), 'alpha');

  const byLine = previewChunks(raw, {
    ...base,
    paragraphMode: 'line',
    trimParagraphs: true,
    normalization: 'none',
    newline: 'keep',
    maxChars: 100,
  });
  assert.deepEqual(byLine.chunks.map((c) => c.text), ['alpha', 'beta', 'gamma', 'delta']);

  const byRegex = previewChunks(raw, {
    ...base,
    paragraphMode: 'regex',
    paragraphRegex: '\\s*\\r?\\n\\s*\\r?\\n\\s*',
    trimParagraphs: true,
    normalization: 'none',
    newline: 'keep',
    maxChars: 100,
  });
  assert.deepEqual(byRegex.chunks.map((c) => c.text), ['alpha', 'beta\n gamma \r\ndelta']);
});

test('long paragraphs with emoji split at atom boundaries and retain raw offsets', () => {
  const emoji = '👨‍👩‍👧‍👦';
  const raw = emoji.repeat(30);
  const config = { ...base, paragraphMode: 'line', maxChars: 8, overlapChars: 2 };
  const { chunks } = previewChunks(raw, config);
  for (const chunk of chunks) {
    assert.equal(chunk.charCount, countGraphemes(chunk.text));
    assert.ok(chunk.charCount <= 8);
    assert.equal(raw.slice(chunk.rawStart, chunk.rawEnd), chunk.text);
  }
  assert.equal(chunks[0].rawStart, 0);
  assert.equal(chunks.at(-1).rawEnd, raw.length);
});

test('reuse decisions distinguish no-op config changes from real re-chunking', () => {
  const raw = 'short one\n\nshort two';
  const first = analyzeDocument(raw, { ...base, maxChars: 100, overlapChars: 10 });
  const same = analyzeDocument(raw, { ...base, maxChars: 100, overlapChars: 10 }, first.analysis);
  assert.equal(same.chunkingReused, true);
  assert.equal(same.changed, false);

  const widthOnly = analyzeDocument(raw, { ...base, maxChars: 80, overlapChars: 10 }, first.analysis);
  assert.equal(widthOnly.chunkingReused, true);
  assert.equal(widthOnly.changed, false);

  const overlapOnly = analyzeDocument(raw, { ...base, maxChars: 100, overlapChars: 20 }, first.analysis);
  assert.equal(overlapOnly.chunkingReused, true);

  const longRaw = 'x'.repeat(100);
  const longFirst = analyzeDocument(longRaw, { ...base, maxChars: 50, overlapChars: 10 });
  const longChanged = analyzeDocument(longRaw, { ...base, maxChars: 40, overlapChars: 10 }, longFirst.analysis);
  assert.equal(longChanged.chunkingReused, false);
  assert.equal(longChanged.changed, true);
});

test('configuration validation rejects unsafe combinations', () => {
  assert.throws(() => validateConfig({ maxChars: 5 }), /最长块字符数/);
  assert.throws(() => validateConfig({ maxChars: 50, overlapChars: 100 }), /小于/);
  assert.throws(() => validateConfig({ paragraphMode: 'regex', paragraphRegex: '' }), /必须填写/);
  assert.throws(() => validateConfig({ paragraphMode: 'regex', paragraphRegex: '[' }), /正则无效/);
  assert.throws(() => validateConfig({ normalization: 'XYZ' }), /规范化/);
  assert.throws(
    () => previewChunks('a\n\nb', { ...base, paragraphMode: 'regex', paragraphRegex: '^' }),
    /空字符串/,
  );
});

test('regex separator that lands inside a grapheme cluster is rejected clearly', () => {
  assert.throws(
    () => previewChunks('éx', {
      ...base,
      paragraphMode: 'regex',
      paragraphRegex: 'e',
      normalization: 'none',
    }),
    /字素|段落/,
  );
});
