const fs = require('fs');
const path = require('path');

const root = 'C:/Users/Abdurahmon/AppData/Local/Programs/bluebook/resources/app.asar';
function list(dir, depth = 0) {
  if (depth > 3) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      console.log(' '.repeat(depth * 2) + e.name + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory() && e.name !== 'node_modules') {
        list(full, depth + 1);
      }
    }
  } catch (err) {
    console.error(err);
  }
}

list(root);
