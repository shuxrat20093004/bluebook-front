const fs = require('fs');
const asarPath = 'C:/Users/Abdurahmon/AppData/Local/Programs/bluebook/resources/app.asar';
const buf = fs.readFileSync(asarPath);
console.log('Read asar, size:', buf.length);

const keywords = ['Test Your Device', 'device-check', 'deviceCheck', 'Testing Your Device', 'Test your device', 'Device Readiness', 'Checking your device'];
for (const kw of keywords) {
  let idx = 0;
  let count = 0;
  while ((idx = buf.indexOf(kw, idx)) !== -1 && count < 3) {
    console.log(`=== Keyword: "${kw}" at ${idx} ===`);
    console.log(buf.slice(Math.max(0, idx - 100), Math.min(buf.length, idx + 300)).toString('utf8'));
    idx += kw.length;
    count++;
  }
}
