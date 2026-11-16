import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { CorpusService, AppError } from '../src/service.js';
import { DEFAULT_CONFIG, cleanWithMapping } from '../src/text.js';

function makeService() {
  const store = new Store(':memory:');
  const service = new CorpusService(store);
  return { store, service };
}

const sharedParagraph = '潮汐退去以后，礁石缝里留下许多细小的水洼，水洼里映着还没熄的路灯，也映着早班清洁工推车经过的影子。';

function seed(service) {
  const a = service.createDocument({
    name: '甲',
    content: `第一段甲。\n\n${sharedParagraph}\n\n第三段甲。`,
  });
  const b = service.createDocument({
    name: '乙',
    content: `第一段乙。\n\n${sharedParagraph}\n\n第三段乙。`,
  });
  return { a, b };
}

test('identical chunk text is stored once and shared across documents', () => {
  const { service, store } = makeService();
  const { a, b } = seed(service);
  const detailA = service.documentDetail(a.document.id);
  const detailB = service.documentDetail(b.document.id);
  const sharedA = detailA.chunks.find((chunk) => chunk.text.includes('潮汐退去'));
  const sharedB = detailB.chunks.find((chunk) => chunk.text.includes('潮汐退去'));
  assert.equal(sharedA.contentHash, sharedB.contentHash);
  assert.equal(sharedA.chunkId, sharedB.chunkId);

  const computed = service.sharedChunk(sharedA.contentHash);
  assert.equal(computed.documentCount, 2);
  assert.deepEqual(
    computed.references.map((ref) => ref.documentName).sort(),
    ['乙', '甲'],
  );
  assert.equal(store.orphanChunkCount(), 0);
});

test('deleting one document keeps shared chunk content and the other document intact', () => {
  const { service, store } = makeService();
  const { a, b } = seed(service);
  const hash = service
    .documentDetail(a.document.id)
    .chunks.find((chunk) => chunk.text.includes('潮汐退去')).contentHash;

  const result = service.deleteDocument(a.document.id);
  assert.equal(result.deleted, true);
  assert.ok(result.chunksGarbageCollected >= 0, 'only private chunks may be collected');
  assert.notEqual(store.chunkRecord(hash), null);
  const detailB = service.documentDetail(b.document.id);
  assert.equal(detailB.chunks.find((chunk) => chunk.text.includes('潮汐退去')).contentHash, hash);
  assert.equal(service.sharedChunk(hash).documentCount, 1);
  assert.throws(() => service.documentDetail(a.document.id), (error) => error.status === 404);
  assert.equal(store.chunkRecord(hash) !== null, true);
});

test('deleting the last document removes its private chunks but not other documents', () => {
  const { service, store } = makeService();
  const { a, b } = seed(service);
  const hash = service
    .documentDetail(a.document.id)
    .chunks.find((chunk) => chunk.text.includes('潮汐退去')).contentHash;
  service.deleteDocument(b.document.id);
  assert.equal(service.sharedChunk(hash).documentCount, 1);
  const before = store.stats().chunkContents;
  const result = service.deleteDocument(a.document.id);
  assert.equal(result.chunksGarbageCollected, before);
  assert.equal(store.stats().chunkContents, 0);
  assert.equal(store.orphanChunkCount(), 0);
});

test('rule versions compare chunk changes and avoid re-chunking unaffected documents', () => {
  const { service, store } = makeService();
  const short = service.createDocument({
    name: '短文档',
    content: '第一段很短。\n\n第二段也很短。',
  });
  const long = service.createDocument({
    name: '长文档',
    content: `${'很长的句子。'.repeat(40)}\n\n${'另一个长段落。'.repeat(30)}`,
  });

  const ruleV2 = service.createRule(
    { ...DEFAULT_CONFIG, maxChars: 120, overlapChars: 12 },
    '缩小块长',
  );
  assert.equal(ruleV2.version, 2);
  const impact = service.impact(ruleV2.id);
  const byName = Object.fromEntries(impact.rows.map((row) => [row.name, row]));
  assert.equal(byName['短文档'].affected, false);
  assert.equal(byName['长文档'].affected, true);

  const run = service.recalculate(ruleV2.id);
  assert.equal(run.job.status, 'succeeded');
  assert.equal(run.job.skipped, 1);
  assert.equal(run.job.done, 1);

  const shortDetail = service.documentDetail(short.document.id);
  const longDetail = service.documentDetail(long.document.id);
  assert.equal(shortDetail.revision.ruleVersion, 2);
  assert.equal(shortDetail.revision.reused, true);
  assert.equal(longDetail.revision.reused, false);
  assert.ok(longDetail.chunks.length > 2);

  const history = store.listRevisions(short.document.id);
  const v1 = history.find((rev) => rev.ruleVersion === 1);
  const compare = service.compareRevisions(short.document.id, shortDetail.revision.id, v1.id);
  assert.equal(compare.summary.sameLayout, true);
  assert.equal(compare.summary.added, 0);
  assert.equal(compare.summary.removed, 0);
  assert.equal(compare.summary.kept, shortDetail.chunks.length);
  for (const item of compare.kept) {
    assert.equal(typeof item.rawStart, 'number');
    assert.equal(typeof item.rawEnd, 'number');
    assert.ok(item.charCount > 0);
    assert.ok(item.leftPositions.length > 0 && item.rightPositions.length > 0);
  }
});

