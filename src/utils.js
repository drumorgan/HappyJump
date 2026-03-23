// Shared utilities used by both storefront (main.js) and admin (admin.js)

export function esc(str) {
  const el = document.createElement('span');
  el.textContent = str ?? '';
  return el.innerHTML;
}

export function $(v) {
  return '$' + Math.round(Number(v)).toLocaleString();
}

export function getStatusPillClass(status) {
  if (status === 'closed_clean') return 'clean';
  if (status === 'requested') return 'requested';
  if (status === 'purchased') return 'purchased';
  if (status === 'od_xanax' || status === 'od_ecstasy') return 'od';
  if (status === 'payout_sent') return 'payout';
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
  };
  return map[status] || status;
}

export function showToast(toastEl, msg, type = 'error') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${type}`;
}
