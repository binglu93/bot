// check-deps.js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkgPath = path.resolve(process.cwd(), 'package.json');

if (!fs.existsSync(pkgPath)) {
  console.error('❌ package.json tidak ditemukan di folder ini!');
  process.exit(1);
}

const pkg = require(pkgPath);
const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);

console.log('🔍 Mengecek dependencies dari package.json...');

for (const dep of Object.keys(deps)) {
  try {
    require.resolve(dep);
    console.log(`✅ ${dep} sudah terinstall`);
  } catch (err) {
    console.log(`⚠️ ${dep} belum terinstall, menginstall...`);
    execSync(`npm install ${dep}`, { stdio: 'inherit' });
  }
}

console.log('🎉 Semua dependencies siap dipakai!');
