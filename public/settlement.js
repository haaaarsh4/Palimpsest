// public/settlement.js
//
// The settlement-research page. It is a shell: the same card, the same form
// and the same chips as the rest of the site, with nothing behind them yet.
//
// The reading that will sit here does not exist, so the form, the example
// chips and any address handed over in the query string all resolve to a
// no-op. The page cannot reach the backend and cannot look as though it has
// measured something it has not.
//
// When the reading is built it belongs in srRun: resolve the address, ask for
// the site's captures, and draw them. Until then this file holds the shape of
// that flow and nothing else.

// The reading is switched off. While this is true the button, the chips and any
// address in the query string do nothing at all. Flip it to false to put the
// reading back.
const SR_PAUSED = true;

const el = (id) => document.getElementById(id);

async function srRun(rawUrl) {
  // No silent no-ops: a button that ignores a press reads as a frozen page.
  // The reading behind this form does not exist yet, so while the flag above
  // holds, a submit says so out loud instead of pretending to work.
  if (SR_PAUSED) {
    const note = el('srNote');
    if (note) {
      note.hidden = false;
      note.textContent =
        'This reading is not built yet. The form above is the shape of it — resolving an ' +
        'address, reading its captures year by year, and drawing what changed — but there is ' +
        'no analysis behind it, so nothing has been measured and nothing is loading.';
    }
    return;
  }
  const target = String(rawUrl || '').trim();
  if (!target) return;
  return null;
}

el('srForm').addEventListener('submit', (e) => {
  e.preventDefault();
  srRun(el('srInput').value);
});

document.querySelectorAll('.example-chips .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    el('srInput').value = chip.dataset.url;
    srRun(chip.dataset.url);
  });
});

const initial = new URL(location.href).searchParams.get('url');
if (initial) {
  el('srInput').value = initial;
  srRun(initial);
}
