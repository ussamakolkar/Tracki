'use strict';
/** Tracki front-end. Plain ES modules-free script so it runs from file serve. */

const state = {
  schema: null,
  jobs: [],
  stats: null,
  pending: [],
  editingId: null,
  shownPendingId: null,
  settings: {},
};

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
};

function toast(message, kind = '') {
  const node = el('div', { class: `toast ${kind ? `toast-${kind}` : ''}`, text: message });
  $('toasts').append(node);
  setTimeout(() => node.remove(), 4200);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error((data.errors || ['Request failed']).join('; '));
    error.payload = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

// ------------------------------------------------------------------ rendering
function queryString() {
  const params = new URLSearchParams();
  const q = $('search').value.trim();
  if (q) params.set('q', q);
  params.set('status', $('filter-status').value);
  params.set('sort', $('sort').value);
  params.set('dir', ['company', 'role', 'priority', 'nextActionDate'].includes($('sort').value) ? 'asc' : 'desc');
  return params.toString();
}

async function refresh() {
  const query = queryString();
  const data = await api(`/api/jobs?${query}`);
  state.jobs = data.jobs;
  state.stats = data.stats;
  $('export-filtered').href = `/api/export.xlsx?scope=filtered&${query}`;
  renderStats();
  renderReminders();
  renderTable();
}

function renderStats() {
  const s = state.stats;
  const cards = [
    ['Tracked', s.total],
    ['Applied', s.applied],
    ['Active', s.active],
    ['Responses', s.responded],
    ['Response rate', `${s.responseRate}%`],
    ['Offers', s.offers],
  ];
  $('stats').replaceChildren(
    ...cards.map(([label, value]) =>
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat-value', text: String(value) }),
        el('div', { class: 'stat-label', text: label }),
      ])
    )
  );
}

