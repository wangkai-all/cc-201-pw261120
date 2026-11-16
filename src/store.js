import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  raw_hash TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  byte_count INTEGER NOT NULL,
  current_revision_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  config TEXT NOT NULL,
  config_key TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  rule_id TEXT NOT NULL REFERENCES rules(id),
  analysis TEXT NOT NULL,
  clean_text TEXT NOT NULL,
  chunk_signature TEXT NOT NULL,
  paragraph_count INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  overlap_chars INTEGER NOT NULL,
  reused INTEGER NOT NULL,
  reuse_reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS revisions_by_doc ON revisions(document_id, created_at);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS chunks_by_hash ON chunks(content_hash);

CREATE TABLE IF NOT EXISTS chunk_refs (
  revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  chunk_id TEXT NOT NULL REFERENCES chunks(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  paragraph INTEGER NOT NULL,
  clean_start INTEGER NOT NULL,
  clean_end INTEGER NOT NULL,
  raw_start INTEGER NOT NULL,
  raw_end INTEGER NOT NULL,
  core_chars INTEGER NOT NULL,
  overlap_chars INTEGER NOT NULL,
  overlap_clean_start INTEGER,
  overlap_clean_end INTEGER,
  overlap_raw_start INTEGER,
  overlap_raw_end INTEGER,
  PRIMARY KEY (revision_id, position)
);

CREATE INDEX IF NOT EXISTS refs_by_chunk ON chunk_refs(chunk_id);
CREATE INDEX IF NOT EXISTS refs_by_document ON chunk_refs(document_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  rule_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  details TEXT NOT NULL DEFAULT '{}'
);
`;

function now() {
  return Date.now();
}

export class Store {
  constructor(filename = ':memory:') {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createDocument({ id, name, rawText, rawHash, charCount, byteCount }) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO documents (id, name, raw_text, raw_hash, char_count, byte_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, rawText, rawHash, charCount, byteCount, ts, ts);
    return this.getDocument(id);
  }

  getDocument(id, { includeDeleted = false } = {}) {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!row) return null;
    if (row.deleted_at !== null && !includeDeleted) return null;
    return {
      id: row.id,
      name: row.name,
      rawText: row.raw_text,
      rawHash: row.raw_hash,
      charCount: row.char_count,
      byteCount: row.byte_count,
      currentRevisionId: row.current_revision_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    };
  }

  listDocuments() {
    return this.db
      .prepare(
        `SELECT d.*, r.chunk_count, r.paragraph_count, r.rule_id, r.created_at AS analyzed_at,
                ru.version AS rule_version
         FROM documents d
         LEFT JOIN revisions r ON r.id = d.current_revision_id
         LEFT JOIN rules ru ON ru.id = r.rule_id
         WHERE d.deleted_at IS NULL
         ORDER BY d.created_at DESC`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        charCount: row.char_count,
        byteCount: row.byte_count,
        rawHash: row.raw_hash,
        currentRevisionId: row.current_revision_id,
        chunkCount: row.chunk_count,
        paragraphCount: row.paragraph_count,
        ruleId: row.rule_id,
        ruleVersion: row.rule_version,
        analyzedAt: row.analyzed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  renameDocument(id, name) {
    this.db.prepare('UPDATE documents SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), id);
    return this.getDocument(id);
  }

  setCurrentRevision(documentId, revisionId) {
    this.db
      .prepare('UPDATE documents SET current_revision_id = ?, updated_at = ? WHERE id = ?')
      .run(revisionId, now(), documentId);
  }

  createRule({ id, version, config, configKey, note }) {
    this.db
      .prepare(
        'INSERT INTO rules (id, version, config, config_key, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, version, JSON.stringify(config), configKey, note, now());
    return this.getRule(id);
  }

  getRule(id) {
    const row = this.db.prepare('SELECT * FROM rules WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      version: row.version,
      config: JSON.parse(row.config),
      configKey: row.config_key,
      note: row.note,
      createdAt: row.created_at,
    };
  }

  nextRuleVersion() {
    const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM rules').get();
    return row.v;
  }

  listRules() {
    return this.db
      .prepare(
        `SELECT r.*, COUNT(rev.id) AS revision_count
         FROM rules r LEFT JOIN revisions rev ON rev.rule_id = r.id
         GROUP BY r.id ORDER BY r.version DESC`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        version: row.version,
        config: JSON.parse(row.config),
        configKey: row.config_key,
        note: row.note,
        revisionCount: row.revision_count,
        createdAt: row.created_at,
      }));
  }

  latestRule() {
    const row = this.db.prepare('SELECT id FROM rules ORDER BY version DESC LIMIT 1').get();
    return row ? this.getRule(row.id) : null;
  }

  /**
   * Persist one revision. Chunk content lives in the content-addressed chunks
   * table and is upserted; deleting one document drops only its own refs.
   */
  saveRevision(documentId, ruleId, analysis, meta) {
    const ts = now();
    return this.transaction(() => {
      const revisionId = meta.id;
      this.db
        .prepare(
          `INSERT INTO revisions
           (id, document_id, rule_id, analysis, clean_text, chunk_signature,
            paragraph_count, chunk_count, overlap_chars, reused, reuse_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revisionId,
          documentId,
          ruleId,
          // Chunk text lives once in the content-addressed chunks table.
          // The revision snapshot keeps windows and hashes only.
          JSON.stringify({
            ...analysis,
            chunks: analysis.chunks.map(({ text: _text, ...rest }) => rest),
          }),
          meta.cleanText,
          analysis.chunkSignature,
          analysis.stats.paragraphs,
          analysis.stats.chunks,
          analysis.overlapChars,
          meta.reused ? 1 : 0,
          meta.reuseReason,
          ts,
        );

      const upsertChunk = this.db.prepare(
        `INSERT INTO chunks (id, content_hash, text, char_count, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(content_hash) DO NOTHING`,
      );
      const chunkIdByHash = this.db.prepare('SELECT id FROM chunks WHERE content_hash = ?');
      const insertRef = this.db.prepare(
        `INSERT INTO chunk_refs
         (revision_id, position, chunk_id, document_id, paragraph, clean_start, clean_end,
          raw_start, raw_end, core_chars, overlap_chars,
          overlap_clean_start, overlap_clean_end, overlap_raw_start, overlap_raw_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      let paragraph = 0;
      for (const chunk of analysis.chunks) {
        upsertChunk.run(`chunk_${chunk.hash}`, chunk.hash, chunk.text, chunk.charCount, ts);
        const existing = chunkIdByHash.get(chunk.hash);
        if (!existing) throw new Error(`chunk upsert failed for ${chunk.hash}`);
        while (
          paragraph + 1 < analysis.paragraphs.length
          && chunk.cleanStart >= analysis.paragraphs[paragraph + 1].cleanStart
        ) {
          paragraph += 1;
        }
        insertRef.run(
          revisionId,
          chunk.index,
          existing.id,
          documentId,
          paragraph,
          chunk.cleanStart,
          chunk.cleanEnd,
          chunk.rawStart,
          chunk.rawEnd,
          chunk.coreChars,
          chunk.overlapChars,
          chunk.overlap ? chunk.overlap.cleanStart : null,
          chunk.overlap ? chunk.overlap.cleanEnd : null,
          chunk.overlap ? chunk.overlap.rawStart : null,
          chunk.overlap ? chunk.overlap.rawEnd : null,
        );
      }
      return revisionId;
    });
  }

  getRevision(id) {
    const row = this.db.prepare('SELECT * FROM revisions WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      documentId: row.document_id,
      ruleId: row.rule_id,
      analysis: JSON.parse(row.analysis),
      cleanText: row.clean_text,
      chunkSignature: row.chunk_signature,
      paragraphCount: row.paragraph_count,
      chunkCount: row.chunk_count,
      overlapChars: row.overlap_chars,
      reused: Boolean(row.reused),
      reuseReason: row.reuse_reason,
      createdAt: row.created_at,
    };
  }

  listRevisions(documentId, { limit = 50 } = {}) {
    return this.db
      .prepare(
        `SELECT rev.*, ru.version AS rule_version
         FROM revisions rev JOIN rules ru ON ru.id = rev.rule_id
         WHERE rev.document_id = ?
         ORDER BY rev.created_at DESC, rev.rowid DESC LIMIT ?`,
      )
      .all(documentId, limit)
      .map((row) => ({
        id: row.id,
        ruleId: row.rule_id,
        ruleVersion: row.rule_version,
        chunkCount: row.chunk_count,
        paragraphCount: row.paragraph_count,
        chunkSignature: row.chunk_signature,
        overlapChars: row.overlap_chars,
        reused: Boolean(row.reused),
        reuseReason: row.reuse_reason,
        createdAt: row.created_at,
      }));
  }

  listRefs(revisionId) {
    return this.db
      .prepare(
        `SELECT cr.*, c.content_hash, c.text, c.char_count AS chunk_char_count
         FROM chunk_refs cr JOIN chunks c ON c.id = cr.chunk_id
         WHERE cr.revision_id = ? ORDER BY cr.position`,
      )
      .all(revisionId)
      .map((row) => ({
        chunkId: row.chunk_id,
        contentHash: row.content_hash,
        position: row.position,
        paragraph: row.paragraph,
        text: row.text,
        charCount: Number(row.chunk_char_count),
        cleanStart: row.clean_start,
        cleanEnd: row.clean_end,
        rawStart: row.raw_start,
        rawEnd: row.raw_end,
        coreCleanStart: row.overlap_chars > 0 ? row.overlap_clean_end : row.clean_start,
        coreCleanEnd: row.clean_end,
        coreChars: row.core_chars,
        overlapChars: row.overlap_chars,
        overlap: row.overlap_chars > 0
          ? {
              cleanStart: row.overlap_clean_start,
              cleanEnd: row.overlap_clean_end,
              rawStart: row.overlap_raw_start,
              rawEnd: row.overlap_raw_end,
              chars: row.overlap_chars,
            }
          : null,
      }));
  }

  /** Other live documents whose current revision references the same content. */
  sharedInfoForRevision(revisionId) {
    const rows = this.db
      .prepare(
        `SELECT c.content_hash AS contentHash, d.id AS documentId, d.name AS documentName,
                rev.id AS revisionId, cr.position
         FROM chunk_refs base
         JOIN chunks c ON c.id = base.chunk_id
         JOIN chunk_refs cr ON cr.chunk_id = base.chunk_id AND cr.revision_id <> base.revision_id
         JOIN revisions rev ON rev.id = cr.revision_id
         JOIN documents d ON d.id = cr.document_id
         WHERE base.revision_id = ? AND d.id <> base.document_id
           AND d.deleted_at IS NULL AND d.current_revision_id = rev.id
         ORDER BY d.name, cr.position`,
      )
      .all(revisionId);
    const map = new Map();
    for (const row of rows) {
      const list = map.get(row.contentHash) ?? [];
      let entry = list.find((item) => item.documentId === row.documentId);
      if (!entry) {
        entry = {
          documentId: row.documentId,
          documentName: row.documentName,
          revisionId: row.revisionId,
          positions: [],
        };
        list.push(entry);
      }
      entry.positions.push(row.position);
      map.set(row.contentHash, list);
    }
    return map;
  }

  localRepeatCounts(revisionId) {
    const rows = this.db
      .prepare(
        `SELECT c.content_hash AS hash, COUNT(*) AS n
         FROM chunk_refs cr JOIN chunks c ON c.id = cr.chunk_id
         WHERE cr.revision_id = ? GROUP BY c.content_hash`,
      )
      .all(revisionId);
    return new Map(rows.map((row) => [row.hash, Number(row.n)]));
  }

  /** All current-revision refs to a content hash across live documents. */
  currentReferences(contentHash) {
    return this.db
      .prepare(
        `SELECT d.id AS documentId, d.name AS documentName, rev.id AS revisionId,
                rev.rule_id AS ruleId, cr.position
         FROM chunks c
         JOIN chunk_refs cr ON cr.chunk_id = c.id
         JOIN revisions rev ON rev.id = cr.revision_id
         JOIN documents d ON d.id = cr.document_id
         WHERE c.content_hash = ? AND d.deleted_at IS NULL
           AND d.current_revision_id = rev.id
         ORDER BY d.name, cr.position`,
      )
      .all(contentHash)
      .map((row) => ({
        documentId: row.documentId,
        documentName: row.documentName,
        revisionId: row.revisionId,
        ruleId: row.ruleId,
        position: row.position,
      }));
  }

  /**
   * Soft-delete a document, purge only its own revisions/refs, then garbage
   * collect chunk content that no remaining ref points at. Shared chunks and
   * their refs in other documents are untouched.
   */
  deleteDocument(documentId) {
    return this.transaction(() => {
      const document = this.getDocument(documentId);
      if (!document) return null;
      this.db.prepare('DELETE FROM chunk_refs WHERE document_id = ?').run(documentId);
      this.db.prepare('DELETE FROM revisions WHERE document_id = ?').run(documentId);
      this.db
        .prepare('UPDATE documents SET deleted_at = ?, current_revision_id = NULL WHERE id = ?')
        .run(now(), documentId);
      const gc = this.db
        .prepare('DELETE FROM chunks WHERE NOT EXISTS (SELECT 1 FROM chunk_refs WHERE chunk_id = chunks.id)')
        .run();
      return { document, chunksGarbageCollected: Number(gc.changes) };
    });
  }

  orphanChunkCount() {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM chunk_refs r WHERE r.chunk_id = c.id)')
      .get();
    return Number(row.n);
  }

  chunkRecord(contentHash) {
    return this.db.prepare('SELECT * FROM chunks WHERE content_hash = ?').get(contentHash) ?? null;
  }

  /** Highest rule version currently used by each live document's current revision. */
  currentRevisionFor(documentId) {
    const doc = this.getDocument(documentId);
    return doc?.currentRevisionId ? this.getRevision(doc.currentRevisionId) : null;
  }

  createJob({ id, kind, ruleId, total }) {
    this.db
      .prepare('INSERT INTO jobs (id, kind, rule_id, status, created_at, total) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, kind, ruleId, 'running', now(), total);
    return this.getJob(id);
  }

  updateJob(id, fields) {
    const allowed = ['status', 'done', 'skipped', 'failed', 'details', 'finished_at'];
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!allowed.includes(key)) continue;
      sets.push(`${key} = ?`);
      values.push(key === 'details' ? JSON.stringify(value) : value);
    }
    if (sets.length === 0) return this.getJob(id);
    values.push(id);
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getJob(id);
  }

  getJob(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      ruleId: row.rule_id,
      status: row.status,
      total: row.total,
      done: row.done,
      skipped: row.skipped,
      failed: row.failed,
      details: JSON.parse(row.details),
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    };
  }

  latestJobs(limit = 20) {
    return this.db
      .prepare(
        `SELECT j.*, ru.version AS rule_version FROM jobs j
         LEFT JOIN rules ru ON ru.id = j.rule_id
         ORDER BY j.created_at DESC, j.rowid DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        ruleId: row.rule_id,
        ruleVersion: row.rule_version,
        status: row.status,
        total: row.total,
        done: row.done,
        skipped: row.skipped,
        failed: row.failed,
        details: JSON.parse(row.details),
        createdAt: row.created_at,
        finishedAt: row.finished_at,
      }));
  }

  stats() {
    const docs = this.db
      .prepare('SELECT COUNT(*) AS docs FROM documents WHERE deleted_at IS NULL')
      .get();
    const chunks = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get();
    const refs = this.db.prepare('SELECT COUNT(*) AS n FROM chunk_refs').get();
    const revisions = this.db.prepare('SELECT COUNT(*) AS n FROM revisions').get();
    const shared = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT c.id FROM chunks c JOIN chunk_refs r ON r.chunk_id = c.id
           GROUP BY c.id HAVING COUNT(DISTINCT r.document_id) > 1
         )`,
      )
      .get();
    return {
      documents: Number(docs.docs),
      chunkContents: Number(chunks.n),
      references: Number(refs.n),
      revisions: Number(revisions.n),
      sharedChunks: Number(shared.n),
    };
  }
}
