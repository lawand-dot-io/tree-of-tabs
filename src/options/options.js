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
