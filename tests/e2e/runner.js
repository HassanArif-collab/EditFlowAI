/**
 * tests/e2e/runner.js — Unified E2E Test Suite Runner for EditFlow AI.
 *
 * Executes all 4 tiers of opaque-box requirements-driven tests:
 *   - Tier 1: Feature Coverage (R1, R2, R3, R4)
 *   - Tier 2: Boundary & Corner Cases (R1, R2, R3, R4)
 *   - Tier 3: Pairwise Cross-Feature Interactions
 *   - Tier 4: Real-World Production Scenarios
 *
 * Usage:
 *   node tests/e2e/runner.js
 *   node tests/e2e/runner.js --tier=1
 *   node --test tests/e2e/*.test.js
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const TIERS = [
  { id: 1, name: 'Tier 1: Feature Coverage', file: 'tier1-features.test.js' },
  { id: 2, name: 'Tier 2: Boundary & Corner Cases', file: 'tier2-boundaries.test.js' },
  { id: 3, name: 'Tier 3: Cross-Feature Combinations', file: 'tier3-pairwise.test.js' },
  { id: 4, name: 'Tier 4: Real-World Scenarios', file: 'tier4-scenarios.test.js' },
];

function runTestFile(file) {
  return new Promise((resolve) => {
    const fullPath = path.join(__dirname, file);
    const proc = spawn(process.execPath, ['--test', fullPath], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      resolve({ file, code, stdout, stderr });
    });
  });
}

function parseTapOutput(output) {
  const tests = new Map();
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes('failing tests:') || trimmed.endsWith('.js') || !trimmed) continue;
    const passMatch = trimmed.match(/^✔\s+([^()]+)(?:\(([^)]+)\))?/);
    const failMatch = trimmed.match(/^✖\s+([^()]+)(?:\(([^)]+)\))?/);
    if (passMatch) {
      const name = passMatch[1].trim();
      tests.set(name, { name, pass: true, duration: passMatch[2] || '' });
    } else if (failMatch) {
      const name = failMatch[1].trim();
      tests.set(name, { name, pass: false, duration: failMatch[2] || '' });
    }
  }
  return Array.from(tests.values());
}

function categorizeTest(testName, fileName) {
  if (fileName.includes('tier3') || testName.startsWith('PAIR-')) return 'T3';
  if (fileName.includes('tier4') || testName.startsWith('SCENARIO')) return 'T4';
  const m = testName.match(/^F(\d+)-/);
  if (m) {
    const fNum = parseInt(m[1], 10);
    if (fNum === 4 || fNum === 5) return 'R1';
    if (fNum === 6 || fNum === 7) return 'R2';
    if (fNum === 8) return 'R3';
    return 'R4';
  }
  return 'R4';
}

async function run() {
  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║               EditFlow AI — 4-Tier E2E Test Suite Runner                ║');
  console.log('║      Authoritative Requirements: ORIGINAL_REQUEST.md & PROJECT.md       ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝\n');

  const args = process.argv.slice(2);
  const tierFilter = args.find((a) => a.startsWith('--tier='));
  const targetTier = tierFilter ? Number(tierFilter.split('=')[1]) : null;

  const activeTiers = targetTier ? TIERS.filter((t) => t.id === targetTier) : TIERS;
  const results = [];
  let totalPassed = 0;
  let totalFailed = 0;
  const startTime = Date.now();

  for (const tier of activeTiers) {
    console.log(`▶ Executing ${tier.name} (${tier.file})...`);
    const res = await runTestFile(tier.file);
    const parsed = parseTapOutput(res.stdout);
    const passed = parsed.filter((t) => t.pass).length;
    const failed = parsed.filter((t) => !t.pass).length;

    totalPassed += passed;
    totalFailed += failed;

    results.push({
      tier: tier.name,
      file: tier.file,
      total: parsed.length,
      passed,
      failed,
      tests: parsed,
      rawOutput: res.stdout,
    });

    console.log(`  ✓ ${passed} passed | ${failed ? `✗ ${failed} failed` : '0 failed'} (Total: ${parsed.length})\n`);
  }

  const durationMs = Date.now() - startTime;

  // Print Summary Table
  console.log('──────────────────────────────────────────────────────────────────────────');
  console.log('                           TIER SUMMARY RESULTS                           ');
  console.log('──────────────────────────────────────────────────────────────────────────');
  console.log('Tier                                Total   Passed   Failed   Status      ');
  console.log('──────────────────────────────────────────────────────────────────────────');
  for (const r of results) {
    const status = r.failed === 0 ? 'PASS' : 'DEFECTS DETECTED';
    const tierPadded = r.tier.padEnd(35);
    const totalPadded = String(r.total).padEnd(8);
    const passPadded = String(r.passed).padEnd(9);
    const failPadded = String(r.failed).padEnd(9);
    console.log(`${tierPadded} ${totalPadded} ${passPadded} ${failPadded} ${status}`);
  }
  console.log('──────────────────────────────────────────────────────────────────────────');
  console.log(`TOTALS: ${totalPassed + totalFailed} tests executed in ${durationMs}ms`);
  console.log(`Passed: ${totalPassed} | Failed: ${totalFailed}\n`);

  // Requirements Verification Matrix (computed dynamically from actual test results)
  const reqMap = {
    R1: { label: 'R1: UI Toggle Stability & Preview Resilience', total: 0, passed: 0, failed: 0 },
    R2: { label: 'R2: Multilingual BiDi Layout & Typography', total: 0, passed: 0, failed: 0 },
    R3: { label: 'R3: Persistent, Pasteable HEX Color Picker', total: 0, passed: 0, failed: 0 },
    R4: { label: 'R4: Senior Architecture & Load Optimization', total: 0, passed: 0, failed: 0 },
    T3: { label: 'T3: Cross-Feature Pairwise Combinations', total: 0, passed: 0, failed: 0 },
    T4: { label: 'T4: Real-World Production Scenarios', total: 0, passed: 0, failed: 0 },
  };

  for (const r of results) {
    for (const t of r.tests) {
      const key = categorizeTest(t.name, r.file);
      if (reqMap[key]) {
        reqMap[key].total++;
        if (t.pass) {
          reqMap[key].passed++;
        } else {
          reqMap[key].failed++;
        }
      }
    }
  }

  console.log('──────────────────────────────────────────────────────────────────────────');
  console.log('                    REQUIREMENTS VERIFICATION MATRIX                      ');
  console.log('──────────────────────────────────────────────────────────────────────────');
  for (const key of Object.keys(reqMap)) {
    const req = reqMap[key];
    if (req.total === 0) continue;
    const statusIcon = req.failed === 0 ? '[✓]' : '[!]';
    const statusText = req.failed === 0
      ? `${req.passed}/${req.total} PASSED`
      : `${req.passed}/${req.total} PASSED (${req.failed} Defect${req.failed > 1 ? 's' : ''})`;
    const labelPadded = req.label.padEnd(46);
    console.log(`${labelPadded} : ${statusIcon} ${statusText}`);
  }
  console.log('');

  if (totalFailed > 0) {
    console.log('──────────────────────────────────────────────────────────────────────────');
    console.log('              DEFECT ESCALATION REPORT (TO IMPLEMENTATION)                ');
    console.log('──────────────────────────────────────────────────────────────────────────');
    for (const r of results) {
      const fails = r.tests.filter((t) => !t.pass);
      for (const f of fails) {
        const reqKey = categorizeTest(f.name, r.file);
        console.log(`• Test: ${f.name}`);
        console.log(`  Tier: ${r.tier}`);
        console.log(`  Target Requirement: ${reqMap[reqKey] ? reqMap[reqKey].label : reqKey}`);
        console.log(`  Status: FAILED\n`);
      }
    }
  }

  console.log('──────────────────────────────────────────────────────────────────────────');
  console.log('Runner complete. E2E Test Suite is fully ready and operational.');
  console.log('──────────────────────────────────────────────────────────────────────────\n');

  // Exit with failure code if any test failed
  process.exit(totalFailed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner exception:', err);
  process.exit(1);
});
