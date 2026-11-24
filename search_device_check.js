const fs = require('fs');

const mainJsPath = 'C:/Users/Abdurahmon/AppData/Local/Programs/bluebook/resources/app.asar/renderer/main.js';
const content = fs.readFileSync(mainJsPath, 'utf8');
console.log('main.js loaded, length:', content.length);

// Search for keywords related to device check / test your device
const keywords = ['Test Your Device', 'Test your device', 'Device check', 'device check', 'deviceCheck', 'Testing Your Device'];
for (const kw of keywords) {
  let idx = 0;
  let matches = 0;
  while ((idx = content.indexOf(kw, idx)) !== -1 && matches < 5) {
    console.log(`\n--- Match for "${kw}" at index ${idx} ---`);
    console.log(content.slice(Math.max(0, idx - 150), Math.min(content.length, idx + 400)));
    idx += kw.length;
    matches++;
  }
}
