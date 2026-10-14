'use strict';
/** Builds the Excel workbook and CSV file from the tracker's records. */
const { buildWorkbook } = require('./xlsx');
const { FIELDS, META_FIELDS, STATUSES } = require('./schema');
const { computeStats } = require('./jobs');

/** Export column order: schema fields, then the metadata columns. */
function exportColumns() {
  return [...FIELDS, ...META_FIELDS].map((field) => ({
    header: field.label,
    key: field.key,
    width: field.width || 18,
    type: field.type === 'url' ? 'url' : field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text',
  }));
}

/** Flatten a record into the plain values a spreadsheet cell can hold. */
function toExportRow(job) {
  const row = {};
  for (const field of [...FIELDS, ...META_FIELDS]) {
    const value = job[field.key];
    if (field.type === 'tags') row[field.key] = Array.isArray(value) ? value.join(', ') : value || '';
    else if (field.type === 'boolean') row[field.key] = value ? 'Yes' : 'No';
    else if (field.type === 'datetime') row[field.key] = value ? String(value).replace('T', ' ').slice(0, 19) : '';
    else row[field.key] = value === undefined || value === null ? '' : value;
  }
  return row;
}

function sortForExport(jobs) {
  const rank = new Map(STATUSES.map((status, i) => [status, i]));
  return [...jobs].sort((a, b) => {
    const byStatus = (rank.get(a.status) ?? 99) - (rank.get(b.status) ?? 99);
    if (byStatus) return byStatus;
    const aDate = a.dateApplied || a.dateSaved || '';
    const bDate = b.dateApplied || b.dateSaved || '';
    if (aDate !== bDate) return bDate.localeCompare(aDate);
    return String(a.company).localeCompare(String(b.company));
  });
}

function buildSummarySheet(jobs) {
  const stats = computeStats(jobs);
  const rows = [
    { metric: 'Total jobs tracked', value: stats.total },
    { metric: 'Distinct companies', value: stats.companies },
    { metric: 'Applications sent', value: stats.applied },
    { metric: 'Still active', value: stats.active },
    { metric: 'Companies that responded', value: stats.responded },
    { metric: 'Response rate (%)', value: stats.responseRate },
    { metric: 'Offers', value: stats.offers },
    { metric: '', value: '' },
    { metric: 'By status', value: '' },
    ...STATUSES.map((status) => ({ metric: `  ${status}`, value: stats.byStatus[status] || 0 })),
  ];
  return {
    name: 'Summary',
    autoFilter: false,
    columns: [
      { header: 'Metric', key: 'metric', width: 30 },
      { header: 'Value', key: 'value', width: 14, type: 'number' },
    ],
    rows,
  };
}

function buildActivitySheet(jobs) {
  const rows = [];
  for (const job of jobs) {
    for (const entry of job.history || []) {
      rows.push({
        at: entry.at ? String(entry.at).replace('T', ' ').slice(0, 19) : '',
        role: job.role,
        company: job.company,
        change: entry.type === 'status' ? `${entry.from || '-'} -> ${entry.to || '-'}` : entry.type,
        note: entry.note || '',
      });
    }
  }
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return {
    name: 'Activity log',
    columns: [
      { header: 'When', key: 'at', width: 20 },
      { header: 'Role', key: 'role', width: 28 },
      { header: 'Company', key: 'company', width: 22 },
      { header: 'Change', key: 'change', width: 28 },
      { header: 'Note', key: 'note', width: 40 },
    ],
    rows,
  };
}

/** @returns {Buffer} a multi-sheet .xlsx workbook */
function exportXlsx(jobs) {
  const ordered = sortForExport(jobs);
  return buildWorkbook({
    sheets: [
      { name: 'Job Tracker', columns: exportColumns(), rows: ordered.map(toExportRow) },
      buildSummarySheet(jobs),
      buildActivitySheet(ordered),
    ],
  });
}

function csvCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  // Guard against spreadsheet formula injection from pasted job data.
  const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** @returns {string} UTF-8 CSV with a BOM so Excel detects the encoding */
function exportCsv(jobs) {
  const columns = exportColumns();
  const lines = [columns.map((col) => csvCell(col.header)).join(',')];
  for (const job of sortForExport(jobs)) {
    const row = toExportRow(job);
    lines.push(columns.map((col) => csvCell(row[col.key])).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

function exportFilename(extension) {
  const stamp = new Date().toISOString().slice(0, 10);
  return `tracki-job-tracker-${stamp}.${extension}`;
}

module.exports = { exportXlsx, exportCsv, exportColumns, toExportRow, exportFilename };
