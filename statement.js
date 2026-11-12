// Reads a Bank of America credit card statement PDF entirely on this device.
// Nothing here makes a network request.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TX_LINE = /^(\d{2})\/(\d{2}) \d{2}\/\d{2} (.+?) \d{4} \d{4} (-?[\d,]+\.\d{2})$/;
const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const clean = s => s.replace(/\s+/g, ' ').trim();

/** Rebuild text lines from pdf.js text items (grouped by baseline, ordered left to right). */
export async function pdfToLines(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    const rows = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4], y = it.transform[5], h = Math.abs(it.transform[3]) || 8;
      let row = rows.find(r => Math.abs(r.y - y) < Math.max(2, h * 0.35));
      if (!row) rows.push(row = { y, items: [] });
      row.items.push({ x, w: it.width, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      let out = '', end = null;
      for (const it of r.items) {
        if (end !== null && it.x - end > 1.5 && !out.endsWith(' ') && !it.s.startsWith(' ')) out += ' ';
        out += it.s; end = it.x + it.w;
      }
      lines.push(clean(out));
    }
    page.cleanup();
  }
  await doc.destroy();
  return lines;
}

/** Parse statement lines into { year, month, name, start, end, tx:[{d,a,dt,fee}] }. Throws if totals don't match. */
export function parseStatement(lines) {
  const text = lines.join('\n');
  const m = text.match(/Statement Closing Date (\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) throw new Error('This doesn’t look like a Bank of America credit card statement (no closing date found).');
  const cy = +m[3], cm = +m[1], cd = +m[2];
  let start = null;
  const p = text.match(/([A-Z][a-z]+) (\d{1,2}) - ([A-Z][a-z]+) (\d{1,2}), (\d{4})/);
  if (p && MONTHS.includes(p[1])) {
    const sm = MONTHS.indexOf(p[1]) + 1;
    start = iso(cy - (sm > cm ? 1 : 0), sm, +p[2]);
  }
  let section = null, stated = null;
  const tx = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^Payments and Other Credits$/.test(line)) section = 'payments';
    else if (/^Purchases and Adjustments$/.test(line)) section = 'purchases';
    else if (/^Fees Charged$/.test(line)) section = 'fees';
    else if (/^Interest Charged$/.test(line)) section = 'interest';
    else if (line.startsWith('TOTAL PURCHASES AND ADJUSTMENTS FOR THIS PERIOD')) {
      stated = parseFloat(line.split('$').pop().replace(/,/g, '')); section = null;
    } else if (line.startsWith('TOTAL ')) section = null;
    else if (section === 'purchases' || section === 'fees' || section === 'interest') {
      const t = line.match(TX_LINE);
      if (!t) continue;
      const mo = +t[1], day = +t[2], amt = parseFloat(t[4].replace(/,/g, ''));
      if (!amt) continue;
      tx.push({ d: clean(t[3]), a: Math.round(amt * 100) / 100, dt: iso(cy - (mo > cm ? 1 : 0), mo, day), fee: section !== 'purchases' });
    }
  }
  const purchases = Math.round(tx.filter(t => !t.fee).reduce((s, t) => s + t.a, 0) * 100) / 100;
  if (stated === null) throw new Error('Couldn’t find the purchases total in this statement.');
  if (Math.abs(purchases - stated) > 0.005)
    throw new Error(`Read $${purchases.toFixed(2)} of purchases but the statement says $${stated.toFixed(2)}, so it wasn’t added.`);
  return { year: cy, month: cm, name: MONTHS[cm - 1], start, end: iso(cy, cm, cd), tx, stated };
}