test('changing overlap produces new revisions and a meaningful diff', () => {
  const { service } = makeService();
  const document = service.createDocument({
    name: '长段落',
    content: '甲乙丙丁戊己庚辛壬癸'.repeat(30),
  });
  const v1 = service.documentDetail(document.document.id).revision;
  const rule = service.createRule({ ...DEFAULT_CONFIG, maxChars: 60, overlapChars: 20 }, '增加重叠');
  service.recalculate(rule.id);
  const detail = service.documentDetail(document.document.id);
  const compare = service.compareRevisions(document.document.id, detail.revision.id, v1.id);
  assert.equal(compare.summary.sameLayout, false);
  assert.equal(compare.summary.leftRuleVersion, 2);
  assert.equal(compare.summary.rightRuleVersion, 1);
  assert.ok(compare.summary.added > 0 || compare.summary.removed > 0);
  assert.ok(detail.chunks.some((chunk) => chunk.overlapChars === 20));
});

test('unchanged rule cannot be saved twice', () => {
  const { service } = makeService();
  assert.throws(
    () => service.createRule({ ...DEFAULT_CONFIG }),
    (error) => error instanceof AppError && error.code === 'RULE_UNCHANGED',
  );
});

test('preview returns mapped chunks for a candidate rule without saving', () => {
  const { service, store } = makeService();
  const document = service.createDocument({
    name: '预览',
    content: 'é 表情 👨‍👩‍👧‍👦\r\n\r\n第二段内容在这里。',
  });
  const rulesBefore = store.listRules().length;
  const raw = document.document.rawText;
  const preview = service.previewRule(document.document.id, {
    ...DEFAULT_CONFIG,
    maxChars: 8,
    overlapChars: 2,
  });
  assert.equal(store.listRules().length, rulesBefore);
  assert.equal(preview.preview.rawLength > preview.preview.cleanLength, true);
  assert.equal(preview.plan.nextChunks, preview.preview.chunks.length);
  for (const chunk of preview.preview.chunks) {
    const mapped = cleanWithMapping(raw.slice(chunk.rawStart, chunk.rawEnd), preview.config);
    assert.equal(mapped.cleanText, chunk.text, 'chunk maps to the exact raw slice');
  }
});

test('export manifest lists chunks of current revisions with corpus coordinates', () => {
  const { service } = makeService();
  seed(service);
  const manifest = service.exportManifest();
  assert.equal(manifest.documentCount, 2);
  assert.ok(manifest.chunkCount >= 6);
  for (const chunk of manifest.chunks) {
    assert.equal(typeof chunk.rawStart, 'number');
    assert.equal(typeof chunk.rawEnd, 'number');
    assert.ok(chunk.text.length > 0);
  }
  const withoutText = service.exportManifest({ includeText: false });
  assert.equal(Object.hasOwn(withoutText.chunks[0], 'text'), false);
});

test('sample files use mixed newlines and load with exact offsets', () => {
  const { service } = makeService();
  const files = ['城市夜航.txt', '山间信笺.txt', '潮汐档案.txt'];
  for (const file of files) {
    const raw = readFileSync(new URL(`../samples/${file}`, import.meta.url), 'utf8');
    const created = service.createDocument({ name: file, content: raw });
    const detail = service.documentDetail(created.document.id);
    assert.ok(detail.chunks.length > 0);
    for (const chunk of detail.chunks) {
      const mapped = cleanWithMapping(raw.slice(chunk.rawStart, chunk.rawEnd), detail.rule.config);
      assert.equal(
        mapped.cleanText,
        chunk.text,
        `${file} chunk ${chunk.position} must clean back to its mapped raw slice`,
      );
    }
  }
  const manifest = service.exportManifest();
  const repeated = manifest.chunks.filter((chunk) => chunk.text.includes('潮汐退去以后'));
  assert.ok(repeated.length >= 2, 'samples contain cross-document duplicate paragraphs');
});
