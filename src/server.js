import http from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { AppError, CorpusService } from './service.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AppError(413, 'BODY_TOO_LARGE', '请求体超过演示上限'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => {
      if (parts.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
      } catch {
        reject(new AppError(400, 'INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function routeMatch(path, pattern) {
  const names = [];
  const regex = new RegExp(
    `^${pattern.replace(/:[a-zA-Z]+/g, (token) => {
      names.push(token.slice(1));
      return '([^/]+)';
    })}$`,
  );
  const match = regex.exec(path);
  if (!match) return null;
  const params = {};
  for (let i = 0; i < names.length; i += 1) params[names[i]] = decodeURIComponent(match[i + 1]);
  return params;
}

async function serveStatic(req, res, pathname) {
  let filePath = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: { code: 'FORBIDDEN', message: '禁止访问' } });
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const content = await readFile(filePath);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': content.length,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(content);
  } catch {
    if (filePath.endsWith('index.html')) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '页面不存在' } });
      return;
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '资源不存在' } });
  }
}

export function createServer({ dbPath = ':memory:', seed = null } = {}) {
  const store = new Store(dbPath);
  const service = new CorpusService(store);
  if (seed) seed(service);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (!path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的方法' } });
        return;
      }
      await serveStatic(req, res, path);
      return;
    }

    try {
      let body = null;
      if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
        body = await readBody(req);
      }

      if (method === 'POST' && path === '/api/samples/load') {
        const sampleDir = join(__dirname, '..', 'samples');
        const names = (await readdir(sampleDir)).filter((name) => name.endsWith('.txt')).sort();
        const created = [];
        for (const name of names) {
          const content = await readFile(join(sampleDir, name), 'utf8');
          const result = service.createDocument({
            name: name.replace(/\.txt$/u, ''),
            content,
            reuseIfIdentical: true,
          });
          created.push({
            document: result.document,
            revision: result.revision,
            reused: Boolean(result.reusedDocument),
          });
        }
        sendJson(res, 201, { created });
        return;
      }

      if (method === 'GET' && path === '/api/state') {
        sendJson(res, 200, {
          documents: service.listDocuments(),
          rules: store.listRules(),
          jobs: store.latestJobs(),
          stats: store.stats(),
          limits: { maxTextUnits: 500_000 },
        });
        return;
      }

      if (method === 'GET' && path === '/api/rules') {
        sendJson(res, 200, { rules: store.listRules() });
        return;
      }

      if (method === 'POST' && path === '/api/rules') {
        const rule = service.createRule(body?.config ?? body, body?.note ?? '');
        sendJson(res, 201, { rule });
        return;
      }

      if (method === 'GET' && path === '/api/documents') {
        sendJson(res, 200, { documents: service.listDocuments() });
        return;
      }

      if (method === 'POST' && path === '/api/documents') {
        const result = service.createDocument(body ?? {});
        sendJson(res, 201, {
          document: result.document,
          revision: result.revision,
        });
        return;
      }

      let params = routeMatch(path, '/api/documents/:documentId');
      if (params) {
        const detail = service.documentDetail(params.documentId);
        if (method === 'GET') {
          sendJson(res, 200, detail);
          return;
        }
        if (method === 'PATCH') {
          sendJson(res, 200, { document: service.updateDocument(params.documentId, body ?? {}) });
          return;
        }
        if (method === 'DELETE') {
          sendJson(res, 200, service.deleteDocument(params.documentId));
          return;
        }
      }

      params = routeMatch(path, '/api/documents/:documentId/revisions');
      if (params && method === 'GET') {
        sendJson(res, 200, {
          revisions: store.listRevisions(params.documentId),
        });
        return;
      }

      params = routeMatch(path, '/api/documents/:documentId/reanalyze');
      if (params && method === 'POST') {
        sendJson(res, 201, {
          revision: service.reanalyze(params.documentId, body ?? {}),
        });
        return;
      }

      params = routeMatch(path, '/api/documents/:documentId/preview');
      if (params && method === 'POST') {
        sendJson(res, 200, service.previewRule(params.documentId, body?.config ?? body));
        return;
      }

      params = routeMatch(path, '/api/documents/:documentId/compare');
      if (params && method === 'GET') {
        const right = url.searchParams.get('right');
        const left = url.searchParams.get('left');
        if (!right || !left) {
          throw new AppError(400, 'INVALID_INPUT', '对比需要 left 与 right 两个版本号');
        }
        sendJson(res, 200, service.compareRevisions(params.documentId, left, right));
        return;
      }

      params = routeMatch(path, '/api/documents/:documentId/revisions/:revisionId');
      if (params && method === 'GET') {
        sendJson(res, 200, service.documentRevision(params.documentId, params.revisionId));
        return;
      }

      params = routeMatch(path, '/api/documents/:documentId/chunks/:revisionId/:position');
      if (params && method === 'GET') {
        sendJson(
          res,
          200,
          service.chunkDetail(params.documentId, params.revisionId, Number(params.position)),
        );
        return;
      }

      params = routeMatch(path, '/api/rules/:ruleId');
      if (params && method === 'GET') {
        sendJson(res, 200, { rule: service.requireRule(params.ruleId) });
        return;
      }

      params = routeMatch(path, '/api/rules/:ruleId/impact');
      if (params && method === 'GET') {
        sendJson(res, 200, service.impact(params.ruleId));
        return;
      }

      params = routeMatch(path, '/api/rules/:ruleId/recalculate');
      if (params && method === 'POST') {
        sendJson(res, 201, service.recalculate(params.ruleId, body ?? {}));
        return;
      }

      params = routeMatch(path, '/api/chunks/:hash');
      if (params && method === 'GET') {
        sendJson(res, 200, service.sharedChunk(params.hash));
        return;
      }

      if (method === 'GET' && path === '/api/export') {
        const ids = url.searchParams.getAll('documentId');
        sendJson(
          res,
          200,
          service.exportManifest({ documentIds: ids.length > 0 ? ids : null }),
        );
        return;
      }

      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
    } catch (error) {
      if (error instanceof AppError) {
        sendJson(res, error.status, {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
        });
        return;
      }
      console.error(error);
      sendJson(res, 500, {
        error: { code: 'INTERNAL', message: '服务内部错误', details: { message: error.message } },
      });
    }
  });

  server.on('close', () => store.close());
  return { server, store, service };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  const dbPath = process.env.DB_PATH ?? join(__dirname, '..', 'data', 'corpus.db');
  const { server } = createServer({ dbPath });
  server.listen(port, '127.0.0.1', () => {
    console.log(`语料工坊已启动：http://127.0.0.1:${port}`);
  });
}
