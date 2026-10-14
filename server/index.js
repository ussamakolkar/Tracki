#!/usr/bin/env node
'use strict';
/**
 * Tracki - local-first job application tracker.
 *
 * Runs a small HTTP server bound to localhost. It serves the tracker UI, the
 * JSON API, the Excel/CSV export, and the intake endpoint that Parsable CV
 * calls when you save a CV.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { loadConfig, saveConfig, ROOT } = require('./config');
const { Store } = require('./store');
const { CvWatcher } = require('./watcher');
const { buildJob, computeStats, findDuplicate } = require('./jobs');
const { buildPending } = require('./cv-intake');
const { exportXlsx, exportCsv, exportFilename } = require('./export');
const schema = require('./schema');

const config = loadConfig();
const store = new Store(config.dataDir);
store.load();

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PUBLIC_DIR = path.join(ROOT, 'public');
const INTEGRATION_DIR = path.join(ROOT, 'integration');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- live updates
const sseClients = new Set();

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

// -------------------------------------------------------------------- watching
const watcher = new CvWatcher(store, {
  onQueued: (entry) => broadcast('pending', { id: entry.id, suggestion: entry.suggestion }),
});

function currentCvPath() {
  return store.getSettings().parsableCvPath || config.parsableCvPath || '';
}

function watchEnabled() {
  const settings = store.getSettings();
  return settings.watchParsableCv === undefined ? config.watchParsableCv : Boolean(settings.watchParsableCv);
}

function syncWatcher() {
  if (watchEnabled() && currentCvPath()) watcher.start(currentCvPath());
  else watcher.stop();
  return watcher.status;
}

/** Once a CV's job is on the tracker, drop any prompt still waiting for it. */
function clearPromptsForCv(cvFilePath) {
  if (!cvFilePath) return;
  for (const entry of store.listPending().filter((item) => item.cvFilePath === cvFilePath)) {
    store.removePending(entry.id);
    broadcast('pending-cleared', { id: entry.id });
  }
}

// ------------------------------------------------------------------ http utils
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, payload, headers = {}) {
  send(res, status, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

/**
 * Only local pages (and explicitly allowed origins) may talk to the API.
 * Without this, any website you happened to have open could post to localhost.
 */
function isAllowedOrigin(origin) {
  if (!origin || origin === 'null') return true; // same-origin fetch or file:// page
  try {
    const { hostname } = new URL(origin);
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) return true;
  } catch {
    return false;
  }
  return (config.allowedOrigins || []).includes(origin);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin && origin !== 'null' ? origin : '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Body must be valid JSON'), { status: 400 });
  }
}

function serveStatic(res, baseDir, relativePath, fallback) {
  const target = path.resolve(baseDir, `.${path.posix.normalize(`/${relativePath || ''}`)}`);
  // Never serve outside the intended directory.
  if (!target.startsWith(path.resolve(baseDir))) return send(res, 403, 'Forbidden');
  const file = fs.existsSync(target) && fs.statSync(target).isFile() ? target : fallback;
  if (!file || !fs.existsSync(file)) return send(res, 404, 'Not found');
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  send(res, 200, fs.readFileSync(file), { 'Content-Type': type });
}

// -------------------------------------------------------------------- querying
function filterJobs(jobs, params) {
  const query = (params.get('q') || '').trim().toLowerCase();
  const status = params.get('status') || '';
  const company = (params.get('company') || '').trim().toLowerCase();
  const tag = (params.get('tag') || '').trim().toLowerCase();

  let result = jobs;
  if (status && status !== 'all') {
    if (status === 'open') result = result.filter((job) => !schema.CLOSED_STATUSES.includes(job.status));
    else result = result.filter((job) => job.status === status);
  }
  if (company) result = result.filter((job) => String(job.company || '').toLowerCase().includes(company));
  if (tag) result = result.filter((job) => (job.tags || []).some((t) => String(t).toLowerCase() === tag));
  if (query) {
    result = result.filter((job) =>
      ['role', 'company', 'location', 'notes', 'nextAction', 'contactName', 'referral', 'cvVersion']
        .map((key) => String(job[key] || ''))
        .concat((job.tags || []).join(' '))
        .join(' ')
        .toLowerCase()
        .includes(query)
    );
  }

  const sortKey = params.get('sort') || 'updatedAt';
  const direction = params.get('dir') === 'asc' ? 1 : -1;
  // Priority and status are ranked by meaning, not alphabetically.
  const ranks = {
    priority: new Map(schema.PRIORITIES.map((value, i) => [value, i])),
    status: new Map(schema.STATUSES.map((value, i) => [value, i])),
  };
  return [...result].sort((a, b) => {
    if (ranks[sortKey]) {
      const delta = (ranks[sortKey].get(a[sortKey]) ?? 99) - (ranks[sortKey].get(b[sortKey]) ?? 99);
      if (delta) return delta * direction;
      return String(a.company).localeCompare(String(b.company));
    }
    const av = a[sortKey] ?? '';
    const bv = b[sortKey] ?? '';
    // Blank dates and follow-ups sort last, never ahead of real ones.
    if (av === '' && bv !== '') return 1;
    if (bv === '' && av !== '') return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * direction;
    return String(av).localeCompare(String(bv), undefined, { numeric: true }) * direction;
  });
}

