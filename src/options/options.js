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

// Pages can't link to chrome:// addresses, so open it as a tab. With this
// page as its opener, it nests under it like the other links here. Set up
// first, before settings load, so even a very quick click works.
const appearanceLink = document.getElementById('appearance-link');
appearanceLink.addEventListener('click', async (event) => {
  event.preventDefault();
  const current = await chrome.tabs.getCurrent();
  chrome.tabs.create({ url: appearanceLink.href, openerTabId: current?.id });
});

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

