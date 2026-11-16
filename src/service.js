import { randomUUID, createHash } from 'node:crypto';
import {
  DEFAULT_CONFIG,
  LIMITS,
  TextConfigError,
  analyzeDocument,
  planDocument,
  previewChunks,
  validateConfig,
  countGraphemes,
} from './text.js';

export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function requireString(value, label, { max = 10_000, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new AppError(400, 'INVALID_INPUT', `${label}必须是字符串`);
  if (!allowEmpty && value.trim().length === 0) {
    throw new AppError(400, 'INVALID_INPUT', `${label}不能为空`);
  }
  if (value.length > max) throw new AppError(400, 'INVALID_INPUT', `${label}过长（上限 ${max}）`);
  return value;
}

function normalizeName(value, fallback) {
  const name = typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
  if (name.length > 200) throw new AppError(400, 'INVALID_INPUT', '文档名过长（上限 200）');
  return name;
}

function safeRuleError(error) {
  if (error instanceof TextConfigError) {
    return new AppError(400, 'INVALID_CONFIG', error.message, { field: error.field });
  }
  throw error;
}

export class CorpusService {
  constructor(store, { readText = null } = {}) {
    this.store = store;
    this.readText = readText;
    this.ensureInitialRule();
  }

  ensureInitialRule() {
    if (this.store.latestRule()) return;
    const config = validateConfig(DEFAULT_CONFIG);
    this.store.createRule({
      id: id('rule'),
      version: 1,
      config,
      configKey: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
      note: '初始规则：空行分段 / NFC / LF',
    });
  }

  getDocumentOrThrow(documentId) {
    const document = this.store.getDocument(documentId);
    if (!document) throw new AppError(404, 'DOCUMENT_NOT_FOUND', '文档不存在或已删除');
    return document;
  }

  requireCurrentRevision(document) {
    if (!document.currentRevisionId) {
      throw new AppError(409, 'NOT_ANALYZED', '文档尚未按任何规则切分');
    }
    const revision = this.store.getRevision(document.currentRevisionId);
    if (!revision) throw new AppError(500, 'REVISION_MISSING', '当前版本数据缺失');
    return revision;
  }

  findByRawHash(rawHash) {
    const row = this.store.db.prepare('SELECT id FROM documents WHERE raw_hash = ? AND deleted_at IS NULL').get(rawHash);
    return row ? this.getDocumentOrThrow(row.id) : null;
  }

  createDocument({ name, content, fileName, ruleId, reuseIfIdentical = false }) {
    const provided = requireString(content, '文本内容', {
      max: LIMITS.maxTextUnits,
      allowEmpty: false,
    });
    // A leading BOM is an encoding artifact, not corpus text. Strip it once at
    // ingestion so offsets shown in the UI refer to the stored original.
    const bomStripped = provided.charCodeAt(0) === 0xfeff;
    const rawText = bomStripped ? provided.slice(1) : provided;
    if (rawText.trim().length === 0) {
      throw new AppError(400, 'INVALID_INPUT', '文本内容不能为空');
    }
    const finalName = normalizeName(name ?? fileName, '未命名文档');
    const rule = ruleId ? this.requireRule(ruleId) : this.store.latestRule();
    const documentId = id('doc');
    const rawHash = createHash('sha256').update(rawText, 'utf8').digest('hex');
    if (reuseIfIdentical) {
      const existing = this.findByRawHash(rawHash);
      if (existing) {
        return {
          document: existing,
          revision: existing.currentRevisionId
            ? this.revisionSummaryFor(existing.currentRevisionId)
            : null,
          reusedDocument: true,
        };
      }
    }
    const document = this.store.createDocument({
      id: documentId,
      name: finalName,
      rawText,
      rawHash,
      charCount: countGraphemes(rawText),
      byteCount: Buffer.byteLength(rawText, 'utf8'),
    });
    const revision = this.analyzeInto(documentId, rule, null);
    return {
      document: this.store.getDocument(documentId),
      revision: this.revisionSummary(revision),
      bomStripped,
    };
  }

  analyzeInto(documentId, rule, previousRevision) {
    const document = this.getDocumentOrThrow(documentId);
    // Chunk text is not duplicated inside revision snapshots; read windows and
    // text from the reference table when the reuse path needs them.
    const previous = previousRevision
      ? {
          cleanHash: previousRevision.analysis.cleanHash,
          layoutHash: previousRevision.analysis.layoutHash,
          maxChars: previousRevision.analysis.maxChars,
          overlapChars: previousRevision.analysis.overlapChars,
          chunks: this.store.listRefs(previousRevision.id).map((ref) => ({
            ...ref,
            index: ref.position,
            hash: ref.contentHash,
          })),
        }
      : null;
    let result;
    try {
      result = analyzeDocument(document.rawText, rule.config, previous);
    } catch (error) {
      throw safeRuleError(error);
    }
    const revisionId = id('rev');
    const analysisForStorage = {
      ...result.analysis,
      mapping: {
        changedCount: result.analysis.mapping.changedCount,
        changes: result.analysis.mapping.changes,
      },
    };
    this.store.saveRevision(documentId, rule.id, analysisForStorage, {
      id: revisionId,
      cleanText: result.cleanText,
      reused: result.chunkingReused,
      reuseReason: result.reuseReason,
    });
    this.store.setCurrentRevision(documentId, revisionId);
    return {
      id: revisionId,
      ruleId: rule.id,
      ruleVersion: rule.version,
      analysis: result.analysis,
      reused: result.chunkingReused,
      reuseReason: result.reuseReason,
      changed: result.changed,
      previousChunkCount: result.previousChunkCount,
    };
  }

  revisionSummaryFor(revisionId) {
    const revision = this.store.getRevision(revisionId);
    if (!revision) return null;
    return {
      id: revision.id,
      ruleId: revision.ruleId,
      ruleVersion: this.store.getRule(revision.ruleId)?.version ?? null,
      paragraphCount: revision.analysis.stats.paragraphs,
      chunkCount: revision.analysis.stats.chunks,
      cleanLength: revision.analysis.cleanLength,
      atomCount: revision.analysis.atomCount,
      changedAtoms: revision.analysis.stats.changedAtoms,
      overlapChars: revision.analysis.overlapChars,
      maxChars: revision.analysis.maxChars,
      reused: revision.reused,
      reuseReason: revision.reuseReason,
      changed: true,
      previousChunkCount: revision.analysis.chunks.length,
      stats: revision.analysis.stats,
    };
  }

  revisionSummary(revision) {
    return {
      id: revision.id,
      ruleId: revision.ruleId,
      ruleVersion: revision.ruleVersion,
      paragraphCount: revision.analysis.stats.paragraphs,
      chunkCount: revision.analysis.stats.chunks,
      cleanLength: revision.analysis.cleanLength,
      atomCount: revision.analysis.atomCount,
      changedAtoms: revision.analysis.stats.changedAtoms,
      overlapChars: revision.analysis.overlapChars,
      maxChars: revision.analysis.maxChars,
      reused: revision.reused,
      reuseReason: revision.reuseReason,
      changed: revision.changed,
      previousChunkCount: revision.previousChunkCount,
      stats: revision.analysis.stats,
    };
  }

  requireRule(ruleId) {
    const rule = this.store.getRule(ruleId);
    if (!rule) throw new AppError(404, 'RULE_NOT_FOUND', '规则不存在');
    return rule;
  }

  updateDocument(documentId, { name }) {
    this.getDocumentOrThrow(documentId);
    const finalName = normalizeName(name, null);
    if (!finalName) throw new AppError(400, 'INVALID_INPUT', '文档名不能为空');
    return this.store.renameDocument(documentId, finalName);
  }

  /** Re-read the document with the latest (or given) rule; old revisions remain. */
  reanalyze(documentId, { ruleId } = {}) {
    const document = this.getDocumentOrThrow(documentId);
    const rule = ruleId ? this.requireRule(ruleId) : this.store.latestRule();
    const previous = document.currentRevisionId
      ? this.store.getRevision(document.currentRevisionId)
      : null;
    const revision = this.analyzeInto(documentId, rule, previous);
    return this.revisionSummary(revision);
  }

  deleteDocument(documentId) {
    this.getDocumentOrThrow(documentId);
    const result = this.store.deleteDocument(documentId);
    return {
      deleted: true,
      documentId,
      chunksGarbageCollected: result.chunksGarbageCollected,
      stats: this.store.stats(),
    };
  }

  listDocuments() {
    return this.store.listDocuments();
  }

  documentDetail(documentId) {
    const document = this.getDocumentOrThrow(documentId);
    const current = document.currentRevisionId
      ? this.store.getRevision(document.currentRevisionId)
      : null;
    if (!current) {
      return {
        document,
        revision: null,
        chunks: [],
        paragraphs: [],
        mapping: null,
        rule: null,
        revisions: [],
        shared: {},
      };
    }
    const rule = this.store.getRule(current.ruleId);
    const chunks = this.store.listRefs(current.id);
    const sharedMap = this.store.sharedInfoForRevision(current.id);
    const repeats = this.store.localRepeatCounts(current.id);
    const shared = {};
    for (const chunk of chunks) {
      shared[chunk.contentHash] = {
        otherDocuments: sharedMap.get(chunk.contentHash) ?? [],
        localRepeats: repeats.get(chunk.contentHash) ?? 0,
      };
    }
    const { cleanText: _clean, mapping: _mapping, chunks: _chunks, ...analysis } = current.analysis;
    analysis.mapping = {
      changedCount: current.analysis.mapping.changedCount,
      changes: current.analysis.mapping.changes,
    };
    return {
      document,
      revision: {
        id: current.id,
        ruleVersion: rule.version,
        createdAt: current.createdAt,
        reused: current.reused,
        reuseReason: current.reuseReason,
        chunkSignature: current.chunkSignature,
      },
      rule,
      analysis,
      chunks,
      shared,
      revisions: this.store.listRevisions(documentId),
    };
  }

  documentRevision(documentId, revisionId = null) {
    const document = this.getDocumentOrThrow(documentId);
    const revision = revisionId
      ? this.store.getRevision(revisionId)
      : this.requireCurrentRevision(document);
    if (!revision || revision.documentId !== documentId) {
      throw new AppError(404, 'REVISION_NOT_FOUND', '版本不存在或不属于该文档');
    }
    const rule = this.store.getRule(revision.ruleId);
    const chunks = this.store.listRefs(revision.id);
    const sharedMap = this.store.sharedInfoForRevision(revision.id);
    const repeats = this.store.localRepeatCounts(revision.id);
    const shared = {};
    for (const chunk of chunks) {
      shared[chunk.contentHash] = {
        otherDocuments: sharedMap.get(chunk.contentHash) ?? [],
        localRepeats: repeats.get(chunk.contentHash) ?? 0,
      };
    }
    return {
      document: {
        id: document.id,
        name: document.name,
        rawText: document.rawText,
        charCount: document.charCount,
        byteCount: document.byteCount,
        isCurrent: document.currentRevisionId === revision.id,
      },
      revision: {
        id: revision.id,
        ruleVersion: rule.version,
        createdAt: revision.createdAt,
        reused: revision.reused,
        reuseReason: revision.reuseReason,
        chunkSignature: revision.chunkSignature,
      },
      rule,
      analysis: (() => {
        const { cleanText: _clean, mapping, chunks: _chunks, ...rest } = revision.analysis;
        return { ...rest, mapping: { changedCount: mapping.changedCount, changes: mapping.changes } };
      })(),
      chunks,
      shared,
    };
  }

  chunkDetail(documentId, revisionId, position) {
    const data = this.documentRevision(documentId, revisionId);
    const chunk = data.chunks.find((item) => item.position === position);
    if (!chunk) throw new AppError(404, 'CHUNK_NOT_FOUND', '片段不存在');
    const references = this.store.currentReferences(chunk.contentHash);
    return { chunk, references, document: data.document, revision: data.revision };
  }

  sharedChunk(contentHash) {
    const record = this.store.chunkRecord(contentHash);
    if (!record) throw new AppError(404, 'CHUNK_NOT_FOUND', '片段内容不存在');
    const references = this.store.currentReferences(contentHash);
    return {
      contentHash,
      text: record.text,
      charCount: Number(record.char_count),
      references,
      documentCount: new Set(references.map((ref) => ref.documentId)).size,
    };
  }

  previewRule(documentId, configInput) {
    const document = this.getDocumentOrThrow(documentId);
    let config;
    let preview;
    try {
      config = validateConfig(configInput);
      preview = previewChunks(document.rawText, config);
    } catch (error) {
      throw safeRuleError(error);
    }
    const current = document.currentRevisionId
      ? this.store.getRevision(document.currentRevisionId)
      : null;
    const plan = current
      ? planDocument(document.rawText, config, current.analysis)
      : { affected: true, reason: '文档尚未切分', chunkingReused: false };
    return {
      config,
      preview: {
        cleanHash: preview.cleanHash,
        layoutHash: preview.layoutHash,
        mappingChangedAtoms: preview.mappingChangedAtoms,
        cleanText: preview.cleanText,
        rawLength: preview.rawLength,
        cleanLength: preview.cleanLength,
        atomCount: preview.atomCount,
        paragraphs: preview.paragraphs,
        chunks: preview.chunks,
      },
      plan: {
        ...plan,
        currentChunks: current ? current.analysis.stats.chunks : 0,
        nextChunks: preview.chunks.length,
      },
    };
  }

  createRule(configInput, note = '') {
    let config;
    try {
      config = validateConfig(configInput);
    } catch (error) {
      throw safeRuleError(error);
    }
    const latest = this.store.latestRule();
    const configKey = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    if (latest && latest.configKey === configKey) {
      throw new AppError(409, 'RULE_UNCHANGED', `规则与 v${latest.version} 完全相同，未生成新版本`, {
        rule: latest,
      });
    }
    const rule = this.store.createRule({
      id: id('rule'),
      version: this.store.nextRuleVersion(),
      config,
      configKey,
      note: typeof note === 'string' ? note.slice(0, 500) : '',
    });
    return rule;
  }

  impact(ruleId) {
    const rule = this.requireRule(ruleId);
    const documents = this.store.listDocuments();
    const rows = [];
    for (const summary of documents) {
      const document = this.store.getDocument(summary.id);
      const current = document.currentRevisionId
        ? this.store.getRevision(document.currentRevisionId)
        : null;
      let plan;
      try {
        plan = planDocument(document.rawText, rule.config, current?.analysis ?? null);
      } catch (error) {
        throw safeRuleError(error);
      }
      rows.push({
        documentId: document.id,
        name: document.name,
        currentRuleVersion: current ? this.store.getRule(current.ruleId)?.version ?? null : null,
        currentChunks: current?.analysis.stats.chunks ?? 0,
        currentParagraphs: current?.analysis.stats.paragraphs ?? 0,
        ...plan,
      });
    }
    return {
      rule,
      rows,
      affected: rows.filter((row) => row.affected).length,
      unchanged: rows.filter((row) => !row.affected).length,
    };
  }

  /** Apply a saved rule to every document, reusing work where possible. */
  recalculate(ruleId, { documentIds = null } = {}) {
    const rule = this.requireRule(ruleId);
    const documents = this.store.listDocuments();
    const selected = documentIds
      ? documents.filter((doc) => documentIds.includes(doc.id))
      : documents;
    const jobId = id('job');
    this.store.createJob({ id: jobId, kind: 'recalculate', ruleId: rule.id, total: selected.length });
    const details = [];
    let done = 0;
    let skipped = 0;
    let failed = 0;
    const failedDocuments = [];
    const affectedDocuments = [];

    for (const summary of selected) {
      try {
        const document = this.getDocumentOrThrow(summary.id);
        const current = document.currentRevisionId
          ? this.store.getRevision(document.currentRevisionId)
          : null;
        const plan = planDocument(document.rawText, rule.config, current?.analysis ?? null);
        if (current && current.ruleId === rule.id) {
          skipped += 1;
          details.push({
            documentId: document.id,
            name: document.name,
            outcome: 'skipped',
            reason: '已按该规则切分',
          });
          continue;
        }
        // Unaffected documents still get a revision pinned to the new rule so
        // exports stay consistent, but their chunk windows are reused.
        const revision = this.analyzeInto(document.id, rule, current);
        if (!plan.affected) {
          skipped += 1;
          details.push({
            documentId: document.id,
            name: document.name,
            outcome: 'reused',
            reason: plan.reason,
            chunks: revision.analysis.stats.chunks,
            previousChunks: revision.previousChunkCount,
          });
          continue;
        }
        done += 1;
        affectedDocuments.push(document.id);
        details.push({
          documentId: document.id,
          name: document.name,
          outcome: revision.chunkingReused ? 'reused' : 'rechunked',
          reason: revision.reuseReason,
          chunks: revision.analysis.stats.chunks,
          previousChunks: revision.previousChunkCount,
        });
      } catch (error) {
        failed += 1;
        failedDocuments.push({ documentId: summary.id, name: summary.name, message: error.message });
        details.push({
          documentId: summary.id,
          name: summary.name,
          outcome: 'failed',
          reason: error.message,
        });
      }
      this.store.updateJob(jobId, { done, skipped, failed, details });
    }

    const status = failed > 0 ? (done === 0 && skipped === 0 ? 'failed' : 'partial') : 'succeeded';
    const job = this.store.updateJob(jobId, {
      status,
      done,
      skipped,
      failed,
      details: [...details, ...(failedDocuments.length ? [{ failures: failedDocuments }] : [])],
      finished_at: Date.now(),
    });
    return { job, affectedDocuments, failedDocuments };
  }

  /** Compare a document's current revision against another revision (usually an older one). */
  compareRevisions(documentId, leftId, rightId) {
    const left = this.documentRevision(documentId, leftId);
    const right = this.documentRevision(documentId, rightId);
    const leftByHash = new Map();
    for (const chunk of left.chunks) {
      if (!leftByHash.has(chunk.contentHash)) leftByHash.set(chunk.contentHash, []);
      leftByHash.get(chunk.contentHash).push(chunk.position);
    }
    const rightByHash = new Map();
    for (const chunk of right.chunks) {
      if (!rightByHash.has(chunk.contentHash)) rightByHash.set(chunk.contentHash, []);
      rightByHash.get(chunk.contentHash).push(chunk.position);
    }
    const added = [];
    const removed = [];
    const kept = [];
    for (const [hash, positions] of rightByHash) {
      if (leftByHash.has(hash)) {
        const chunk = right.chunks.find((c) => c.position === positions[0]);
        kept.push({
          hash,
          leftPositions: leftByHash.get(hash),
          rightPositions: positions,
          text: chunk.text,
          charCount: chunk.charCount,
          rawStart: chunk.rawStart,
          rawEnd: chunk.rawEnd,
        });
      } else {
        const chunk = right.chunks.find((c) => c.position === positions[0]);
        removed.push({ hash, positions, text: chunk.text, charCount: chunk.charCount, rawStart: chunk.rawStart, rawEnd: chunk.rawEnd });
      }
    }
    for (const [hash, positions] of leftByHash) {
      if (!rightByHash.has(hash)) {
        const chunk = left.chunks.find((c) => c.position === positions[0]);
        added.push({ hash, positions, text: chunk.text, charCount: chunk.charCount, rawStart: chunk.rawStart, rawEnd: chunk.rawEnd });
      }
    }
    const sameLayout = left.revision.chunkSignature === right.revision.chunkSignature;
    return {
      document: left.document,
      left: { ...left.revision, chunks: left.chunks.length },
      right: { ...right.revision, chunks: right.chunks.length },
      summary: {
        sameLayout,
        added: added.length,
        removed: removed.length,
        kept: kept.length,
        leftChunks: left.chunks.length,
        rightChunks: right.chunks.length,
        leftRuleVersion: left.revision.ruleVersion,
        rightRuleVersion: right.revision.ruleVersion,
      },
      added,
      removed,
      kept,
    };
  }

  /** Training manifest of the current revision of every live document. */
  exportManifest({ documentIds = null, includeText = true } = {}) {
    const documents = this.store.listDocuments().filter(
      (doc) => !documentIds || documentIds.includes(doc.id),
    );
    const chunks = [];
    const seen = new Map();
    for (const summary of documents) {
      if (!summary.currentRevisionId) continue;
      const revision = this.store.getRevision(summary.currentRevisionId);
      const refs = this.store.listRefs(revision.id);
      for (const ref of refs) {
        const key = `${summary.id}:${ref.position}`;
        if (seen.has(key)) continue;
        seen.set(key, true);
        chunks.push({
          id: key,
          documentId: summary.id,
          documentName: summary.name,
          revisionId: revision.id,
          ruleVersion: this.store.getRule(revision.ruleId)?.version ?? null,
          position: ref.position,
          paragraph: ref.paragraph,
          contentHash: ref.contentHash,
          charCount: ref.charCount,
          overlapChars: ref.overlapChars,
          rawStart: ref.rawStart,
          rawEnd: ref.rawEnd,
          ...(includeText ? { text: ref.text } : {}),
        });
      }
    }
    return {
      format: 'corpus-manifest/1',
      generatedAt: new Date().toISOString(),
      chunking: [...new Set(documents.map((doc) => doc.ruleVersion))],
      documentCount: documents.length,
      chunkCount: chunks.length,
      chunks,
    };
  }

}
