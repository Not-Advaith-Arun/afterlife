"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {validateRecords, validateEnvelope, escapeJSON, matches, applyOperation, defaultValue} = require("../afterlife/runtime.js");
const spec = require("../examples/task-tracker/app.json");
const records = require("../examples/task-tracker/records.json").records;

test("records normalize without mutating the source", () => {
  const source = {id: "new", title: "A note 😀", status: "Planned"};
  assert.deepEqual(validateRecords(spec, [source])[0], {...source, notes: "", hours: null, important: false});
  assert.equal(Object.hasOwn(source, "notes"), false);
});
test("import validation rejects wrong apps and changed contracts", () => {
  const payload = {spec, spec_fingerprint: "abc"};
  const envelope = {format: "afterlife-data/v1", app_id: spec.app_id, spec_fingerprint: "abc", records};
  assert.deepEqual(validateEnvelope(payload, envelope), records);
  for (const change of [{app_id: "other"}, {spec_fingerprint: "different"}, {format: "unknown"}, {unexpected: 1}]) {
    assert.throws(() => validateEnvelope(payload, {...envelope, ...change}));
  }
});
test("invalid imports fail as a whole", () => {
  for (const change of [{title: " "}, {hours: NaN}, {hours: true}, {hours: 2**53},
    {status: "Unknown"}, {important: "false"}, {extra: 1}, {notes: "\ud800"}]) {
    assert.throws(() => validateRecords(spec, [records[1], {...records[0], ...change}]));
  }
  assert.throws(() => validateRecords(spec, [records[0], records[0]]));
  assert.throws(() => validateRecords(spec, Array(10001).fill(records[0])));
});
test("prototype properties cannot substitute required data", () => {
  const inherited = Object.create(records[0]);
  assert.throws(() => validateRecords(spec, [inherited]));
  const polluted = JSON.parse('{"id":"x","title":"valid","status":"Done","__proto__":{"pwned":true}}');
  assert.throws(() => validateRecords(spec, [polluted]));
  assert.equal({}.pwned, undefined);
});
test("portable JSON cannot terminate its HTML data block", () => {
  const source = {text: '</script><script>alert(1)</script>&\u2028\u2029 😀'};
  const escaped = escapeJSON(source);
  assert.ok(!escaped.includes("<"));
  assert.deepEqual(JSON.parse(escaped), source);
});
test("search covers all fields and handles blanks", () => {
  assert.equal(matches(spec, records[0], " SENSOR "), true);
  assert.equal(matches(spec, records[0], "3"), true);
  assert.equal(matches(spec, records[0], ""), true);
  assert.equal(matches(spec, records[0], "missing"), false);
});

test("source defaults preserve false, zero, empty strings, and nullable numbers", () => {
  const sourceSpec = {fields: [
    {name: "title", label: "Title", type: "text", default: "Untitled"},
    {name: "active", label: "Active", type: "boolean", default: true},
    {name: "count", label: "Count", type: "integer", required: true, default: 2},
    {name: "estimate", label: "Estimate", type: "integer", default: null},
  ]};
  assert.deepEqual(sourceSpec.fields.map(defaultValue), ["Untitled", true, 2, null]);
  assert.deepEqual(validateRecords(sourceSpec, [{id: "one"}]), [{id: "one", title: "Untitled", active: true, count: 2, estimate: null}]);
  const explicit = {id: "one", title: "", active: false, count: 0, estimate: 0};
  assert.deepEqual(validateRecords(sourceSpec, [explicit]), [explicit]);
  assert.throws(() => validateRecords(sourceSpec, [{id: "one", count: null}]));
});

test("mutation path is atomic, validates changes, and preserves order", () => {
  const initial = structuredClone(records);
  const created = applyOperation(spec, initial, {op: "create", record: {id: "new", title: "New", status: "Planned"}});
  assert.equal(initial.length, 3);
  assert.equal(created.length, 4);
  const edited = applyOperation(spec, created, {op: "edit", id: "new", changes: {hours: 0}});
  assert.equal(edited[3].hours, 0);
  assert.equal(created[3].hours, null);
  for (const operation of [
    {op: "edit", id: "new", changes: {hours: 1.5}},
    {op: "edit", id: "new", changes: {id: "rename"}},
    {op: "edit", id: "missing", changes: {}},
    {op: "delete", id: "missing"},
    {op: "create", record: {id: "new", title: "Duplicate", status: "Planned"}},
    {op: "create", record: {id: "bad", title: "Bad", status: "Planned", unknown: true}},
    {op: "edit", id: "new", changes: JSON.parse('{"__proto__": {"x": 1}}')},
    {op: "delete", id: "new", extra: true}, {op: "constructor"}, null,
  ]) assert.throws(() => applyOperation(spec, edited, operation));
  assert.equal(edited[3].hours, 0);
  assert.equal(edited.length, 4);
  assert.deepEqual(applyOperation(spec, edited, {op: "delete", id: "new"}), initial);
});

test("nonempty text follows the same Unicode whitespace rules as Python", () => {
  for (const whitespace of ["\u001c", "\u0085", "\u2007", "\u3000"]) {
    assert.throws(() => validateRecords(spec, [{...records[0], id: whitespace}]));
    assert.throws(() => validateRecords(spec, [{...records[0], title: whitespace}]));
  }
  assert.equal(validateRecords(spec, [{...records[0], id: "\ufeff"}])[0].id, "\ufeff");
});
