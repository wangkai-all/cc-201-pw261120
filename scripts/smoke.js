import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createServer } from '../src/server.js';

const dir = mkdtempSync(join(tmpdir(), 'corpus-smoke-'));
const { server } = createServer({ dbPath: join(dir, 'smoke.db') });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  assert.ok(response.ok, `${method} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

function log(step) {
  console.log(`✓ ${step}`);
}

try {
  const state = await call('/api/state');
  assert.equal(state.rules.length, 1);
  log('初始规则 v1 已创建');

  const samples = ['城市夜航.txt', '山间信笺.txt', '潮汐档案.txt'];
  for (const file of samples) {
    const raw = await readFile(new URL(`../samples/${file}`, import.meta.url), 'utf8');
    const created = await call('/api/documents', {
      method: 'POST',
      body: { name: file.replace(/\.txt$/u, ''), content: raw },
    });
    assert.ok(created.revision.chunkCount > 0);
    const detail = await call(`/api/documents/${created.document.id}`);
    for (const chunk of detail.chunks) {
      assert.ok(chunk.rawStart >= 0 && chunk.rawEnd <= raw.length);
      assert.ok(chunk.rawEnd > chunk.rawStart);
    }
  }
  log('三篇合成样例载入，全部片段坐标落在原文范围内');

  const exportAll = await call('/api/export');
  const duplicate = exportAll.chunks.find((chunk) => chunk.text.includes('潮汐退去以后'));
  const refs = await call(`/api/chunks/${duplicate.contentHash}`);
  assert.equal(refs.documentCount, 3);
  log('跨文档重复段落共享同一内容指纹，共 3 个来源');

  const rule = await call('/api/rules', {
    method: 'POST',
    body: {
      config: {
        paragraphMode: 'blank-line',
        paragraphRegex: '',
        maxChars: 80,
        overlapChars: 10,
        trimParagraphs: true,
        normalization: 'NFKC',
        newline: 'crlf',
      },
      note: '冒烟：窄窗口 + NFKC + CRLF',
    },
  });
  assert.equal(rule.rule.version, 2);
  log('规则 v2 已保存');

  const impact = await call(`/api/rules/${rule.rule.id}/impact`);
  assert.ok(impact.rows.length === 3);
  assert.ok(impact.affected > 0);
  log(`影响预演：${impact.affected} 个文档需要重切`);

  const run = await call(`/api/rules/${rule.rule.id}/recalculate`, {
    method: 'POST',
    body: {},
  });
  assert.equal(run.job.status, 'succeeded');
  log(`重算完成：重切 ${run.job.done}，复用 ${run.job.skipped}`);

  const again = await call(`/api/rules/${rule.rule.id}/recalculate`, {
    method: 'POST',
    body: {},
  });
  assert.equal(again.job.done, 0);
  assert.equal(again.job.skipped, 3);
  log('同一规则重复应用不会产生多余重切');

  const stateAfter = await call('/api/state');
  const exportV2 = await call('/api/export');
  const sharedV2 = exportV2.chunks.find((chunk) => chunk.text.includes('潮汐退去以后'));
  assert.ok(sharedV2, 'v2 切片中仍有共享段落');
  // The CRLF rewrite changes chunk text hashes, so look up the current hash.
  const target = stateAfter.documents.find((doc) => doc.name === '潮汐档案');
  const before = await call(`/api/chunks/${sharedV2.contentHash}`);
  assert.equal(before.documentCount, 3);
  await call(`/api/documents/${target.id}`, { method: 'DELETE' });
  const after = await call(`/api/chunks/${sharedV2.contentHash}`);
  assert.equal(after.documentCount, 2);
  assert.ok(after.documentCount >= 1);
  log('删除一个文档后，共享内容仍被其他文档引用');
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n冒烟测试通过');
