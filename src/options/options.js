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

// Settings about collapsed trees don't apply while collapsing is turned off:
// they stay visible but disabled, with a note saying why.
function updateCollapsingRows() {
  const off = document.querySelector('[name=disableCollapsing]').checked;
  for (const row of document.querySelectorAll('[data-needs-collapsing]')) {
    row.classList.toggle('disabled', off);
    row.querySelector('[name]').disabled = off;
    let note = row.querySelector('.disabled-note');
    if (!note) {
      note = Object.assign(document.createElement('span'), {
        className: 'disabled-note',
        textContent: 'Not available while “Turn off collapsing” is on',
      });
      row.querySelector('.label').append(note);
    }
    note.hidden = !off;
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
    updateCollapsingRows();
  });
}
updateCollapsingRows();
