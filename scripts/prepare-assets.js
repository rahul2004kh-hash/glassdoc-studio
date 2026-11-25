const fs = require('fs');
const path = require('path');

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('Copied:', dest);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
  console.log('Copied directory:', dest);
}

if (fs.existsSync('index.html') && !fs.existsSync('www/index.html')) {
  copyFile('index.html', 'www/index.html');
}

const libs = [
  ['node_modules/pdfjs-dist/build/pdf.min.js', 'www/vendor/pdf.min.js'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.js', 'www/vendor/pdf.worker.min.js'],
  ['node_modules/mammoth/mammoth.browser.min.js', 'www/vendor/mammoth.browser.min.js'],
  ['node_modules/pdf-lib/dist/pdf-lib.min.js', 'www/vendor/pdf-lib.min.js'],
  ['node_modules/jspdf/dist/jspdf.umd.min.js', 'www/vendor/jspdf.umd.min.js'],
  ['node_modules/html2canvas/dist/html2canvas.min.js', 'www/vendor/html2canvas.min.js']
];

for (const [src, dest] of libs) {
  if (!fs.existsSync(src)) {
    throw new Error('Missing required library file: ' + src);
  }
  copyFile(src, dest);
}

const fontPkgs = [
  ['node_modules/@fontsource/noto-sans-bengali', 'www/fonts/noto-sans-bengali'],
  ['node_modules/@fontsource/hind-siliguri', 'www/fonts/hind-siliguri']
];

for (const [src, dest] of fontPkgs) {
  if (fs.existsSync(src)) {
    copyDir(src, dest);
  }
}

console.log('All offline assets prepared successfully!');
