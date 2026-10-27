import { DEFAULTS, loadSettings } from '../settings.js';

const fields = document.querySelectorAll('[name]');

function read(field) {
  if (field.type === 'checkbox') return field.checked;
  return typeof DEFAULTS[field.name] === 'number' ? Number(field.value) : field.value;
}

function write(field, value) {
  if (field.type === 'checkbox') field.checked = value;
  else field.value = String(value);
}

// Settings that don't apply because of another one stay visible but
// disabled, with a note saying why.
function setRowDisabled(row, reason) {
  row.classList.toggle('disabled', !!reason);
  row.querySelector('[name]').disabled = !!reason;
  let note = row.querySelector('.disabled-note');
  if (!note) {
    note = Object.assign(document.createElement('span'), { className: 'disabled-note' });
    row.querySelector('.label').append(note);
  }
  note.textContent = reason ?? '';
  note.hidden = !reason;
}

function updateDisabledRows() {
  const collapsingOff = document.querySelector('[name=disableCollapsing]').checked;
  const closeAll = document.querySelector('[name=onCloseParent]').value === 'closeAll';
  for (const row of document.querySelectorAll('[data-needs-collapsing]')) {
    const field = row.querySelector('[name]').name;
    let reason = collapsingOff ? 'Not available while “Turn off collapsing” is on' : null;
    if (!reason && field === 'closeCollapsedTree' && closeAll) {
      reason = 'Not needed: closing a parent already closes its children';
    }
    setRowDisabled(row, reason);
  }
}

const settings = await loadSettings();
for (const field of fields) {
  write(field, settings[field.name]);
  field.addEventListener('change', () => {
    const change = { [field.name]: read(field) };
    // Choosing here counts as answering the panel's first full screen question.
    if (field.name === 'hideInFullscreen') change.fullscreenChoiceMade = true;
    chrome.storage.sync.set(change);
    updateDisabledRows();
  });
}
updateDisabledRows();

// Taskbar, mentioned at the bottom, is a Mac app, so only Macs show that sentence.
const { os } = await chrome.runtime.getPlatformInfo();
document.getElementById('mac-apps').hidden = os !== 'mac';

// Chrome doesn't report tabs opened from extension pages as opened by a page,
// so links here wouldn't nest under this tab. Open them as its children
// through the worker instead: in front on a click, in the background on a
// middle or Ctrl/Cmd click, like ordinary links.
async function openAsChild(event) {
  const link = event.target.closest('a[href]');
  if (!link || event.shiftKey || event.button > 1) return;
  event.preventDefault();
  const background = event.button === 1 || event.ctrlKey || event.metaKey;
  const tab = await chrome.tabs.getCurrent();
  chrome.runtime.sendMessage({ type: 'new-child-tab', tabId: tab.id, url: link.href, active: !background });
}
document.addEventListener('click', openAsChild);
document.addEventListener('auxclick', openAsChild);
