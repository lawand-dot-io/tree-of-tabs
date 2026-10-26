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

const settings = await loadSettings();
for (const field of fields) {
  write(field, settings[field.name]);
  field.addEventListener('change', () => chrome.storage.sync.set({ [field.name]: read(field) }));
}