function renderReminders() {
  const { overdue, dueSoon } = state.stats;
  const box = $('reminders');
  if (!overdue.length && !dueSoon.length) {
    box.hidden = true;
    return;
  }
  const items = [
    ...overdue.map((item) => `<strong>${escapeHtml(item.role)}</strong> at ${escapeHtml(item.company)} - follow-up was due ${item.days} day${item.days === 1 ? '' : 's'} ago (${item.date})`),
    ...dueSoon.map((item) => `<strong>${escapeHtml(item.role)}</strong> at ${escapeHtml(item.company)} - ${item.days === 0 ? 'due today' : `due in ${item.days} day${item.days === 1 ? '' : 's'}`} (${item.date})`),
  ];
  box.innerHTML = `<strong>Follow-ups</strong><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
  box.hidden = false;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTable() {
  const body = $('jobs-body');
  $('result-count').textContent = `${state.jobs.length} of ${state.stats.total} shown`;
  $('empty-state').hidden = state.jobs.length > 0 || state.stats.total > 0;
  $('jobs-table').parentElement.hidden = state.jobs.length === 0 && state.stats.total === 0;

  if (!state.jobs.length) {
    body.replaceChildren(
      el('tr', {}, el('td', { colspan: '7', class: 'muted', style: 'padding:24px;text-align:center' },
        state.stats.total ? 'Nothing matches those filters.' : 'No jobs tracked yet.'))
    );
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  body.replaceChildren(
    ...state.jobs.map((job) => {
      const statusSelect = el('select', {
        class: 'status-select',
        title: 'Change status',
        onchange: async (event) => {
          try {
            await api(`/api/jobs/${job.id}/status`, { method: 'POST', body: JSON.stringify({ status: event.target.value }) });
            toast(`${job.role} -> ${event.target.value}`, 'ok');
            refresh();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, state.schema.statuses.map((status) => el('option', { value: status, selected: status === job.status, text: status })));

      const nextCell = job.nextActionDate && job.nextActionDate < today && !state.schema.closedStatuses.includes(job.status)
        ? el('td', { class: 'overdue' }, [document.createTextNode(`${job.nextAction || 'Follow up'} (${job.nextActionDate})`)])
        : el('td', {}, [document.createTextNode(job.nextAction ? `${job.nextAction}${job.nextActionDate ? ` (${job.nextActionDate})` : ''}` : '-')]);

      return el('tr', {}, [
        el('td', { class: 'role-cell' }, [
          document.createTextNode(job.role),
          el('div', { class: 'role-meta' }, [
            document.createTextNode([job.location, job.workMode !== 'Unspecified' ? job.workMode : '', job.employmentType].filter(Boolean).join(' · ')),
          ]),
          ...(job.priority === 'High' ? [el('span', { class: 'pill pill-high', text: 'High' })] : []),
          ...(job.tags || []).map((tag) => el('span', { class: 'tag', text: tag })),
        ]),
        el('td', {}, [document.createTextNode(job.company)]),
        el('td', {}, statusSelect),
        el('td', {}, [document.createTextNode(job.dateApplied || '-')]),
        nextCell,
        el('td', {}, job.jobUrl ? el('a', { href: job.jobUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open' }) : document.createTextNode('-')),
        el('td', {}, el('div', { class: 'cell-actions' }, [
          el('button', { class: 'btn-icon', title: 'Edit', text: '✎', onclick: () => openJobDialog(job) }),
          el('button', {
            class: 'btn-icon', title: 'Delete', text: '✕',
            onclick: async () => {
              if (!confirm(`Delete "${job.role} at ${job.company}" from the tracker?`)) return;
              await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
              toast('Deleted', 'ok');
              refresh();
            },
          }),
        ])),
      ]);
    })
  );
}

// -------------------------------------------------------------- the job dialog
function fieldInput(field, value) {
  const id = `f-${field.key}`;
  let control;
  if (field.type === 'select') {
    control = el('select', { id, class: 'select', name: field.key },
      field.options.map((opt) => el('option', { value: opt, selected: opt === value, text: opt })));
  } else if (field.type === 'textarea') {
    control = el('textarea', { id, name: field.key });
    control.value = value ?? '';
  } else if (field.type === 'boolean') {
    control = el('input', { id, name: field.key, type: 'checkbox', ...(value ? { checked: 'checked' } : {}) });
  } else {
    const inputType = field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text';
    control = el('input', { id, name: field.key, type: inputType, class: 'input' });
    control.value = Array.isArray(value) ? value.join(', ') : value ?? '';
    if (field.type === 'tags') control.placeholder = 'comma, separated, tags';
    if (field.type === 'url') control.placeholder = 'https://...';
  }
  const label = el('label', { class: `field${field.type === 'textarea' || field.type === 'tags' ? ' field-wide' : ''}`, for: id }, [
    el('span', { class: 'field-label', html: `${escapeHtml(field.label)}${field.required ? ' <span class="required">*</span>' : ''}` }),
    control,
  ]);
  return label;
}

function openJobDialog(job = null) {
  state.editingId = job ? job.id : null;
  $('job-dialog-title').textContent = job ? 'Edit job' : 'Add job';
  $('job-errors').hidden = true;
  $('job-delete').hidden = !job;

  const groups = new Map();
  for (const field of state.schema.fields) {
    const group = field.group || 'Details';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(fieldInput(field, job ? job[field.key] : field.default));
  }
  $('job-fields').replaceChildren(
    ...[...groups.entries()].map(([name, fields]) =>
      el('fieldset', { class: 'group' }, [el('legend', { text: name }), el('div', { class: 'grid-2' }, fields)])
    )
  );

  const history = $('job-history');
  if (job && (job.history || []).length) {
    history.innerHTML = `<h3>History</h3><ul>${job.history
      .slice()
      .reverse()
      .map((entry) => `<li>${escapeHtml(String(entry.at).replace('T', ' ').slice(0, 16))} - ${escapeHtml(entry.type === 'status' ? `${entry.from || '-'} -> ${entry.to}` : entry.type)}${entry.note ? ` (${escapeHtml(entry.note)})` : ''}</li>`)
      .join('')}</ul>`;
    history.hidden = false;
  } else {
    history.hidden = true;
  }

  $('job-dialog').showModal();
}

function collectForm(container) {
  const payload = {};
  for (const field of state.schema.fields) {
    const control = container.querySelector(`[name="${field.key}"]`);
    if (!control) continue;
    payload[field.key] = field.type === 'boolean' ? control.checked : control.value;
  }
  return payload;
}

async function saveJob(allowDuplicate = false) {
  const payload = { ...collectForm($('job-fields')), allowDuplicate };
  try {
    if (state.editingId) {
      await api(`/api/jobs/${state.editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Job updated', 'ok');
    } else {
      await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
      toast('Job added to the tracker', 'ok');
    }
    $('job-dialog').close();
    refresh();
  } catch (err) {
    if (err.status === 409 && confirm(`${err.message}. Add it anyway?`)) return saveJob(true);
    const box = $('job-errors');
    box.innerHTML = `<ul>${(err.payload?.errors || [err.message]).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
    box.hidden = false;
  }
}

// ----------------------------------------------------- the "CV saved" dialog
const INTAKE_FIELDS = ['role', 'company', 'jobUrl', 'location', 'status', 'priority', 'cvVersion', 'notes'];

async function loadPending(showDialog = true) {
  const data = await api('/api/pending');
  state.pending = data.pending || [];
  const dialog = $('intake-dialog');
  if (!state.pending.length) {
    // Whatever it was showing has been dealt with elsewhere.
    if (dialog.open) dialog.close();
    state.shownPendingId = null;
    return state.pending;
  }
  // Re-render if the dialog is showing a prompt that is no longer first in line.
  if (showDialog && (!dialog.open || state.shownPendingId !== state.pending[0].id)) showIntake();
  return state.pending;
}

function showIntake() {
  const entry = state.pending[0];
  if (!entry) {
    $('intake-dialog').close();
    state.shownPendingId = null;
    return;
  }
  state.shownPendingId = entry.id;
  const suggestion = entry.suggestion || {};
  $('intake-sub').textContent = suggestion.cvFilePath
    ? `You just saved ${suggestion.cvFilePath.split(/[\\/]/).pop()} in Parsable CV.`
    : 'Parsable CV just saved a CV.';
  $('intake-count').textContent = state.pending.length > 1 ? `${state.pending.length} CVs waiting` : '';

  const duplicate = state.jobs.find(
    (job) =>
      (suggestion.jobUrl && job.jobUrl && job.jobUrl.replace(/[?#].*$/, '') === suggestion.jobUrl.replace(/[?#].*$/, '')) ||
      (suggestion.role && suggestion.company &&
        job.role.toLowerCase() === suggestion.role.toLowerCase() &&
        job.company.toLowerCase() === suggestion.company.toLowerCase())
  );
  const dupBox = $('intake-duplicate');
  if (duplicate) {
    dupBox.textContent = `You already track "${duplicate.role} at ${duplicate.company}" (${duplicate.status}). Adding it again will create a second row.`;
    dupBox.hidden = false;
  } else {
    dupBox.hidden = true;
  }

  const fields = state.schema.fields.filter((field) => INTAKE_FIELDS.includes(field.key));
  $('intake-fields').replaceChildren(
    ...fields.map((field) => fieldInput(field, suggestion[field.key] ?? (field.key === 'status' ? 'Applied' : field.default)))
  );
  if (!$('intake-dialog').open) $('intake-dialog').showModal();
  setTimeout(() => $('intake-fields').querySelector('input')?.focus(), 30);
}

async function acceptIntake(allowDuplicate = false) {
  const entry = state.pending[0];
  if (!entry) return;
  const payload = { ...collectForm($('intake-fields')), cvFilePath: entry.suggestion.cvFilePath, source: 'Parsable CV', allowDuplicate };
  try {
    await api(`/api/pending/${entry.id}/accept`, { method: 'POST', body: JSON.stringify(payload) });
    toast('Added to your job tracker', 'ok');
    state.pending.shift();
    await refresh();
    state.pending.length ? showIntake() : $('intake-dialog').close();
  } catch (err) {
    if (err.status === 409 && confirm(`${err.message}. Add it anyway?`)) return acceptIntake(true);
    if (err.status === 404) {
      // Added or dismissed somewhere else (the CV app, another tab) while open.
      toast('That CV was already dealt with elsewhere.', 'error');
      await refresh();
      await loadPending(true);
      return undefined;
    }
    toast(err.message, 'error');
  }
  return undefined;
}

async function dismissIntake() {
  const entry = state.pending[0];
  if (!entry) return;
  try {
    await api(`/api/pending/${entry.id}/dismiss`, { method: 'POST' });
  } catch { /* already gone is fine */ }
  state.pending.shift();
  if (state.pending.length) showIntake();
  else {
    $('intake-dialog').close();
    state.shownPendingId = null;
  }
}

// -------------------------------------------------------------------- settings
async function openSettings() {
  const data = await api('/api/settings');
  state.settings = data.settings;
  $('cv-path').value = data.settings.parsableCvPath || '';
  $('watch-toggle').checked = Boolean(data.settings.watchParsableCv);
  $('data-file-path').textContent = `Data: ${data.dataFile}`;
  $('snippet-code').textContent = `<script src="http://127.0.0.1:${data.port}/integration/tracki-bridge.js"><\/script>`;

  const status = $('settings-status');
  if (data.watcher.error) {
    status.className = 'banner banner-error';
    status.textContent = data.watcher.error;
    status.hidden = false;
  } else if (data.watcher.watching) {
    status.className = 'banner';
    status.textContent = `Watching ${data.watcher.path}`;
    status.hidden = false;
  } else {
    status.hidden = true;
  }
  $('settings-dialog').showModal();
}

async function saveSettings() {
  try {
    const data = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ parsableCvPath: $('cv-path').value, watchParsableCv: $('watch-toggle').checked }),
    });
    if (data.watcher.error) toast(data.watcher.error, 'error');
    else if (data.watcher.watching) toast('Connected to Parsable CV folder', 'ok');
    else toast('Settings saved', 'ok');
    $('settings-dialog').close();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ------------------------------------------------------------------ live feed
function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('pending', async () => {
    await refresh();
    await loadPending(true);
  });
  source.addEventListener('jobs', () => refresh());
  source.addEventListener('pending-cleared', () => loadPending(true));
  source.onerror = () => { /* EventSource retries on its own */ };
}

// ----------------------------------------------------------------------- wiring
async function init() {
  state.schema = await api('/api/schema');
  const statusFilter = $('filter-status');
  for (const status of state.schema.statuses) statusFilter.append(el('option', { value: status, text: status }));

  $('add-job').onclick = () => openJobDialog();
  $('empty-add').onclick = () => openJobDialog();
  $('job-save').onclick = () => saveJob();
  $('job-cancel').onclick = () => $('job-dialog').close();
  $('job-delete').onclick = async () => {
    if (!state.editingId || !confirm('Delete this job from the tracker?')) return;
    await api(`/api/jobs/${state.editingId}`, { method: 'DELETE' });
    $('job-dialog').close();
    toast('Deleted', 'ok');
    refresh();
  };

  $('intake-accept').onclick = () => acceptIntake();
  $('intake-dismiss').onclick = () => dismissIntake();

  $('settings-btn').onclick = openSettings;
  $('settings-save').onclick = saveSettings;
  $('settings-cancel').onclick = () => $('settings-dialog').close();
  $('copy-snippet').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('snippet-code').textContent);
      toast('Copied', 'ok');
    } catch {
      toast('Copy failed - select the text manually', 'error');
    }
  };

  const menuBtn = $('export-menu-btn');
  menuBtn.onclick = (event) => {
    event.stopPropagation();
    const panel = $('export-menu');
    panel.hidden = !panel.hidden;
    menuBtn.setAttribute('aria-expanded', String(!panel.hidden));
  };
  document.addEventListener('click', () => { $('export-menu').hidden = true; });

  $('import-btn').onclick = () => $('import-file').click();
  $('import-file').onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const result = await api('/api/import', { method: 'POST', body: await file.text() });
      toast(`Imported ${result.added}, skipped ${result.skipped} duplicate(s)`, 'ok');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      event.target.value = '';
    }
  };

  let searchTimer;
  $('search').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refresh, 180);
  };
  $('filter-status').onchange = refresh;
  $('sort').onchange = refresh;

  await refresh();
  await loadPending(true);
  connectEvents();
}

init().catch((err) => {
  document.body.prepend(el('div', { class: 'banner banner-error', text: `Could not start Tracki: ${err.message}` }));
});
