// Unit tests for the JSON-hardening helpers in lib/gemma.js.
// The helpers (stripFences / tryParse / validateStudy) are intentionally not
// part of the module's public API, so we re-compile the module source with a
// tiny appended export of its internals instead of modifying app code.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function loadInternals() {
  const file = path.join(__dirname, '..', 'lib', 'gemma.js');
  const src = fs.readFileSync(file, 'utf8');
  const probe = `
;module.exports.__testInternals = {
  stripFences: typeof stripFences === 'function' ? stripFences : undefined,
  tryParse: typeof tryParse === 'function' ? tryParse : undefined,
  validateStudy: typeof validateStudy === 'function' ? validateStudy : undefined,
};`;
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(src + probe, file);
  return m.exports.__testInternals || {};
}

const internals = loadInternals();

function requireFn(t, name) {
  const fn = internals[name];
  if (typeof fn !== 'function') {
    t.skip(`${name} not reachable in lib/gemma.js`);
    return null;
  }
  return fn;
}

test('tryParse: strips ```json fences and parses the object', (t) => {
  const tryParse = requireFn(t, 'tryParse');
  if (!tryParse) return;
  const raw = '```json\n{"summary":"s","flashcards":[],"quiz":[]}\n```';
  assert.deepEqual(tryParse(raw), { summary: 's', flashcards: [], quiz: [] });
});

test('tryParse: bare JSON passes through unchanged', (t) => {
  const tryParse = requireFn(t, 'tryParse');
  if (!tryParse) return;
  assert.deepEqual(tryParse('{"a":1,"b":[2,3]}'), { a: 1, b: [2, 3] });
});

test('tryParse: garbage returns null instead of throwing', (t) => {
  const tryParse = requireFn(t, 'tryParse');
  if (!tryParse) return;
  assert.equal(tryParse('sorry, I cannot read this image'), null);
  assert.equal(tryParse(''), null);
  assert.equal(tryParse(null), null);
});

test('stripFences: cuts chatter around the outermost JSON object', (t) => {
  const stripFences = requireFn(t, 'stripFences');
  if (!stripFences) return;
  const raw = 'Here is your JSON:\n{"x": {"y": 1}}\nHope that helps!';
  assert.equal(stripFences(raw), '{"x": {"y": 1}}');
});

test('validateStudy: normalizes a valid study object (pads options, clamps answerIndex)', (t) => {
  const validateStudy = requireFn(t, 'validateStudy');
  if (!validateStudy) return;
  const out = validateStudy({
    summary: '  photosynthesis  ',
    flashcards: [{ front: 'Q', back: 'A' }, { bogus: true }],
    quiz: [{ question: 'Pick', options: ['a', 'b'], answerIndex: 9 }],
  });
  assert.equal(out.summary, 'photosynthesis');
  assert.deepEqual(out.flashcards, [{ front: 'Q', back: 'A' }]);
  assert.equal(out.quiz.length, 1);
  assert.equal(out.quiz[0].options.length, 4);
  assert.ok(out.quiz[0].answerIndex <= 3 && out.quiz[0].answerIndex >= 0);
});

test('validateStudy: rejects empty / malformed payloads', (t) => {
  const validateStudy = requireFn(t, 'validateStudy');
  if (!validateStudy) return;
  assert.equal(validateStudy(null), null);
  assert.equal(validateStudy('a string'), null);
  assert.equal(validateStudy({ summary: '', flashcards: [], quiz: [] }), null);
});