// ---------------------------------------------------------------------- routes
async function handleApi(req, res, url) {
  const { pathname } = url;
  const segments = pathname.split('/').filter(Boolean); // ['api', ...]
  const route = segments.slice(1);
  const method = req.method;

  // --- metadata
  if (route[0] === 'ping' && method === 'GET') {
    return sendJson(res, 200, { app: 'tracki', version: 1, jobs: store.listJobs().length });
  }
  if (route[0] === 'schema' && method === 'GET') {
    return sendJson(res, 200, {
      fields: schema.FIELDS,
      meta: schema.META_FIELDS,
      statuses: schema.STATUSES,
      closedStatuses: schema.CLOSED_STATUSES,
      respondedStatuses: schema.RESPONDED_STATUSES,
      priorities: schema.PRIORITIES,
      sources: schema.SOURCES,
      workModes: schema.WORK_MODES,
      employmentTypes: schema.EMPLOYMENT_TYPES,
    });
  }

  // --- jobs
  if (route[0] === 'jobs' && route.length === 1 && method === 'GET') {
    const jobs = filterJobs(store.listJobs(), url.searchParams);
    return sendJson(res, 200, { jobs, stats: computeStats(store.listJobs()), total: store.listJobs().length });
  }
  if (route[0] === 'jobs' && route.length === 1 && method === 'POST') {
    const body = await readJsonBody(req);
    const { job, errors } = buildJob(body);
    if (errors.length) return sendJson(res, 400, { errors });
    const duplicate = findDuplicate(store.listJobs(), job);
    if (duplicate && !body.allowDuplicate) {
      return sendJson(res, 409, {
        errors: [`Looks like a duplicate of "${duplicate.role} at ${duplicate.company}"`],
        duplicateId: duplicate.id,
      });
    }
    store.addJob(job);
    broadcast('jobs', { reason: 'created', id: job.id });
    return sendJson(res, 201, { job });
  }
  if (route[0] === 'jobs' && route.length === 2 && method === 'GET') {
    const job = store.getJob(route[1]);
    return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { errors: ['Job not found'] });
  }
  if (route[0] === 'jobs' && route.length === 2 && (method === 'PUT' || method === 'PATCH')) {
    const existing = store.getJob(route[1]);
    if (!existing) return sendJson(res, 404, { errors: ['Job not found'] });
    const body = await readJsonBody(req);
    const { job, errors } = buildJob(body, existing);
    if (errors.length) return sendJson(res, 400, { errors });
    store.replaceJob(existing.id, job);
    broadcast('jobs', { reason: 'updated', id: job.id });
    return sendJson(res, 200, { job });
  }
  if (route[0] === 'jobs' && route.length === 3 && route[2] === 'status' && method === 'POST') {
    const existing = store.getJob(route[1]);
    if (!existing) return sendJson(res, 404, { errors: ['Job not found'] });
    const body = await readJsonBody(req);
    const { job, errors } = buildJob({ status: body.status }, existing);
    if (errors.length) return sendJson(res, 400, { errors });
    if (body.note && job.history.length) job.history[job.history.length - 1].note = String(body.note).slice(0, 500);
    store.replaceJob(existing.id, job);
    broadcast('jobs', { reason: 'status', id: job.id });
    return sendJson(res, 200, { job });
  }
  if (route[0] === 'jobs' && route.length === 2 && method === 'DELETE') {
    const removed = store.deleteJob(route[1]);
    if (!removed) return sendJson(res, 404, { errors: ['Job not found'] });
    broadcast('jobs', { reason: 'deleted', id: route[1] });
    return sendJson(res, 200, { ok: true });
  }

  // --- export / import
  if (route[0] === 'export.xlsx' && method === 'GET') {
    const jobs = filterJobs(store.listJobs(), url.searchParams);
    const buffer = exportXlsx(url.searchParams.get('scope') === 'filtered' ? jobs : store.listJobs());
    return send(res, 200, buffer, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${exportFilename('xlsx')}"`,
      'Content-Length': buffer.length,
    });
  }
  if (route[0] === 'export.csv' && method === 'GET') {
    const jobs = filterJobs(store.listJobs(), url.searchParams);
    const csv = exportCsv(url.searchParams.get('scope') === 'filtered' ? jobs : store.listJobs());
    return send(res, 200, csv, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFilename('csv')}"`,
    });
  }
  if (route[0] === 'export.json' && method === 'GET') {
    return send(res, 200, JSON.stringify({ exportedAt: new Date().toISOString(), jobs: store.listJobs() }, null, 2), {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFilename('json')}"`,
    });
  }
  if (route[0] === 'import' && method === 'POST') {
    const body = await readJsonBody(req);
    const incoming = Array.isArray(body) ? body : Array.isArray(body.jobs) ? body.jobs : [];
    if (!incoming.length) return sendJson(res, 400, { errors: ['Nothing to import: expected a "jobs" array'] });
    let added = 0;
    let skipped = 0;
    const failed = [];
    for (const candidate of incoming.slice(0, 5000)) {
      const { job, errors } = buildJob(candidate);
      if (errors.length) {
        failed.push({ candidate: candidate.role || candidate.company || '(blank)', errors });
        continue;
      }
      if (findDuplicate(store.listJobs(), job)) {
        skipped += 1;
        continue;
      }
      store.addJob(job);
      added += 1;
    }
    broadcast('jobs', { reason: 'imported' });
    return sendJson(res, 200, { added, skipped, failed });
  }

  // --- pending intake queue
  if (route[0] === 'pending' && route.length === 1 && method === 'GET') {
    return sendJson(res, 200, { pending: store.listPending() });
  }
  if (route[0] === 'pending' && route.length === 3 && route[2] === 'accept' && method === 'POST') {
    const entry = store.getPending(route[1]);
    if (!entry) return sendJson(res, 404, { errors: ['That prompt is no longer waiting'] });
    const body = await readJsonBody(req);
    const merged = { source: 'Parsable CV', ...entry.suggestion, ...body };
    const { job, errors } = buildJob(merged);
    if (errors.length) return sendJson(res, 400, { errors });
    const duplicate = findDuplicate(store.listJobs(), job);
    if (duplicate && !body.allowDuplicate) {
      return sendJson(res, 409, {
        errors: [`Looks like a duplicate of "${duplicate.role} at ${duplicate.company}"`],
        duplicateId: duplicate.id,
      });
    }
    store.addJob(job);
    store.removePending(entry.id);
    clearPromptsForCv(job.cvFilePath);
    broadcast('jobs', { reason: 'created', id: job.id });
    return sendJson(res, 201, { job });
  }
  if (route[0] === 'pending' && route.length === 3 && route[2] === 'dismiss' && method === 'POST') {
    const removed = store.removePending(route[1]);
    return removed ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { errors: ['Nothing to dismiss'] });
  }

  // --- Parsable CV intake (called by the bridge in the CV app)
  if (route[0] === 'intake' && method === 'POST') {
    const body = await readJsonBody(req);
    const entry = buildPending({ ...body, origin: 'bridge' });
    const duplicate = findDuplicate(store.listJobs(), entry.suggestion);
    const duplicateInfo = duplicate
      ? { id: duplicate.id, role: duplicate.role, company: duplicate.company, status: duplicate.status }
      : null;

    // ask:true means the CV app will raise its own dialog, so queue nothing -
    // otherwise both windows would ask about the same CV.
    if (body.ask === true) {
      return sendJson(res, 200, { asking: true, suggestion: entry.suggestion, duplicate: duplicateInfo });
    }

    // confirm:true means the CV app already showed its own dialog and the
    // answer was yes, so add it straight away.
    if (body.confirm === true) {
      const { job, errors } = buildJob({ source: 'Parsable CV', ...entry.suggestion, ...(body.job || {}) });
      if (errors.length) return sendJson(res, 400, { errors });
      if (duplicate && !body.allowDuplicate) {
        return sendJson(res, 409, {
          errors: [`Already tracked: "${duplicate.role} at ${duplicate.company}"`],
          duplicateId: duplicate.id,
        });
      }
      store.addJob(job);
      clearPromptsForCv(job.cvFilePath);
      broadcast('jobs', { reason: 'created', id: job.id });
      return sendJson(res, 201, { added: true, job });
    }

    // Otherwise queue it; the Tracki window raises the dialog.
    store.addPending(entry);
    broadcast('pending', { id: entry.id, suggestion: entry.suggestion });
    return sendJson(res, 202, {
      queued: true,
      pendingId: entry.id,
      suggestion: entry.suggestion,
      duplicate: duplicateInfo,
    });
  }

  // --- settings
  if (route[0] === 'settings' && method === 'GET') {
    return sendJson(res, 200, {
      settings: {
        parsableCvPath: currentCvPath(),
        watchParsableCv: watchEnabled(),
        ...store.getSettings(),
      },
      watcher: watcher.status,
      port: config.port,
      dataFile: store.file,
    });
  }
  if (route[0] === 'settings' && (method === 'PUT' || method === 'POST')) {
    const body = await readJsonBody(req);
    const patch = {};
    if (body.parsableCvPath !== undefined) patch.parsableCvPath = String(body.parsableCvPath).trim();
    if (body.watchParsableCv !== undefined) patch.watchParsableCv = Boolean(body.watchParsableCv);
    store.updateSettings(patch);
    // Remember the folder across restarts, not just in the data file.
    if (patch.parsableCvPath !== undefined || patch.watchParsableCv !== undefined) {
      try {
        saveConfig(patch);
      } catch (err) {
        console.error('[tracki] could not write config file:', err.message);
      }
    }
    const status = syncWatcher();
    return sendJson(res, 200, { settings: { parsableCvPath: currentCvPath(), watchParsableCv: watchEnabled() }, watcher: status });
  }

  // --- live stream
  if (route[0] === 'events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return undefined;
  }

  return sendJson(res, 404, { errors: [`No API route for ${method} ${pathname}`] });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    return send(res, 400, 'Bad request');
  }

  const isApi = url.pathname.startsWith('/api/');
  const isBridge = url.pathname.startsWith('/integration/');

  if (isApi || isBridge) {
    if (!isAllowedOrigin(origin)) {
      return sendJson(res, 403, { errors: ['This origin is not allowed to talk to Tracki.'] });
    }
    if (req.method === 'OPTIONS') return send(res, 204, '', corsHeaders(origin));
    res.setHeader('Access-Control-Allow-Origin', origin && origin !== 'null' ? origin : '*');
    res.setHeader('Vary', 'Origin');
  }

  try {
    if (isApi) return await handleApi(req, res, url);
    if (isBridge) return serveStatic(res, INTEGRATION_DIR, url.pathname.replace('/integration', ''));
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(res, PUBLIC_DIR, url.pathname, path.join(PUBLIC_DIR, 'index.html'));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[tracki]', err);
    return sendJson(res, status, { errors: [err.message || 'Something went wrong'] });
  }
});

