const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const file = path.join(__dirname,'.env');
if (!fs.existsSync(file)) {
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file,`HOST=127.0.0.1\nPORT=8080\nversion=0.56\nsharedVersion=1\nSalt=${secret}\nLeagueSalt=${secret}\nLeagueXSalt=${secret}\nLoginSalt=${secret}\nDATA_FILE=data/coral.sqlite\n`);
}
