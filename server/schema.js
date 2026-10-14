'use strict';
/**
 * Single source of truth for the tracker's columns.
 * The HTTP validation layer, the web UI form and the Excel/CSV exporters are
 * all generated from this list, so a new field only has to be added here.
 */

const STATUSES = [
  'Wishlist',
  'Applied',
  'Screening',
  'Interview',
  'Take-home',
  'Final round',
  'Offer',
  'Accepted',
  'Rejected',
  'Withdrawn',
  'No response',
];

/** Statuses that mean the application is finished, one way or another. */
const CLOSED_STATUSES = ['Accepted', 'Rejected', 'Withdrawn', 'No response'];
/** Statuses that prove the company actually came back to you. */
const RESPONDED_STATUSES = ['Screening', 'Interview', 'Take-home', 'Final round', 'Offer', 'Accepted'];

const WORK_MODES = ['Unspecified', 'Remote', 'Hybrid', 'On-site'];
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Internship', 'Temporary', 'Freelance'];
const PRIORITIES = ['High', 'Medium', 'Low'];
const SOURCES = [
  'LinkedIn',
  'Indeed',
  'Company site',
  'Referral',
  'Recruiter',
  'Glassdoor',
  'Job board',
  'Parsable CV',
  'Other',
];

const FIELDS = [
  // key, label, type, and how it behaves in the UI / export
  { key: 'role',            label: 'Role',              type: 'text',     required: true,  width: 30, group: 'Job' },
  { key: 'company',         label: 'Company',           type: 'text',     required: true,  width: 24, group: 'Job' },
  { key: 'jobUrl',          label: 'Job link',           type: 'url',      width: 42, group: 'Job' },
  { key: 'location',        label: 'Location',          type: 'text',     width: 20, group: 'Job' },
  { key: 'workMode',        label: 'Work mode',         type: 'select',   options: WORK_MODES, default: 'Unspecified', width: 14, group: 'Job' },
  { key: 'employmentType',  label: 'Employment type',   type: 'select',   options: EMPLOYMENT_TYPES, default: 'Full-time', width: 16, group: 'Job' },
  { key: 'status',          label: 'Status',            type: 'select',   options: STATUSES, default: 'Wishlist', width: 14, group: 'Pipeline' },
  { key: 'priority',        label: 'Priority',          type: 'select',   options: PRIORITIES, default: 'Medium', width: 11, group: 'Pipeline' },
  { key: 'source',          label: 'Source',            type: 'select',   options: SOURCES, default: 'Other', width: 14, group: 'Pipeline' },
  { key: 'salaryMin',       label: 'Salary min',        type: 'number',   width: 13, group: 'Compensation' },
  { key: 'salaryMax',       label: 'Salary max',        type: 'number',   width: 13, group: 'Compensation' },
  { key: 'salaryCurrency',  label: 'Currency',          type: 'text',     default: 'USD', width: 10, group: 'Compensation' },
  { key: 'dateSaved',       label: 'Date saved',        type: 'date',     width: 13, group: 'Dates' },
  { key: 'dateApplied',     label: 'Date applied',      type: 'date',     width: 13, group: 'Dates' },
  { key: 'deadline',        label: 'Deadline',          type: 'date',     width: 13, group: 'Dates' },
  { key: 'nextAction',      label: 'Next action',       type: 'text',     width: 26, group: 'Follow-up' },
  { key: 'nextActionDate',  label: 'Next action date',  type: 'date',     width: 15, group: 'Follow-up' },
  { key: 'contactName',     label: 'Contact name',      type: 'text',     width: 20, group: 'Contacts' },
  { key: 'contactEmail',    label: 'Contact email',     type: 'email',    width: 26, group: 'Contacts' },
  { key: 'referral',        label: 'Referral',          type: 'text',     width: 20, group: 'Contacts' },
  { key: 'cvVersion',       label: 'CV version',        type: 'text',     width: 24, group: 'Documents' },
  { key: 'cvFilePath',      label: 'CV file',           type: 'text',     width: 38, group: 'Documents' },
  { key: 'coverLetterSent', label: 'Cover letter sent', type: 'boolean',  default: false, width: 16, group: 'Documents' },
  { key: 'tags',            label: 'Tags',              type: 'tags',     width: 22, group: 'Notes' },
  { key: 'notes',           label: 'Notes',             type: 'textarea', width: 50, group: 'Notes' },
];

const FIELD_MAP = new Map(FIELDS.map((f) => [f.key, f]));

/** Columns appended to the export but not editable in the form. */
const META_FIELDS = [
  { key: 'createdAt', label: 'Created', type: 'datetime', width: 20 },
  { key: 'updatedAt', label: 'Last updated', type: 'datetime', width: 20 },
];

module.exports = {
  FIELDS,
  FIELD_MAP,
  META_FIELDS,
  STATUSES,
  CLOSED_STATUSES,
  RESPONDED_STATUSES,
  WORK_MODES,
  EMPLOYMENT_TYPES,
  PRIORITIES,
  SOURCES,
};