function openBrowser(targetUrl) {
  const commands =
    process.platform === 'win32'
      ? [['cmd', ['/c', 'start', '', targetUrl]]]
      : process.platform === 'darwin'
        ? [['open', [targetUrl]]]
        : [['xdg-open', [targetUrl]]];
  for (const [command, args] of commands) {
    execFile(command, args, () => {}); // best effort; failure is silent by design
  }
}

function start() {
  server.listen(config.port, config.host, () => {
    const address = `http://${config.host}:${config.port}`;
    console.log('');
    console.log('  Tracki - job application tracker');
    console.log(`  ${address}`);
    console.log(`  Data file: ${store.file}`);
    console.log(`  Jobs tracked: ${store.listJobs().length}`);
    const cvPath = currentCvPath();
    console.log(cvPath ? `  Parsable CV folder: ${cvPath}` : '  Parsable CV folder: not set yet (open Settings in the app)');
    console.log('');
    syncWatcher();
    if (config.openBrowserOnStart) openBrowser(address);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[tracki] Port ${config.port} is already in use. Tracki may already be running, or set TRACKI_PORT to another port.`);
      process.exit(1);
    }
    throw err;
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n[tracki] shutting down, flushing data...');
    watcher.stop();
    try {
      store.persistSync();
    } catch (err) {
      console.error('[tracki] final save failed:', err.message);
    }
    process.exit(0);
  });
}

if (require.main === module) start();

module.exports = { server, store, config, start };
