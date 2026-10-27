// Shared utilities used by both storefront (main.js) and admin (admin.js)

// Torn's API returns names with HTML entities already encoded (e.g. faction
// "Raven&#8217;s Hand"). Decode them to plain text first. A <textarea> parses
// its content as text, so nothing in the string can run or create elements.
export function decodeEntities(str) {
  const s = String(str ?? '');
  if (!s.includes('&')) return s;
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

// Decode Torn's entities, then escape for safe insertion into innerHTML —
// otherwise "&#8217;" is double-escaped and shows up literally.
export function esc(str) {
  const el = document.createElement('span');
  el.textContent = decodeEntities(str);
  // innerHTML escapes & < > but not quotes; esc() also feeds attribute values.
  return el.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function $(v) {
  return '$' + Math.round(Number(v)).toLocaleString('en-US');
}

export function getStatusPillClass(status) {
  if (status === 'closed_clean') return 'clean';
  if (status === 'requested') return 'requested';
  if (status === 'purchased') return 'purchased';
  if (status === 'od_xanax' || status === 'od_ecstasy') return 'od';
  if (status === 'payout_sent') return 'payout';
  if (status === 'rejected') return 'rejected';
  return '';
}

export function formatStatus(status) {
  const map = {
    requested: 'Requested',
    purchased: 'In Progress',
    closed_clean: 'Clean',
    od_xanax: 'Xanax OD',
    od_ecstasy: 'Ecstasy OD',
    payout_sent: 'Paid Out',
    rejected: 'Rejected',
  };
  return map[status] || status;
}

export function showToast(toastEl, msg, type = 'error') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${type}`;
}
