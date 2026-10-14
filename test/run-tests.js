#!/usr/bin/env node
'use strict';
/** Tracki's test suite. Run with: npm test */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const results = { passed: 0, failed: 0 };
const only = process.argv[2];

async function test(name, fn) {
  if (only && !name.includes(only)) return;
  try {
    await fn();
    results.passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    if (process.env.VERBOSE) console.error(err.stack);
  }
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tracki-${label}-`));
}

// --------------------------------------------------------------------- modules
const { buildJob, computeStats, findDuplicate, normalizeDate, normalizeUrl } = require('../server/jobs');
const { Store } = require('../server/store');
const { exportXlsx, exportCsv } = require('../server/export');
const { suggestionFromFile, harvestFromObject } = require('../server/cv-intake');
const { createZip } = require('../server/zip');

async function moduleTests() {
  console.log('\njob records');

  await test('requires a role and a company', () => {
    assert.deepStrictEqual(buildJob({}).errors.sort(), ['Company is required', 'Role is required']);
    assert.strictEqual(buildJob({ role: 'Dev', company: 'Acme' }).errors.length, 0);
  });

  await test('normalises whitespace, urls, numbers and tags', () => {
    const { job } = buildJob({
      role: '  Senior   Dev  ',
      company: 'Acme',
      jobUrl: 'acme.com/jobs/1',
      salaryMin: '90,000',
      tags: 'remote, AI, Remote ',
    });
    assert.strictEqual(job.role, 'Senior Dev');
    assert.strictEqual(job.jobUrl, 'https://acme.com/jobs/1');
    assert.strictEqual(job.salaryMin, 90000);
    assert.deepStrictEqual(job.tags, ['remote', 'AI']);
  });

  await test('parses day-first and ISO dates, rejects nonsense', () => {
    assert.strictEqual(normalizeDate('2026-03-04'), '2026-03-04');
    assert.strictEqual(normalizeDate('25/12/2026'), '2026-12-25');
    assert.strictEqual(normalizeDate('not a date'), '');
    assert.strictEqual(normalizeDate(''), '');
  });

  await test('leaves an unknown scheme-less string alone', () => {
    assert.strictEqual(normalizeUrl('ask the recruiter'), 'ask the recruiter');
    assert.strictEqual(normalizeUrl('https://x.com/a'), 'https://x.com/a');
  });

  await test('swaps a salary range entered backwards', () => {
    const { job } = buildJob({ role: 'Dev', company: 'A', salaryMin: '120000', salaryMax: '90000' });
    assert.strictEqual(job.salaryMin, 90000);
    assert.strictEqual(job.salaryMax, 120000);
  });

  await test('coerces an unknown status to the default', () => {
    assert.strictEqual(buildJob({ role: 'D', company: 'A', status: 'banana' }).job.status, 'Wishlist');
    assert.strictEqual(buildJob({ role: 'D', company: 'A', status: 'iNtErViEw' }).job.status, 'Interview');
  });

  await test('stamps the applied date once the status leaves Wishlist', () => {
    const { job } = buildJob({ role: 'D', company: 'A', status: 'Applied' });
    assert.strictEqual(job.dateApplied, new Date().toISOString().slice(0, 10));
    assert.strictEqual(buildJob({ role: 'D', company: 'A' }).job.dateApplied, '');
  });

  await test('records status changes in the history', () => {
    const first = buildJob({ role: 'D', company: 'A', status: 'Applied' }).job;
    const second = buildJob({ status: 'Interview' }, first).job;
    const entry = second.history[second.history.length - 1];
    assert.strictEqual(entry.type, 'status');
    assert.strictEqual(entry.from, 'Applied');
    assert.strictEqual(entry.to, 'Interview');
  });

  await test('a partial update keeps untouched fields', () => {
    const first = buildJob({ role: 'D', company: 'A', notes: 'keep me', location: 'Leeds' }).job;
    const second = buildJob({ status: 'Applied' }, first).job;
    assert.strictEqual(second.notes, 'keep me');
    assert.strictEqual(second.location, 'Leeds');
    assert.strictEqual(second.id, first.id);
  });

  await test('finds duplicates by link, and by role plus company', () => {
    const jobs = [buildJob({ role: 'Dev', company: 'Acme', jobUrl: 'https://acme.com/jobs/1' }).job];
    assert.ok(findDuplicate(jobs, { jobUrl: 'https://acme.com/jobs/1?utm=x' }));
    assert.ok(findDuplicate(jobs, { role: 'dev', company: 'ACME' }));
    assert.strictEqual(findDuplicate(jobs, { role: 'Dev', company: 'Other' }), null);
  });

  await test('computes response rate and overdue follow-ups', () => {
    const jobs = [
      buildJob({ role: 'A', company: 'A', status: 'Applied' }).job,
      buildJob({ role: 'B', company: 'B', status: 'Interview' }).job,
      buildJob({ role: 'C', company: 'C', status: 'Wishlist', nextActionDate: '2020-01-01' }).job,
      buildJob({ role: 'D', company: 'D', status: 'Applied', nextActionDate: '2020-01-02' }).job,
    ];
    const stats = computeStats(jobs);
    assert.strictEqual(stats.total, 4);
    assert.strictEqual(stats.applied, 3);
    assert.strictEqual(stats.responded, 1);
    assert.strictEqual(stats.responseRate, 33.3);
    assert.strictEqual(stats.overdue.length, 2);
  });

  console.log('\nstorage');

  await test('round-trips data through the JSON file', async () => {
    const dir = tempDir('store');
    const store = new Store(dir);
    store.load();
    store.addJob(buildJob({ role: 'Dev', company: 'Acme' }).job);
    await store.save();
    const reopened = new Store(dir);
    reopened.load();
    assert.strictEqual(reopened.listJobs().length, 1);
    assert.strictEqual(reopened.listJobs()[0].role, 'Dev');
  });

  await test('quarantines an unreadable data file instead of overwriting it', () => {
    const dir = tempDir('corrupt');
    fs.writeFileSync(path.join(dir, 'tracki-data.json'), '{ this is not json');
    const store = new Store(dir);
    store.load();
    assert.strictEqual(store.listJobs().length, 0);
    assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('corrupt-')));
  });

  await test('keeps a backup of the previous version on save', async () => {
    const dir = tempDir('backup');
    const store = new Store(dir);
    store.load();
    store.addJob(buildJob({ role: 'One', company: 'A' }).job);
    await store.save();
    store.addJob(buildJob({ role: 'Two', company: 'B' }).job);
    await store.save();
    assert.ok(fs.readdirSync(path.join(dir, 'backups')).length >= 1);
  });

  await test('re-saving the same CV refreshes one prompt rather than stacking them', async () => {
    const dir = tempDir('pending');
    const store = new Store(dir);
    store.load();
    store.addPending({ id: '1', cvFilePath: '/cv.pdf', suggestion: { role: 'A' } });
    store.addPending({ id: '2', cvFilePath: '/cv.pdf', suggestion: { role: 'B' } });
    assert.strictEqual(store.listPending().length, 1);
    assert.strictEqual(store.listPending()[0].suggestion.role, 'B');
  });

  console.log('\nexports');

  await test('writes a readable zip container', () => {
    const buffer = createZip([{ name: 'a.txt', data: 'hello' }]);
    assert.strictEqual(buffer.readUInt32LE(0), 0x04034b50);
    assert.ok(buffer.includes(Buffer.from('a.txt')));
  });

  await test('builds a three-sheet workbook', () => {
    const jobs = [buildJob({ role: 'Dev', company: 'Acme', jobUrl: 'https://acme.com/1', status: 'Applied' }).job];
    const buffer = exportXlsx(jobs);
    const text = buffer.toString('latin1');
    assert.ok(buffer.length > 2000);
    assert.ok(text.includes('xl/worksheets/sheet1.xml'));
    assert.ok(text.includes('xl/worksheets/sheet3.xml'));
    assert.ok(text.includes('[Content_Types].xml'));
  });

  await test('exports every schema field as a CSV column', () => {
    const { FIELDS, META_FIELDS } = require('../server/schema');
    const csv = exportCsv([buildJob({ role: 'Dev', company: 'Acme' }).job]);
    const header = csv.replace('\ufeff', '').split('\r\n')[0].split(',');
    assert.strictEqual(header.length, FIELDS.length + META_FIELDS.length);
    assert.ok(header.includes('Job link'));
  });

  await test('neutralises a formula injected through a job field', () => {
    const csv = exportCsv([buildJob({ role: '=HYPERLINK("http://evil")', company: 'A' }).job]);
    assert.ok(csv.includes("'=HYPERLINK"), 'leading = should be escaped');
  });

  await test('escapes XML-hostile characters in the workbook', () => {
    const buffer = exportXlsx([buildJob({ role: 'R&D <lead>', company: '"Quotes"' }).job]);
    const text = buffer.toString('latin1');
    assert.ok(!text.includes('<lead>'));
  });

  console.log('\nParsable CV intake');

  await test('reads role and company from structured CV JSON', () => {
    const dir = tempDir('cvjson');
    const file = path.join(dir, 'cv.json');
    fs.writeFileSync(file, JSON.stringify({ target: { jobTitle: 'Staff Engineer', companyName: 'Northwind', postingUrl: 'northwind.dev/jobs/1' } }));
    const { suggestion } = suggestionFromFile(file);
    assert.strictEqual(suggestion.role, 'Staff Engineer');
    assert.strictEqual(suggestion.company, 'Northwind');
    assert.strictEqual(suggestion.jobUrl, 'https://northwind.dev/jobs/1');
  });

  await test('reads labelled lines out of a text CV', () => {
    const dir = tempDir('cvtxt');
    const file = path.join(dir, 'cv.txt');
    fs.writeFileSync(file, 'Target Role: Product Designer\nCompany: Figmoid\nApply: https://figmoid.com/careers/2\n');
    const { suggestion } = suggestionFromFile(file);
    assert.strictEqual(suggestion.role, 'Product Designer');
    assert.strictEqual(suggestion.company, 'Figmoid');
  });

  await test('falls back to the filename for a PDF', () => {
    const dir = tempDir('cvpdf');
    const file = path.join(dir, 'Acme-Corp_Senior-Engineer_v2.pdf');
    fs.writeFileSync(file, '%PDF-1.4');
    const { suggestion } = suggestionFromFile(file);
    assert.strictEqual(suggestion.company, 'Acme Corp');
    assert.strictEqual(suggestion.role, 'Senior Engineer');
  });

  await test('picks up a sidecar JSON next to a PDF', () => {
    const dir = tempDir('cvside');
    fs.writeFileSync(path.join(dir, 'cv.json'), JSON.stringify({ jobTitle: 'SRE', employer: 'Globex' }));
    fs.writeFileSync(path.join(dir, 'cv.pdf'), '%PDF-1.4');
    const { suggestion } = suggestionFromFile(path.join(dir, 'cv.pdf'));
    assert.strictEqual(suggestion.role, 'SRE');
    assert.strictEqual(suggestion.company, 'Globex');
  });

  await test('does not walk a CV object forever', () => {
    const deep = {};
    let node = deep;
    for (let i = 0; i < 50; i += 1) {
      node.child = {};
      node = node.child;
    }
    node.jobTitle = 'Too deep to find';
    assert.deepStrictEqual(harvestFromObject(deep), {});
  });
}

// ------------------------------------------------------------------ end to end
function requestJson(port, method, apiPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: apiPath,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          let data = null;
          try {
            data = JSON.parse(text);
          } catch { /* binary or html */ }
          resolve({ status: response.statusCode, headers: response.headers, data, text, buffer });
        });
      }
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function serverTests() {
  console.log('\nHTTP API (end to end)');

  const dir = tempDir('server');
  process.env.TRACKI_DATA_DIR = dir;
  process.env.TRACKI_CONFIG_FILE = path.join(dir, 'tracki.config.json');
  process.env.TRACKI_PORT = '0';
  process.env.TRACKI_NO_BROWSER = '1';
  delete require.cache[require.resolve('../server/index')];
  delete require.cache[require.resolve('../server/config')];
  const app = require('../server/index');
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;

  let createdId = null;

  await test('serves the UI at the root', async () => {
    const response = await requestJson(port, 'GET', '/');
    assert.strictEqual(response.status, 200);
    assert.ok(response.text.includes('<title>Tracki</title>'));
  });

  await test('serves the bridge script for the CV app', async () => {
    const response = await requestJson(port, 'GET', '/integration/tracki-bridge.js');
    assert.strictEqual(response.status, 200);
    assert.ok(response.text.includes('onCvSaved'));
  });

  await test('publishes the field schema', async () => {
    const response = await requestJson(port, 'GET', '/api/schema');
    assert.strictEqual(response.status, 200);
    assert.ok(response.data.fields.some((field) => field.key === 'jobUrl'));
    assert.ok(response.data.statuses.includes('Offer'));
  });

  await test('creates a job', async () => {
    const response = await requestJson(port, 'POST', '/api/jobs', {
      role: 'Senior Backend Engineer',
      company: 'Acme Corp',
      jobUrl: 'https://acme.com/jobs/42',
      status: 'Applied',
      tags: 'priority, remote',
    });
    assert.strictEqual(response.status, 201);
    createdId = response.data.job.id;
    assert.strictEqual(response.data.job.company, 'Acme Corp');
  });

  await test('rejects a job with no role', async () => {
    const response = await requestJson(port, 'POST', '/api/jobs', { company: 'Acme' });
    assert.strictEqual(response.status, 400);
    assert.ok(response.data.errors.join(' ').includes('Role'));
  });

  await test('refuses a duplicate unless told otherwise', async () => {
    const duplicate = { role: 'Senior Backend Engineer', company: 'Acme Corp' };
    const blocked = await requestJson(port, 'POST', '/api/jobs', duplicate);
    assert.strictEqual(blocked.status, 409);
    const forced = await requestJson(port, 'POST', '/api/jobs', { ...duplicate, allowDuplicate: true });
    assert.strictEqual(forced.status, 201);
    await requestJson(port, 'DELETE', `/api/jobs/${forced.data.job.id}`);
  });

  await test('updates a job and moves it through the pipeline', async () => {
    const updated = await requestJson(port, 'PUT', `/api/jobs/${createdId}`, { status: 'Interview', nextAction: 'Prep system design' });
    assert.strictEqual(updated.status, 200);
    assert.strictEqual(updated.data.job.status, 'Interview');
    const quick = await requestJson(port, 'POST', `/api/jobs/${createdId}/status`, { status: 'Offer', note: 'verbal' });
    assert.strictEqual(quick.data.job.status, 'Offer');
    assert.ok(quick.data.job.history.some((entry) => entry.note === 'verbal'));
  });

  await test('searches and filters', async () => {
    await requestJson(port, 'POST', '/api/jobs', { role: 'Data Analyst', company: 'Beta Ltd', status: 'Rejected' });
    const search = await requestJson(port, 'GET', '/api/jobs?q=analyst');
    assert.strictEqual(search.data.jobs.length, 1);
    const open = await requestJson(port, 'GET', '/api/jobs?status=open');
    assert.ok(open.data.jobs.every((job) => job.status !== 'Rejected'));
    const stats = open.data.stats;
    assert.strictEqual(stats.total, 2);
  });

  await test('intake queues a prompt for the Tracki window', async () => {
    const response = await requestJson(
      port,
      'POST',
      '/api/intake',
      { role: 'ML Engineer', company: 'Gamma', cvFilePath: 'D:\\CVs\\CV_Gamma.pdf' },
      { Origin: 'http://localhost:5173' }
    );
    assert.strictEqual(response.status, 202);
    assert.strictEqual(response.data.queued, true);
    assert.strictEqual(response.data.suggestion.role, 'ML Engineer');
    assert.ok(response.headers['access-control-allow-origin']);

    const pending = await requestJson(port, 'GET', '/api/pending');
    assert.strictEqual(pending.data.pending.length, 1);

    const accepted = await requestJson(port, 'POST', `/api/pending/${response.data.pendingId}/accept`, { status: 'Applied' });
    assert.strictEqual(accepted.status, 201);
    assert.strictEqual(accepted.data.job.source, 'Parsable CV');
    assert.strictEqual(accepted.data.job.cvFilePath, 'D:\\CVs\\CV_Gamma.pdf');
    const after = await requestJson(port, 'GET', '/api/pending');
    assert.strictEqual(after.data.pending.length, 0);
  });

  await test('an ask-probe returns details without queuing a prompt', async () => {
    const response = await requestJson(port, 'POST', '/api/intake', { ask: true, role: 'Probe Role', company: 'Probe Co' });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.data.asking, true);
    assert.strictEqual(response.data.suggestion.role, 'Probe Role');
    const pending = await requestJson(port, 'GET', '/api/pending');
    assert.strictEqual(pending.data.pending.length, 0, 'an ask must not queue a prompt');
  });

  await test('adding a job clears a prompt still queued for the same CV file', async () => {
    const cvFilePath = 'D:\\CVs\\CV_Epsilon.pdf';
    const queued = await requestJson(port, 'POST', '/api/intake', { role: 'Epsilon Dev', company: 'Epsilon', cvFilePath });
    assert.strictEqual((await requestJson(port, 'GET', '/api/pending')).data.pending.length, 1);
    const added = await requestJson(port, 'POST', '/api/intake', { confirm: true, role: 'Epsilon Dev', company: 'Epsilon', cvFilePath });
    assert.strictEqual(added.status, 201);
    const pending = await requestJson(port, 'GET', '/api/pending');
    assert.strictEqual(pending.data.pending.length, 0, 'the stale prompt should be gone');
    assert.ok(queued.data.pendingId);
  });

  await test('accepting a prompt that is already gone reports 404, not a crash', async () => {
    const queued = await requestJson(port, 'POST', '/api/intake', { role: 'Ghost', company: 'Ghost Co' });
    await requestJson(port, 'POST', `/api/pending/${queued.data.pendingId}/dismiss`, {});
    const again = await requestJson(port, 'POST', `/api/pending/${queued.data.pendingId}/accept`, { status: 'Applied' });
    assert.strictEqual(again.status, 404);
  });

  await test('intake with confirm adds the job straight away', async () => {
    const response = await requestJson(port, 'POST', '/api/intake', {
      confirm: true,
      role: 'Platform Engineer',
      company: 'Delta',
      job: { status: 'Applied' },
    });
    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.data.added, true);
    assert.strictEqual(response.data.job.status, 'Applied');
  });

  await test('intake reports an existing entry so the dialog can warn', async () => {
    const response = await requestJson(port, 'POST', '/api/intake', { role: 'Platform Engineer', company: 'Delta' });
    assert.strictEqual(response.status, 202);
    assert.ok(response.data.duplicate, 'expected a duplicate warning');
    await requestJson(port, 'POST', `/api/pending/${response.data.pendingId}/dismiss`, {});
  });

  await test('a prompt can be dismissed', async () => {
    const queued = await requestJson(port, 'POST', '/api/intake', { role: 'Nope', company: 'Nope Ltd' });
    const dismissed = await requestJson(port, 'POST', `/api/pending/${queued.data.pendingId}/dismiss`, {});
    assert.strictEqual(dismissed.status, 200);
    const pending = await requestJson(port, 'GET', '/api/pending');
    assert.strictEqual(pending.data.pending.length, 0);
  });

  await test('blocks a random website from posting to the API', async () => {
    const response = await requestJson(port, 'POST', '/api/intake', { role: 'X', company: 'Y' }, { Origin: 'https://evil.example.com' });
    assert.strictEqual(response.status, 403);
  });

  await test('sorts priority and status by meaning, not alphabetically', async () => {
    await requestJson(port, 'POST', '/api/jobs', { role: 'Low Priority Role', company: 'Low Co', priority: 'Low' });
    await requestJson(port, 'POST', '/api/jobs', { role: 'Mid Priority Role', company: 'Mid Co', priority: 'Medium' });
    await requestJson(port, 'POST', '/api/jobs', { role: 'Top Priority Role', company: 'Top Co', priority: 'High' });
    const sorted = await requestJson(port, 'GET', '/api/jobs?status=all&sort=priority&dir=asc');
    const order = sorted.data.jobs.map((job) => job.priority);
    const high = order.indexOf('High');
    const medium = order.indexOf('Medium');
    const low = order.indexOf('Low');
    assert.ok(high < medium && medium < low, `expected High before Medium before Low, got ${order.join(',')}`);
  });

  await test('sorts jobs with no follow-up date last', async () => {
    const sorted = await requestJson(port, 'GET', '/api/jobs?status=all&sort=nextActionDate&dir=asc');
    const dates = sorted.data.jobs.map((job) => job.nextActionDate);
    const firstBlank = dates.indexOf('');
    assert.ok(firstBlank === -1 || !dates.slice(firstBlank).some((date) => date !== ''), 'blank dates must come last');
  });

  await test('downloads a real xlsx workbook', async () => {
    const response = await requestJson(port, 'GET', '/api/export.xlsx');
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers['content-disposition'].includes('.xlsx'));
    assert.strictEqual(response.buffer.readUInt16LE(0), 0x4b50); // "PK"
    assert.ok(response.buffer.length > 2000);
  });

  await test('downloads CSV with a BOM for Excel', async () => {
    const response = await requestJson(port, 'GET', '/api/export.csv');
    assert.strictEqual(response.status, 200);
    assert.ok(response.text.startsWith('\ufeff'));
    assert.ok(response.text.includes('Job link'));
  });

  await test('imports a backup and skips duplicates', async () => {
    const response = await requestJson(port, 'POST', '/api/import', {
      jobs: [
        { role: 'Imported Role', company: 'Imported Co' },
        { role: 'Imported Role', company: 'Imported Co' },
        { company: 'No role here' },
      ],
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.data.added, 1);
    assert.strictEqual(response.data.skipped, 1);
    assert.strictEqual(response.data.failed.length, 1);
  });

  await test('reports a missing CV folder instead of crashing', async () => {
    const response = await requestJson(port, 'PUT', '/api/settings', { parsableCvPath: path.join(dir, 'does-not-exist'), watchParsableCv: true });
    assert.strictEqual(response.status, 200);
    assert.ok(response.data.watcher.error.includes('not found'));
  });

  await test('watches a real folder once pointed at one', async () => {
    const watched = path.join(dir, 'cv-output');
    fs.mkdirSync(watched, { recursive: true });
    const response = await requestJson(port, 'PUT', '/api/settings', { parsableCvPath: watched, watchParsableCv: true });
    assert.strictEqual(response.data.watcher.watching, true);
    assert.strictEqual(response.data.watcher.path, watched);
  });

  await test('a saved CV file raises a prompt by itself', async () => {
    const watched = path.join(dir, 'cv-output');
    fs.writeFileSync(path.join(watched, 'Zeta-Industries_Site-Reliability-Engineer.json'), JSON.stringify({ jobTitle: 'Site Reliability Engineer', companyName: 'Zeta Industries', jobUrl: 'https://zeta.test/jobs/7' }));
    const deadline = Date.now() + 8000;
    let pending = [];
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      pending = (await requestJson(port, 'GET', '/api/pending')).data.pending;
      if (pending.length) break;
    }
    assert.strictEqual(pending.length, 1, 'the watcher should have queued a prompt');
    assert.strictEqual(pending[0].suggestion.company, 'Zeta Industries');
    assert.strictEqual(pending[0].origin, 'watcher');
  });

  await test('pushes a live event when a CV is queued', async () => {
    const received = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port, path: '/api/events', method: 'GET' }, (response) => {
        let buffer = '';
        response.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          if (buffer.includes('event: pending')) {
            request.destroy();
            resolve(buffer);
          }
        });
      });
      request.on('error', (err) => { if (!/socket hang up|aborted/i.test(err.message)) reject(err); });
      request.end();
      setTimeout(() => requestJson(port, 'POST', '/api/intake', { role: 'Live Event Role', company: 'SSE Co' }), 400);
      setTimeout(() => reject(new Error('no SSE event arrived within 6s')), 6000);
    });
    assert.ok(received.includes('Live Event Role'));
  });

  await test('refuses to serve files outside the public folder', async () => {
    const response = await requestJson(port, 'GET', '/../server/index.js');
    assert.ok(response.status === 200 ? !response.text.includes('require(') : true, 'must not leak server source');
  });

  await test('404s an unknown API route', async () => {
    const response = await requestJson(port, 'GET', '/api/nope');
    assert.strictEqual(response.status, 404);
  });

  await new Promise((resolve) => app.server.close(resolve));
  app.store.persistSync();
}

(async () => {
  console.log('Tracki test suite');
  await moduleTests();
  await serverTests();
  console.log(`\n${results.passed} passed, ${results.failed} failed\n`);
  process.exit(results.failed ? 1 : 0);
})().catch((err) => {
  console.error('test runner crashed:', err);
  process.exit(1);
});
