/**
 * Copyright 2018 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const SRC_PATH = path.join(__dirname, 'src');
const DST_PATH = path.join(__dirname, 'docs');

if (os.platform() === 'win32') {
  console.error('ERROR: build is not supported on Win32');
  process.exit(1);
  return;
}

(async () => {
  const startTime = Date.now();
  const BUILD_VERSION = await generateVersion();

  await step(`1. cleanup output folder`, async () => {
    let cnameText = null;
    const cnamePath = path.join(DST_PATH, 'CNAME');
    if (fs.existsSync(cnamePath))
      cnameText = fs.readFileSync(cnamePath, 'utf8');
    await rmAsync(DST_PATH);
    fs.mkdirSync(DST_PATH);
    if (cnameText)
      fs.writeFileSync(cnamePath, cnameText, 'utf8');
  });

  await step('2. generate index.js', async () => {
    const rollup = require('rollup');
    const UglifyJS = require('uglify-es');

    const bundle = await rollup.rollup({input: path.join(SRC_PATH, 'index.js')});
    const {code} = await bundle.generate({format: 'iife'});
    const result = UglifyJS.minify(code);
    if (result.error) {
      console.error('JS Minification failed: ' + result.error);
      process.exit(1);
      return;
    }

    const header = '/* THIS FILE IS GENERATED BY build.js */\n\n';
    const versionScript = `window.__WEBSITE_VERSION__ = "${BUILD_VERSION}";\n`;
    const scriptContent = header + versionScript + result.code;
    fs.writeFileSync(path.join(DST_PATH, 'index.js'), scriptContent, 'utf8');
  });

  await step('3. generate style.css', async () => {
    const csso = require('csso');

    const stylePaths = [];
    stylePaths.push(...(await globAsync(SRC_PATH, 'ui/**/*.css')));
    stylePaths.push(...(await globAsync(SRC_PATH, 'pptr/**/*.css')));
    stylePaths.push(...(await globAsync(SRC_PATH, 'third_party/**/*.css')));
    const styles = stylePaths.map(stylePath => fs.readFileSync(stylePath, 'utf8'));
    const styleContent = '/* THIS FILE IS GENERATED BY build.js */\n\n' + csso.minify(styles.join('\n'), {restructure: false}).css;
    fs.writeFileSync(path.join(DST_PATH, 'style.css'), styleContent, 'utf8');
  });

  await step('4. generate index.html', async () => {
    // Launch browser, replace stylesheet links with concat style and generate index.html
    const pptr = require('puppeteer');
    const browser = await pptr.launch();
    const [page] = await browser.pages();
    await page.setJavaScriptEnabled(false);
    await page.goto('file://' + path.join(SRC_PATH, 'index.html'), {waitUnit: 'domcontentloaded'});
    await page.evaluate(() => {
      const $$ = selector => Array.from(document.querySelectorAll(selector));
      const links = $$('link[rel=stylesheet]').filter(link => link.href.startsWith('file://'));
      links.shift().href = '/style.css';
      links.forEach(link => link.remove());
    });
    const indexContent = '<!-- THIS FILE IS GENERATED BY build.js -->\n\n' + (await page.content()).split('\n').filter(line => !/^\s*$/.test(line)).join('\n');
    await browser.close();
    fs.writeFileSync(path.join(DST_PATH, 'index.html'), indexContent, 'utf8');
  });

  await step('5. copy images and favicons', async () => {
    // 5. Copy images and favicons into dist/
    await cpAsync(path.join(SRC_PATH, 'images'), path.join(DST_PATH, 'images'));
    await cpAsync(path.join(SRC_PATH, 'favicons'), path.join(DST_PATH, 'favicons'));
  });

  await step('6. generate sw.js', async () => {
    const {injectManifest} = require('workbox-build');

    const {count, size} = await injectManifest({
      swSrc: path.join(SRC_PATH, 'sw-template.js'),
      swDest: path.join(DST_PATH, 'sw.js'),
      globDirectory: DST_PATH,
      globIgnores: ['CNAME'],
      globPatterns: ['**/*']
    });
    const kbSize = Math.round(size / 1024 * 100) / 100;
    console.log(`  - sw precaches ${count} files, totaling ${kbSize} Kb.`);
  });


  const finish = Date.now();
  const seconds = Math.round((Date.now() - startTime) / 100) / 10;
  console.log(`\nBuild ${BUILD_VERSION} is done in ${seconds} seconds.`);
})();

function rmAsync(dirPath) {
  const rimraf = require('rimraf');
  return new Promise((resolve, reject) => {
    rimraf(dirPath, err => {
      if (err)
        reject(err);
      else
        resolve();
    });
  });
}

async function cpAsync(from, to) {
  const ncp = require('ncp').ncp;
  return new Promise((resolve, reject) => {
    ncp(from, to, err => {
      if (err)
        reject(err);
      else
        resolve();
    });
  });
}

async function writeAsync(path, content) {
  return new Promise((resolve, reject) => {
    fs.writeFile(INDEX_PATH, INDEX_CONTENT, 'utf8', err => {
      if (err)
        reject(err);
      else
        resolve();
    });
  });
}

async function step(name, callback) {
  console.time(name);
  await callback();
  console.timeEnd(name);
}

async function globAsync(cwd, pattern) {
  const glob = require('glob');
  return new Promise((resolve, reject) => {
    glob(pattern, {cwd}, (err, files) => {
      if (err)
        reject(err);
      else
        resolve(files.map(file => path.join(cwd, file)));
    });
  });
}

async function generateVersion() {
  // Version consists of semver and commit SHA.
  const {stdout} = await execAsync('git log -n 1 --pretty=format:%h');
  const semver = require('./package.json').version;
  return semver + '+' + stdout;
}

async function execAsync(command) {
  const {exec} = require('child_process');
  return new Promise((resolve, reject) => {
    exec(command, (err, stdout, stderr) => {
      if (err !== null)
        reject(err);
      else
        resolve({stdout, stderr});
    });
  });
}
