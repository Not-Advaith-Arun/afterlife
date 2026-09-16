/* Executes the SAME pure mutation path used by generated browser UI actions. */
"use strict";
const fs = require("node:fs");
const {validateRecords, applyOperation} = require("../afterlife/runtime.js");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
let records = validateRecords(input.spec, input.records);
const initial = records;
const outcomes = input.operations.map(operation => {
  let ok = true;
  try { records = applyOperation(input.spec, records, operation); }
  catch { ok = false; }
  return {ok, records};
});
process.stdout.write(JSON.stringify({initial, outcomes}));
