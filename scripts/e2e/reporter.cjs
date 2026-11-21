const fs = require('node:fs');
const path = require('node:path');

// Deliberately omit error messages, call logs, stdout, request data and step
// arguments: browser assertion errors can otherwise retain generated passwords.
class SafeReporter {
  constructor() { this.results = []; this.setupErrors = 0; this.startedAt = Date.now(); }
  onBegin(_, suite) { console.log(`Starting ${suite.allTests().length} isolated browser checks.`); this.writeReport('running'); }
  onTestBegin(test) { console.log(`[${test.parent.project()?.name || ''}] running: ${test.title}`); }
  onTestEnd(test, result) {
    const record = {
      project: test.parent.project()?.name || '', title: test.title,
      status: result.status, expectedStatus: test.expectedStatus,
      durationMs: result.duration, retry: result.retry,
      errorCount: result.errors.length,
      failureLocations: result.errors.filter(error => error.location).map(error => ({ file: path.basename(error.location.file), line: error.location.line })),
    };
    this.results.push(record);
    this.writeReport('running');
    console.log(`[${record.project}] ${record.status}: ${record.title}`);
    for (const error of result.errors) {
      if (error.location) console.log(`  Failure location: ${path.basename(error.location.file)}:${error.location.line}`);
    }
  }
  onError() { this.setupErrors += 1; console.error('E2E setup/worker error. Sensitive diagnostics omitted.'); }
  writeReport(status, durationMs = Date.now() - this.startedAt) {
    const directory = path.resolve(__dirname, '../../test-results/e2e');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({
      status, durationMs, setupErrors: this.setupErrors, tests: this.results,
    }, null, 2) + '\n');
  }
  onEnd(result) {
    this.writeReport(result.status, result.duration);
    console.log(`E2E ${result.status}: ${this.results.length} executions; report: test-results/e2e/results.json`);
  }
}
module.exports = SafeReporter;
