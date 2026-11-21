// Манифест веб-части для обновления приложения без переустановки (OTA): public/ota.json
// {"v": версия (sha256 от списка файлов), "files": {путь: sha256}}. Создаётся при выкладке и при сборке iOS.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..', 'public');
const files = {};
(function walk(dir) {
  for (const n of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, n), rel = path.relative(root, p).split(path.sep).join('/');
    if (n.startsWith('.') || rel === 'ota.json') continue;
    if (fs.statSync(p).isDirectory()) walk(p); else files[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
})(root);
const v = crypto.createHash('sha256').update(Object.keys(files).sort().map(k => k + ':' + files[k]).join('\n')).digest('hex').slice(0, 16);
fs.writeFileSync(path.join(root, 'ota.json'), JSON.stringify({ v, files }));
console.log('ota.json', v, Object.keys(files).length, 'files');
