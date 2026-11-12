# Spending

A private, on-device credit card spending dashboard that installs on an iPhone home screen.

- Statement PDFs are read **in the browser on the device** (pdf.js). Nothing is uploaded.
- Data is stored only in the device's IndexedDB. This repository contains code only, no data.
- A strict Content-Security-Policy allows the page to load only its own files, so it can't send data anywhere.
- Works offline after the first visit (service worker caches the app code).
- Backup and restore use a JSON file you keep yourself (Files / iCloud Drive).

Supports Bank of America credit card statement PDFs.

pdf.js is © Mozilla, Apache-2.0 (see `vendor/PDFJS-LICENSE`).
