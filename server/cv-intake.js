'use strict';
/**
 * Turns "a CV was just saved" into a pre-filled job suggestion.
 *
 * Parsable CV can hand us the details directly (the browser bridge posts JSON),
 * but when Tracki only sees a file appear in the output folder it does its best
 * from the file itself: structured JSON if present, otherwise text, otherwise
 * the filename. Anything it cannot work out is simply left blank for you to fill
 * in the dialog.
 */
const fs = require('fs');
const path = require('path');
const { newId, normalizeUrl } = require('./jobs');

const TEXT_EXTENSIONS = new Set(['.json', '.txt', '.md', '.markdown', '.html', '.htm', '.rtf']);
const MAX_READ_BYTES = 512 * 1024;

/** Keys Parsable CV (or any CV tool) might plausibly use for each of our fields. */
const KEY_ALIASES = {
  role: ['targetrole', 'role', 'jobtitle', 'job_title', 'title', 'position', 'appliedrole', 'desiredrole', 'vacancy'],
  company: ['company', 'companyname', 'company_name', 'employer', 'organisation', 'organization', 'targetcompany', 'hiringcompany'],
  jobUrl: ['joburl', 'job_url', 'joblink', 'job_link', 'url', 'link', 'postingurl', 'posting_url', 'applylink', 'applyurl', 'vacancyurl'],
  location: ['location', 'joblocation', 'city', 'place'],
  cvVersion: ['cvversion', 'cv_version', 'version', 'variant', 'profile', 'cvname', 'resumename', 'label'],
  notes: ['jobdescription', 'job_description', 'description', 'summary', 'notes', 'jd'],
  salaryMin: ['salarymin', 'salary_min', 'minsalary'],
  salaryMax: ['salarymax', 'salary_max', 'maxsalary'],
  source: ['source', 'jobsource', 'board'],
};

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[\s_\-.]/g, '');
}

/** Walk a nested object and collect the first plausible value for each field. */
function harvestFromObject(input, depth = 0) {
  const found = {};
  if (!input || typeof input !== 'object' || depth > 6) return found;
  const entries = Array.isArray(input) ? input.map((v, i) => [String(i), v]) : Object.entries(input);

  for (const [rawKey, value] of entries) {
    const key = normalizeKey(rawKey);
    if (value && typeof value === 'object') {
      const nested = harvestFromObject(value, depth + 1);
      for (const [field, val] of Object.entries(nested)) {
        if (found[field] === undefined) found[field] = val;
      }
      continue;
    }
    if (value === null || value === undefined || value === '') continue;
    for (const [field, aliases] of Object.entries(KEY_ALIASES)) {
      if (found[field] === undefined && aliases.includes(key)) {
        found[field] = typeof value === 'string' ? value.trim() : value;
      }
    }
  }
  return found;
}

/** Last-resort scan of plain text for labelled lines and a URL. */
function harvestFromText(text) {
  const found = {};
  const patterns = {
    role: /^\s*(?:target\s+)?(?:role|position|job\s*title)\s*[:\-]\s*(.+)$/im,
    company: /^\s*(?:company|employer|organisation|organization)\s*[:\-]\s*(.+)$/im,
    location: /^\s*location\s*[:\-]\s*(.+)$/im,
    jobUrl: /^\s*(?:job\s*(?:url|link)|posting|apply)\s*[:\-]\s*(\S+)$/im,
  };
  for (const [field, pattern] of Object.entries(patterns)) {
    const match = text.match(pattern);
    if (match) found[field] = match[1].trim().slice(0, 300);
  }
  if (!found.jobUrl) {
    const url = text.match(/https?:\/\/[^\s"'<>)]+/);
    if (url) found.jobUrl = url[0];
  }
  return found;
}

/**
 * Pull hints out of names like "CV_Acme-Corp_Senior-Engineer_v3.pdf".
 * Only used for fields nothing better supplied.
 */
function harvestFromFilename(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const found = { cvVersion: base.slice(0, 120) };
  const parts = base
    .split(/[_]+/)
    .map((part) => part.replace(/[-]+/g, ' ').trim())
    .filter((part) => part && !/^(cv|resume|final|draft|copy|v?\d+(\.\d+)?)$/i.test(part));
  if (parts.length >= 2) {
    found.company = parts[0];
    found.role = parts[1];
  } else if (parts.length === 1) {
    found.role = parts[0];
  }
  return found;
}

function readTextSafely(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return '';
    const handle = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES));
      fs.readSync(handle, buffer, 0, buffer.length, 0);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return '';
  }
}

/**
 * Build a pending-intake suggestion for a saved CV file.
 * @param {string} filePath absolute path to the CV that was just saved
 * @returns {object} pending entry, ready for the "add to Tracki?" dialog
 */
function suggestionFromFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  let harvested = {};

  if (TEXT_EXTENSIONS.has(extension)) {
    const text = readTextSafely(filePath);
    if (extension === '.json') {
      try {
        harvested = harvestFromObject(JSON.parse(text));
      } catch {
        harvested = harvestFromText(text);
      }
    } else {
      harvested = harvestFromText(text);
    }
  }

  // A sidecar .json beside a PDF/DOCX is the usual way a CV tool keeps metadata.
  if (!harvested.role || !harvested.company) {
    const sidecar = filePath.replace(/\.[^.]+$/, '.json');
    if (sidecar !== filePath && fs.existsSync(sidecar)) {
      try {
        const extra = harvestFromObject(JSON.parse(readTextSafely(sidecar)));
        harvested = { ...extra, ...harvested };
      } catch { /* sidecar is optional */ }
    }
  }

  const fromName = harvestFromFilename(filePath);
  const merged = { ...fromName, ...Object.fromEntries(Object.entries(harvested).filter(([, v]) => v !== undefined && v !== '')) };

  return buildPending({
    ...merged,
    cvFilePath: filePath,
    origin: 'watcher',
  });
}

/** Shape any suggestion (file-watched or posted by the bridge) into a pending entry. */
function buildPending(input = {}) {
  const suggestion = {
    role: String(input.role || '').trim().slice(0, 200),
    company: String(input.company || '').trim().slice(0, 200),
    jobUrl: normalizeUrl(input.jobUrl || ''),
    location: String(input.location || '').trim().slice(0, 200),
    cvVersion: String(input.cvVersion || '').trim().slice(0, 200),
    cvFilePath: String(input.cvFilePath || '').trim().slice(0, 1000),
    notes: String(input.notes || '').trim().slice(0, 5000),
    salaryMin: input.salaryMin ?? '',
    salaryMax: input.salaryMax ?? '',
    source: String(input.source || 'Parsable CV').trim().slice(0, 60),
  };
  return {
    id: newId(),
    createdAt: new Date().toISOString(),
    origin: input.origin === 'watcher' ? 'watcher' : 'bridge',
    cvFilePath: suggestion.cvFilePath,
    suggestion,
  };
}

module.exports = { suggestionFromFile, buildPending, harvestFromObject, harvestFromText, harvestFromFilename };
