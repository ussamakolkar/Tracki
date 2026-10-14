'use strict';
/** Validation, normalisation and derived stats for job records. */
const crypto = require('crypto');
const { FIELDS, FIELD_MAP, STATUSES, CLOSED_STATUSES, RESPONDED_STATUSES } = require('./schema');

const MAX_TEXT = 2000;
const MAX_NOTES = 20000;

function newId() {
  return crypto.randomUUID();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function trimText(value, max = MAX_TEXT) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Accepts an ISO date, a date-time, or a common dd/mm/yyyy style string. */
function normalizeDate(value) {
  if (value === null || value === undefined || value === '') return '';
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const slash = str.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (slash) {
    const [, a, b, y] = slash;
    // Day-first unless that is impossible (e.g. 12/25/2026).
    const day = Number(a) > 12 ? a : Number(b) > 12 ? b : a;
    const month = day === a ? b : a;
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return '';
}

function normalizeUrl(value) {
  const str = trimText(value, 2048);
  if (!str) return '';
  if (/^https?:\/\//i.test(str)) return str;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(str)) return `https://${str}`;
  return str;
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  const num = Number(String(value).replace(/[,\s_]/g, '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(num) ? num : '';
}

function normalizeTags(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const tag = trimText(item, 40);
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
    if (out.length >= 25) break;
  }
  return out;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeField(field, value) {
  switch (field.type) {
    case 'date':
      return normalizeDate(value);
    case 'url':
      return normalizeUrl(value);
    case 'number':
      return normalizeNumber(value);
    case 'tags':
      return normalizeTags(value);
    case 'boolean':
      return normalizeBoolean(value);
    case 'textarea':
      return String(value ?? '').trim().slice(0, MAX_NOTES);
    case 'select': {
      const str = trimText(value);
      const match = field.options.find((opt) => opt.toLowerCase() === str.toLowerCase());
      return match || field.default || field.options[0];
    }
    case 'email': {
      const str = trimText(value, 254).toLowerCase();
      return str && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str) ? str : str;
    }
    default:
      return trimText(value);
  }
}

/**
 * Build a clean job record from arbitrary input.
 * @returns {{job: object|null, errors: string[]}}
 */
function buildJob(input, existing = null) {
  const errors = [];
  const source = input && typeof input === 'object' ? input : {};
  const job = existing ? { ...existing } : {};

  for (const field of FIELDS) {
    const provided = Object.prototype.hasOwnProperty.call(source, field.key);
    if (!provided) {
      if (existing) continue; // partial update: leave untouched
      job[field.key] = field.type === 'tags' ? [] : field.default !== undefined ? field.default : '';
      continue;
    }
    job[field.key] = normalizeField(field, source[field.key]);
  }

  for (const field of FIELDS) {
    if (field.required && !String(job[field.key] ?? '').trim()) {
      errors.push(`${field.label} is required`);
    }
  }

  if (job.salaryMin !== '' && job.salaryMax !== '' && Number(job.salaryMin) > Number(job.salaryMax)) {
    const min = job.salaryMin;
    job.salaryMin = job.salaryMax;
    job.salaryMax = min;
  }

  const now = new Date().toISOString();
  if (!existing) {
    job.id = newId();
    job.createdAt = now;
    job.dateSaved = job.dateSaved || today();
    job.history = [{ at: now, type: 'created', to: job.status, note: 'Added to Tracki' }];
  } else {
    job.id = existing.id;
    job.createdAt = existing.createdAt;
    job.history = Array.isArray(existing.history) ? existing.history.slice(-200) : [];
    if (existing.status !== job.status) {
      job.history.push({ at: now, type: 'status', from: existing.status, to: job.status, note: '' });
    }
  }

  // Applying is the moment worth stamping automatically.
  if (job.status !== 'Wishlist' && !job.dateApplied) job.dateApplied = today();
  job.updatedAt = now;

  return { job: errors.length ? null : job, errors };
}

function daysBetween(fromIso, toIso) {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** Dashboard numbers: pipeline counts, response rate and what is overdue. */
function computeStats(jobs) {
  const byStatus = {};
  for (const status of STATUSES) byStatus[status] = 0;
  let applied = 0;
  let responded = 0;
  let active = 0;
  let offers = 0;
  const now = today();
  const dueSoon = [];
  const overdue = [];
  const companies = new Set();

  for (const job of jobs) {
    byStatus[job.status] = (byStatus[job.status] || 0) + 1;
    if (job.company) companies.add(job.company.toLowerCase());
    if (job.status !== 'Wishlist') applied += 1;
    if (RESPONDED_STATUSES.includes(job.status)) responded += 1;
    if (!CLOSED_STATUSES.includes(job.status)) active += 1;
    if (job.status === 'Offer' || job.status === 'Accepted') offers += 1;

    if (job.nextActionDate && !CLOSED_STATUSES.includes(job.status)) {
      const delta = daysBetween(now, job.nextActionDate);
      if (delta !== null && delta < 0) overdue.push({ id: job.id, role: job.role, company: job.company, date: job.nextActionDate, days: -delta });
      else if (delta !== null && delta <= 7) dueSoon.push({ id: job.id, role: job.role, company: job.company, date: job.nextActionDate, days: delta });
    }
  }

  return {
    total: jobs.length,
    companies: companies.size,
    applied,
    responded,
    active,
    offers,
    responseRate: applied ? Math.round((responded / applied) * 1000) / 10 : 0,
    byStatus,
    overdue: overdue.sort((a, b) => a.date.localeCompare(b.date)),
    dueSoon: dueSoon.sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * Does this job already exist? Matches on job link first, then role+company,
 * so re-saving the same CV does not create duplicates.
 */
function findDuplicate(jobs, candidate) {
  const url = normalizeUrl(candidate.jobUrl || '').toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  const role = trimText(candidate.role || '').toLowerCase();
  const company = trimText(candidate.company || '').toLowerCase();
  return (
    jobs.find((job) => {
      if (url) {
        const other = String(job.jobUrl || '').toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
        if (other && other === url) return true;
      }
      return (
        role &&
        company &&
        String(job.role || '').toLowerCase() === role &&
        String(job.company || '').toLowerCase() === company
      );
    }) || null
  );
}

module.exports = {
  buildJob,
  computeStats,
  findDuplicate,
  normalizeDate,
  normalizeUrl,
  normalizeNumber,
  normalizeTags,
  newId,
  today,
  daysBetween,
};
