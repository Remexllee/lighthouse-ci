/**
 * @license Copyright 2019 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/* eslint-env jest */

const fs = require('fs');
const path = require('path');
const {spawn, spawnSync} = require('child_process');
const fetch = require('isomorphic-fetch');
const log = require('lighthouse-logger');
const puppeteer = require('puppeteer');

const CLI_PATH = path.join(__dirname, '../src/cli.js');

function waitForCondition(fn) {
  let resolve;
  const promise = new Promise(r => (resolve = r));

  function checkConditionOrContinue() {
    if (fn()) return resolve();
    setTimeout(checkConditionOrContinue, 100);
  }

  checkConditionOrContinue();
  return promise;
}

describe('Lighthouse CI CLI', () => {
  const sqlFile = 'cli-test.tmp.sql';
  const rcFile = path.join(__dirname, 'fixtures/lighthouserc.json');
  const rcExtendedFile = path.join(__dirname, 'fixtures/lighthouserc-extended.json');

  let serverPort;
  let serverProcess;
  let serverProcessStdout = '';

  let projectToken;

  afterAll(() => {
    if (fs.existsSync(sqlFile)) fs.unlinkSync(sqlFile);
    serverProcess.kill();
  });

  describe('server', () => {
    it('should bring up the server and accept requests', async () => {
      serverProcess = spawn(CLI_PATH, ['server', '-p=0', `--storage.sqlDatabasePath=${sqlFile}`]);

      serverProcess.stdout.on('data', chunk => (serverProcessStdout += chunk.toString()));

      await waitForCondition(() => serverProcessStdout.includes('listening'));

      expect(serverProcessStdout).toMatch(/port \d+/);
      serverPort = serverProcessStdout.match(/port (\d+)/)[1];
    });

    it('should accept requests', async () => {
      const response = await fetch(`http://localhost:${serverPort}/v1/projects`);
      const projects = await response.json();
      expect(projects).toEqual([]);
    });
  });

  describe('wizard', () => {
    const ENTER_KEY = '\x0D';

    async function writeAllInputs(wizardProcess, inputs) {
      for (const input of inputs) {
        wizardProcess.stdin.write(input);
        wizardProcess.stdin.write(ENTER_KEY);
        // Wait for inquirer to write back our response, that's the signal we can continue.
        await waitForCondition(() => wizardProcess.stdoutMemory.includes(input));
        // Sometimes it still isn't ready though, give it a bit more time to process.
        await new Promise(r => setTimeout(r, process.env.CI ? 500 : 50));
      }

      wizardProcess.stdin.end();
    }

    it('should create a new project', async () => {
      const wizardProcess = spawn(CLI_PATH, ['wizard']);
      wizardProcess.stdoutMemory = '';
      wizardProcess.stdout.on('data', chunk => (wizardProcess.stdoutMemory += chunk.toString()));

      await waitForCondition(() => wizardProcess.stdoutMemory.includes('Which wizard'));
      await writeAllInputs(wizardProcess, [
        '', // Just ENTER key to select "new-project"
        `http://localhost:${serverPort}`, // The base URL to talk to
        'AwesomeCIProjectName', // Project name
        'https://example.com', // External build URL
      ]);

      const tokenSentence = wizardProcess.stdoutMemory
        .match(/Use token [\s\S]+/im)[0]
        .replace(log.bold, '')
        .replace(log.reset, '');
      projectToken = tokenSentence.match(/Use token ([\w-]+)/)[1];
    }, 30000);
  });

  describe('collect', () => {
    it('should collect results', () => {
      let {stdout = '', stderr = '', status = -1} = spawnSync(CLI_PATH, [
        'collect',
        `--rc-file=${rcFile}`,
        '--headful',
        '--url=chrome://version',
      ]);

      stdout = stdout.toString();
      stderr = stderr.toString();
      status = status || 0;

      expect(stdout).toMatchInlineSnapshot(`
        "Running Lighthouse 2 time(s)
        Run #1...done.
        Run #2...done.
        Done running Lighthouse!
        "
      `);
      expect(stderr.toString()).toMatchInlineSnapshot(`""`);
      expect(status).toEqual(0);
    }, 60000);
  });

  describe('report', () => {
    let uuids;
    it('should read LHRs from folders', () => {
      let {stdout = '', stderr = '', status = -1} = spawnSync(
        CLI_PATH,
        ['report', `--serverBaseUrl=http://localhost:${serverPort}`],
        {env: {...process.env, LHCI_TOKEN: projectToken}}
      );

      stdout = stdout.toString();
      stderr = stderr.toString();
      status = status || 0;

      const UUID_REGEX = /[0-9a-f-]{36}/gi;
      uuids = stdout.match(UUID_REGEX);
      const cleansedStdout = stdout.replace(UUID_REGEX, '<UUID>').replace(/:\d+/g, '<PORT>');
      expect(cleansedStdout).toMatchInlineSnapshot(`
        "Saving CI project AwesomeCIProjectName (<UUID>)
        Saving CI build (<UUID>)
        Saved LHR to http://localhost<PORT> (<UUID>)
        Saved LHR to http://localhost<PORT> (<UUID>)
        Done saving build results to Lighthouse CI
        "
      `);
      expect(stderr).toMatchInlineSnapshot(`""`);
      expect(status).toEqual(0);
      expect(uuids).toHaveLength(4);
    });

    it('should have saved lhrs to the API', async () => {
      const [projectId, buildId, runAId, runBId] = uuids;
      const response = await fetch(
        `http://localhost:${serverPort}/v1/projects/${projectId}/builds/${buildId}/runs`
      );

      const runs = await response.json();
      expect(runs.map(run => run.id)).toEqual([runBId, runAId]);
      expect(runs.map(run => run.url)).toEqual(['chrome://version', 'chrome://version']);
      expect(runs.map(run => JSON.parse(run.lhr))).toMatchObject([
        {requestedUrl: 'chrome://version'},
        {requestedUrl: 'chrome://version'},
      ]);
    });
  });

  describe('assert', () => {
    it('should assert failures', () => {
      let {stdout = '', stderr = '', status = -1} = spawnSync(CLI_PATH, [
        'assert',
        `--assertions.works-offline=error`,
      ]);

      stdout = stdout.toString();
      stderr = stderr.toString();
      status = status || 0;

      expect(stdout).toMatchInlineSnapshot(`""`);
      expect(stderr).toMatchInlineSnapshot(`
        "Checking assertions against 2 run(s)

        [31m✘[0m [1mworks-offline[0m failure for [1mminScore[0m assertion
              expected: >=[32m1[0m
                 found: [31m0[0m
            [2mall values: 0, 0[0m

        Assertion failed. Exiting with status code 1.
        "
      `);
      expect(status).toEqual(1);
    });

    it('should assert failures from an rcfile', () => {
      let {stdout = '', stderr = '', status = -1} = spawnSync(CLI_PATH, [
        'assert',
        `--assertions.first-contentful-paint=off`,
        `--assertions.speed-index=off`,
        `--assertions.interactive=off`,
        `--rc-file=${rcFile}`,
      ]);

      stdout = stdout.toString();
      stderr = stderr.toString();
      status = status || 0;

      const stderrClean = stderr.replace(/\d{4}/g, 'XXXX');
      expect(stdout).toMatchInlineSnapshot(`""`);
      expect(stderrClean).toMatchInlineSnapshot(`
        "Checking assertions against 2 run(s)

        [31m✘[0m [1mperformance-budget[0m.document.size failure for [1mmaxNumericValue[0m assertion
              expected: <=[32mXXXX[0m
                 found: [31mXXXX[0m
            [2mall values: XXXX[0m

        Assertion failed. Exiting with status code 1.
        "
      `);
      expect(status).toEqual(1);
    });

    it('should assert failures from an extended rcfile', () => {
      let {stdout = '', stderr = '', status = -1} = spawnSync(CLI_PATH, [
        'assert',
        `--assertions.speed-index=off`,
        `--assertions.interactive=off`,
        `--rc-file=${rcExtendedFile}`,
      ]);

      stdout = stdout.toString();
      stderr = stderr.toString();
      status = status || 0;

      const stderrClean = stderr.replace(/\d{4}/g, 'XXXX');
      expect(stdout).toMatchInlineSnapshot(`""`);
      // FIXME: first contentful paint can't be computed on `chrome://version`
      // Update this test and the URL to use LHCI Server UI once it's built
      expect(stderrClean).toMatchInlineSnapshot(`
        "Checking assertions against 2 run(s)

        [31m✘[0m [1mperformance-budget[0m.document.size failure for [1mmaxNumericValue[0m assertion
              expected: <=[32mXXXX[0m
                 found: [31mXXXX[0m
            [2mall values: XXXX[0m


        [31m✘[0m [1mfirst-contentful-paint[0m failure for [1mauditRan[0m assertion
              expected: ==[32m1[0m
                 found: [31m0[0m
            [2mall values: 0, 0[0m

        Assertion failed. Exiting with status code 1.
        "
      `);
      expect(status).toEqual(1);
    });
  });

  describe('ui', () => {
    /** @type {import('puppeteer').Browser} */
    let browser;
    /** @type {import('puppeteer').Page} */
    let page;

    beforeAll(async () => {
      browser = await puppeteer.launch();
    });

    afterAll(async () => {
      await browser.close();
    });

    it('should load the page', async () => {
      page = await browser.newPage();
      await page.goto(`http://localhost:${serverPort}/app`, {waitUntil: 'networkidle0'});
    });

    it('should list the projects', async () => {
      const contents = await page.evaluate('document.body.innerHTML');
      expect(contents).toContain('AwesomeCIProjectName');
    });
  });
});
