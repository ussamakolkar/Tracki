#!/usr/bin/env node
'use strict';
/**
 * Tracki hook for a Node or Electron version of Parsable CV.
 *
 * As a module:
 *   const tracki = require('./integration/parsable-cv-hook');
 *   await tracki.askToTrack({ role, company, jobUrl, cvFilePath });
 *
 * As a command (handy from a save script, a batch file, or a post-save hook):
 *   node integration/parsable-cv-hook.js --role "Senior Dev" --company "Acme" \
 *        --job-url https://acme.com/jobs/42 --cv-file "D:\CVs\cv.pdf"
 *
 * In Electron it shows a real native dialog box. Everywhere else it queues the
 * prompt, and the Tracki window asks the moment it is open.
 */
const http = require('http');

const DEFAULT_ORIGIN = process.env.TRACKI_ORIGIN || 'http://127.0.0.1:4321';

function postJson(origin, path, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const url = new URL(path, origin);
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        timeout: 5000,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch { /* non-JSON response */ }
          if (response.statusCode >= 400) {
            reject(Object.assign(new Error((data.errors || [`Tracki returned ${response.statusCode}`]).join('; ')), { status: response.statusCode, payload: data }));
          } else {
            resolve(data);
          }
        });
      }
    );
    request.on('timeout', () => request.destroy(new Error('Tracki did not respond in time')));
    request.on('error', reject);
    request.end(body);
  });
}

/** Queue the prompt; the Tracki window raises the dialog. */
function queuePrompt(details, origin = DEFAULT_ORIGIN) {
  return postJson(origin, '/api/intake', { ...details });
}

/** Add the job immediately, with no prompt. */
function addJob(details, origin = DEFAULT_ORIGIN) {
  return postJson(origin, '/api/intake', { confirm: true, ...details });
}

/** Native Electron dialog, when running inside Electron. */
function electronDialog(details) {
  let electron;
  try {
    electron = require('electron');
  } catch {
    return null;
  }
  if (!electron || !electron.dialog) return null;
  const summary = [details.role, details.company].filter(Boolean).join(' at ') || 'this job';
  return electron.dialog
    .showMessageBox({
      type: 'question',
      buttons: ['Add to Tracki', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      title: 'Tracki',
      message: 'Add this job to your tracker?',
      detail: `CV saved${details.cvFilePath ? `: ${details.cvFilePath}` : ''}\n\n${summary}`,
    })
    .then((result) => result.response === 0);
}

/**
 * Ask whether to track the job, then do it.
 * @returns {Promise<{added: boolean, queued?: boolean, job?: object}>}
 */
async function askToTrack(details = {}, options = {}) {
  const origin = options.origin || DEFAULT_ORIGIN;
  const native = options.native === false ? null : electronDialog(details);
  if (native) {
    const yes = await native;
    if (!yes) return { added: false };
    const result = await addJob(details, origin);
    return { added: true, job: result.job };
  }
  const result = await queuePrompt(details, origin);
  return { added: false, queued: true, pendingId: result.pendingId };
}

// ------------------------------------------------------------------------ CLI
function parseArgs(argv) {
  const map = { role: 'role', company: 'company', 'job-url': 'jobUrl', location: 'location', 'cv-file': 'cvFilePath', 'cv-version': 'cvVersion', notes: 'notes', status: 'status', source: 'source' };
  const details = {};
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'yes' || key === 'confirm') {
      options.confirm = true;
      continue;
    }
    if (key === 'origin') {
      options.origin = argv[++i];
      continue;
    }
    if (map[key]) details[map[key]] = argv[++i] ?? '';
  }
  return { details, options };
}

if (require.main === module) {
  const { details, options } = parseArgs(process.argv.slice(2));
  if (!Object.keys(details).length) {
    console.log('Usage: node parsable-cv-hook.js --role "Role" --company "Company" [--job-url URL] [--cv-file PATH] [--yes]');
    process.exit(1);
  }
  const origin = options.origin || DEFAULT_ORIGIN;
  const action = options.confirm ? addJob(details, origin) : queuePrompt(details, origin);
  action
    .then((result) => {
      if (result.added) console.log(`Added to Tracki: ${result.job.role} at ${result.job.company}`);
      else console.log('Tracki will ask about this job in its window.');
    })
    .catch((err) => {
      console.error(`Could not reach Tracki at ${origin}: ${err.message}`);
      console.error('Start it with "npm start" in the Tracki folder.');
      process.exit(1);
    });
}

module.exports = { askToTrack, queuePrompt, addJob, electronDialog, DEFAULT_ORIGIN };
