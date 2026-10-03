'use strict';
const input = document.querySelector('#code');
const status = document.querySelector('#status');
document.querySelector('#generate').addEventListener('click', () => {
  input.value = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2,'0')).join('');
  document.querySelector('#generated').hidden = false;
  status.textContent = 'Generated locally. Save this code privately before deploying.';
});
document.querySelector('#copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(input.value); status.textContent = 'Copied. Keep your clipboard private.'; }
  catch { input.focus(); input.select(); status.textContent = 'Copy the selected code manually.'; }
});
document.querySelector('#hide').addEventListener('click', () => {
  input.value = ''; document.querySelector('#generated').hidden = true; status.textContent = 'Cleared from this page.';
});
