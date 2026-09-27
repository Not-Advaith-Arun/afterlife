(function () {
  "use strict";
  const MAX_RECORDS = 10000;
  const MAX_BYTES = 10 * 1024 * 1024;
  const MAX_INTEGER_INPUT_LENGTH = 10000;
  const PAGE_SIZE = 100;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const textLength = value => [...value].length;
  const defaultValue = field => own(field, "default") ? field.default :
    field.type === "boolean" ? false : field.type === "integer" ? null : "";
  const validText = (value, max) => typeof value === "string" && textLength(value) <= max &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
  // Match Python str.strip() whitespace, including U+0085 but excluding U+FEFF.
  const blankText = value => /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u.test(value);

  function normalizeRecords(spec, records, onRecord) {
    if (!Array.isArray(records) || records.length > MAX_RECORDS) {
      throw new Error("Expected at most 10,000 records.");
    }
    const names = new Set(["id", ...spec.fields.map(field => field.name)]);
    const seen = new Set();
    return records.map((record, index) => {
      const context = `Record ${index + 1}`;
      if (!isObject(record) || Object.keys(record).some(key => !names.has(key))) {
        throw new Error(`${context} contains unknown fields or is not an object.`);
      }
      if (!own(record, "id") || !validText(record.id, 100) || blankText(record.id) || seen.has(record.id)) {
        throw new Error(`${context} needs a unique, nonempty text ID of at most 100 characters.`);
      }
      seen.add(record.id);
      const result = {id: record.id};
      for (const field of spec.fields) {
        const value = own(record, field.name) ? record[field.name] : defaultValue(field);
        const label = `${context}: ${field.label}`;
        if (field.type === "boolean") {
          if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`);
        } else if (field.type === "integer") {
          if (value !== null && !Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer or null.`);
          if (field.required && value === null) throw new Error(`${label} is required.`);
        } else {
          if (!validText(value, 10000)) throw new Error(`${label} must be valid text of at most 10,000 characters.`);
          if (field.required && blankText(value)) throw new Error(`${label} is required.`);
          if (field.type === "select" && value !== "" && !field.options.includes(value)) {
            throw new Error(`${label} is not an allowed choice.`);
          }
        }
        result[field.name] = value;
      }
      if (onRecord) onRecord(result, index);
      return result;
    });
  }

  function validateRecords(spec, records) {
    return normalizeRecords(spec, records);
  }

  function sortRecords(spec, records, fieldName, descending = false) {
    if (!fieldName) return [...records];
    const field = spec.fields.find(item => item.name === fieldName);
    if (!field) throw new Error("Choose a declared field to sort records.");
    return records.map((record, index) => ({record, index})).sort((left, right) => {
      const a = left.record[fieldName], b = right.record[fieldName];
      const absentA = a === null || a === "", absentB = b === null || b === "";
      if (absentA !== absentB) return absentA ? 1 : -1;
      const x = typeof a === "string" ? a.toLowerCase() : a;
      const y = typeof b === "string" ? b.toLowerCase() : b;
      const compared = x < y ? -1 : x > y ? 1 : 0;
      return (descending ? -compared : compared) || left.index - right.index;
    }).map(item => item.record);
  }

  function exactIntegerInput(value) {
    const text = value.trim();
    if (text.length > MAX_INTEGER_INPUT_LENGTH || !Number.isSafeInteger(Number(text))) return false;
    const parts = text.match(/^[+-]?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
    if (!parts || !(parts[1] || parts[2])) return false;
    const fraction = parts[2] || "";
    const digits = (parts[1] + fraction).replace(/^0+/, "");
    if (!digits) return true;
    // Decimal digits must cancel exactly before Number can round a fraction or
    // underflow it to zero. Inspect exponents without constructing huge powers.
    const trailingZeros = digits.length - digits.replace(/0+$/, "").length;
    return fraction.length - Number(parts[3] || 0) <= trailingZeros;
  }

  function parseDataJSON(text) {
    const value = JSON.parse(text); // Syntax remains the platform parser's responsibility.
    let quoted = false, escaped = false, start = 0;
    const containers = [];
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') {
          quoted = false;
          let next = index + 1;
          while (next < text.length && /\s/.test(text[next])) next += 1;
          if (text[next] === ":") {
            const key = JSON.parse(text.slice(start, index + 1));
            const keys = containers[containers.length - 1];
            if (keys.has(key)) throw new Error("Duplicate JSON key.");
            keys.add(key);
          }
        }
      } else if (character === '"') { quoted = true; start = index; }
      else if (character === "{") containers.push(new Set());
      else if (character === "[") containers.push(null);
      else if (character === "}" || character === "]") containers.pop();
      else if (character === "-" || /[0-9]/.test(character)) {
        let end = index + 1;
        while (end < text.length && /[0-9.eE+-]/.test(text[end])) end += 1;
        if (!exactIntegerInput(text.slice(index, end))) throw new Error("JSON numbers must be exact safe integers.");
        index = end - 1;
      }
    }
    return value;
  }

  function exportCSV(spec, records) {
    const columns = [{name: "id"}, ...spec.fields];
    const quoted = (value, protectText = true) => {
      let text = value === null ? "" : String(value);
      if (protectText && typeof value === "string" && text) text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    const rows = [columns.map(field => quoted(field.name, false)).join(",")];
    let bytes = new TextEncoder().encode(rows[0] + "\r\n").byteLength;
    for (const record of validateRecords(spec, records)) {
      const row = columns.map(field => quoted(record[field.name])).join(",");
      bytes += new TextEncoder().encode(row + "\r\n").byteLength;
      if (bytes > MAX_BYTES) throw new Error("CSV exceeds 10 MiB. Use JSON or split the collection.");
      rows.push(row);
    }
    return rows.join("\r\n") + "\r\n";
  }

  function printableRecords(spec, records, total) {
    const escape = value => String(value).replace(/[&<>"']/g, character => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[character]);
    const columns = [{name:"id",label:"Record ID",type:"text"}, ...spec.fields];
    const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(spec.title)} — Printable records</title><style>body{font:12px/1.5 system-ui,sans-serif;color:#111;margin:2rem}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{text-align:left;vertical-align:top;border:1px solid #999;padding:.4rem;overflow-wrap:anywhere;white-space:pre-wrap}thead{display:table-header-group}tr{break-inside:avoid}@page{margin:15mm}@media print{body{margin:0}}</style></head><body><h1>${escape(spec.title)}</h1><p>${records.length} matching records of ${total}, in selected view order, including every page. Static readable report; use JSON or the app file for an exact editable backup.</p><table><thead><tr>${columns.map(field => `<th scope="col">${escape(field.label)}</th>`).join("")}</tr></thead><tbody>`;
    const tail = "</tbody></table></body></html>";
    const parts = [head];
    const encoder = new TextEncoder();
    let bytes = encoder.encode(head+tail).byteLength;
    for (const record of validateRecords(spec, records)) {
      const row = "<tr>" + columns.map(field => {
        const value = record[field.name];
        return `<td>${escape(field.type === "boolean" ? (value ? "Yes" : "No") : value ?? "")}</td>`;
      }).join("") + "</tr>";
      bytes += encoder.encode(row).byteLength;
      if (bytes > MAX_BYTES) throw new Error("Printable report exceeds10 MiB. Narrow the view or export JSON.");
      parts.push(row);
    }
    return parts.join("")+tail;
  }

  function compareImport(spec, current, incoming) {
    const before = new Map(validateRecords(spec, current).map(row => [row.id, row]));
    const after = new Map(validateRecords(spec, incoming).map(row => [row.id, row]));
    const added = [], removed = [], changed = [], unchanged = [];
    for (const [id, row] of after) {
      if (!before.has(id)) added.push(id);
      else if (JSON.stringify(row) === JSON.stringify(before.get(id))) unchanged.push(id);
      else changed.push(id);
    }
    for (const id of before.keys()) if (!after.has(id)) removed.push(id);
    return {added, removed, changed, unchanged};
  }

  function applyOperation(spec, records, operation) {
    if (!isObject(operation)) throw new Error("Operation must be an object.");
    const allowed = {create: ["op", "record"], edit: ["op", "id", "changes"], delete: ["op", "id"]};
    if (!own(operation, "op") || !own(allowed, operation.op) ||
        Object.keys(operation).some(key => !allowed[operation.op].includes(key)) ||
        allowed[operation.op].some(key => !own(operation, key))) {
      throw new Error("Unsupported operation or operation fields.");
    }
    const current = validateRecords(spec, records);
    if (operation.op === "create") return validateRecords(spec, [...current, operation.record]);
    if (!current.some(record => record.id === operation.id)) throw new Error("Record does not exist.");
    if (operation.op === "delete") return current.filter(record => record.id !== operation.id);
    if (!isObject(operation.changes) || own(operation.changes, "id")) throw new Error("Edits cannot replace record IDs.");
    return validateRecords(spec, current.map(record => record.id === operation.id ? {...record, ...operation.changes} : record));
  }

  function prepareEnvelope(payload, value, serialize = false) {
    if (!isObject(value) || Object.keys(value).some(key => !["format", "app_id", "spec_fingerprint", "records"].includes(key)) ||
        value.format !== "afterlife-data/v1" || value.app_id !== payload.spec.app_id ||
        value.spec_fingerprint !== payload.spec_fingerprint) {
      throw new Error("This file is not an export from the same app specification.");
    }
    const prefix = JSON.stringify({format: value.format, app_id: value.app_id,
      spec_fingerprint: value.spec_fingerprint}).slice(0, -1) + ',"records":[';
    const encoder = new TextEncoder();
    let bytes = encoder.encode(prefix).byteLength + 2;
    const parts = serialize ? [prefix] : null;
    const checkSize = () => {
      if (bytes > MAX_BYTES) throw new Error("Data exceeds 10 MiB. Export and split this collection.");
    };
    checkSize();
    const records = normalizeRecords(payload.spec, value.records, (record, index) => {
      // One validated record is bounded by the schema. Stop before expanding
      // later defaults or allocating a serialized copy of the whole collection.
      const encoded = JSON.stringify(record);
      bytes += encoder.encode(encoded).byteLength + (index ? 1 : 0);
      checkSize();
      if (parts) parts.push((index ? "," : "") + encoded);
    });
    return {records, serialized: parts ? parts.join("") + "]}" : null};
  }

  function validateEnvelope(payload, value) {
    return prepareEnvelope(payload, value).records;
  }

  function escapeJSON(value) {
    return JSON.stringify(value).replace(/&/g, "\\u0026").replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
      .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }

  function matches(spec, record, query, fieldName = "") {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || spec.fields.some(field => (!fieldName || field.name === fieldName) && String(record[field.name] ?? "").toLocaleLowerCase().includes(needle));
  }

  function exportDataJSON(value) {
    const pretty = JSON.stringify(value, null, 2) + "\n";
    if (new Blob([pretty]).size <= MAX_BYTES) return pretty;
    const compact = JSON.stringify(value);
    const bytes = new Blob([compact]).size;
    if (bytes > MAX_BYTES) throw new Error("Data exceeds 10 MiB. Export and split this collection.");
    // Formatting must not make accepted data too large for this app to import.
    return compact + (bytes < MAX_BYTES ? "\n" : "");
  }

  async function storeIfCurrent(storage, locks, key, previous, next) {
    // localStorage has no compare-and-swap. Serialize cooperating copies before
    // reading the expected value and writing; unsupported browsers stay in memory.
    if (!locks || typeof locks.request !== "function") return {status: "memory", reason: "coordination"};
    try {
      return await locks.request("afterlife-write:" + key, {ifAvailable: true}, lock => {
        if (!lock) return {status: "busy"};
        if (storage.getItem(key) !== previous) return {status: "changed"};
        storage.setItem(key, next);
        return {status: "saved"};
      });
    } catch (error) {
      return {status: "memory", reason: error.name === "QuotaExceededError" ? "quota" : "storage"};
    }
  }

  function boot() {
    const payload = JSON.parse(document.getElementById("afterlife-data").textContent);
    const spec = payload.spec;
    const app = document.getElementById("app");
    app.replaceChildren();
    let records = validateRecords(spec, payload.records);
    let currentId = null;
    let lastDeleted = null;
    let dirty = false;
    let stale = false;
    let lastStored = null;
    let blockedStorage = false;
    let committing = false;
    let currentPage = 0;
    let pageCount = 1;
    let storageFailure = "";
    let initialWarning = "";
    const conflictWarning = "Another tab changed this app. Keep editing a separate copy to save your editor changes here, or reload to use the other tab’s records.";

    const node = (tag, text, className) => {
      const element = document.createElement(tag);
      if (text !== undefined) element.textContent = text;
      if (className) element.className = className;
      return element;
    };
    const button = (text, handler, className) => {
      const element = node("button", text, className);
      element.type = "button";
      element.addEventListener("click", handler);
      return element;
    };
    const envelope = () => ({format: "afterlife-data/v1", app_id: spec.app_id,
      spec_fingerprint: payload.spec_fingerprint, records});

    try {
      lastStored = localStorage.getItem(payload.storage_key);
      if (lastStored !== null) {
        if (new Blob([lastStored]).size > MAX_BYTES) throw new Error("Saved data is too large.");
        records = validateEnvelope(payload, parseDataJSON(lastStored));
      }
    } catch (error) {
      blockedStorage = true;
      initialWarning = "Browser storage is unavailable or invalid. This session starts from the file. Download a copy to keep changes; existing stored data will not be overwritten.";
    }

    const header = node("header", undefined, "page-header");
    const titleBlock = node("div");
    titleBlock.append(node("p", "Afterlife / Independent copy", "brand"), node("h1", spec.title),
      node("p", spec.description || "Your records, ready to use offline.", "description"));
    const fileActions = node("div", undefined, "file-actions");
    const status = node("p", "Changes stay in this browser. Download a copy to keep them with your file.", "storage-note");
    status.id = "storage-status";
    status.setAttribute("role", "status");
    const message = node("p", "", "message");
    message.setAttribute("role", "status");
    message.id = "message";
    const tell = (text, error = false) => {
      message.textContent = text;
      message.className = error ? "message error" : "message";
    };
    const download = (content, filename, type) => {
      const url = URL.createObjectURL(new Blob([content], {type}));
      const link = node("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };
    const saveHTML = (matching = false) => {
      if (committing) return tell("Wait for the current save to finish before downloading.", true);
      const selected = matching ? currentView() : records;
      const copy = document.documentElement.cloneNode(true);
      copy.querySelector("#app").replaceChildren();
      const suffix = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      copy.querySelector("#afterlife-data").textContent = escapeJSON({...payload, records: selected,
        storage_key: `afterlife:v1:${spec.app_id}:snapshot:${suffix}`});
      download("<!doctype html>\n" + copy.outerHTML + "\n", spec.app_id + (matching ? "-matching-offline.html" : "-offline.html"), "text/html;charset=utf-8");
      tell(matching ? `Download requested for all ${selected.length} matching records in view order, including other pages. App settings retained; full collection kept here. Open the downloaded HTML to verify your copy.` : "Download requested. Open the downloaded HTML file to verify your saved copy.");
    };
    const fileInput = node("input");
    fileInput.type = "file";
    fileInput.accept = ".json,application/json";
    fileInput.id = "import-file";
    fileInput.hidden = true;
    fileActions.append(button("Download app", () => saveHTML(), "primary"),
      button("Export JSON", () => {
        if (committing) return tell("Wait for the current save to finish before downloading.", true);
        try {
          download(exportDataJSON(envelope()), spec.app_id + "-data.json", "application/json");
          tell("JSON download requested. Keep the app file with this export.");
        } catch (error) { tell(error.message, true); }
      }), button("Export CSV", () => {
        if (committing) return tell("Wait for the current save to finish before downloading.", true);
        try {
          download(exportCSV(spec, records), spec.app_id + "-text.csv", "text/csv;charset=utf-8;header=present");
          tell("CSV download requested. Text values have an apostrophe prefix; use JSON for exact data.");
        } catch (error) { tell(error.message, true); }
      }), button("Import JSON", () => fileInput.click()), fileInput);
    header.append(titleBlock, fileActions);

    const toolbar = node("div", undefined, "toolbar");
    const searchLabel = node("label", "Search records", "search-label");
    const search = node("input");
    search.id = "search";
    search.type = "search";
    search.placeholder = "Search any field…";
    searchLabel.append(search);
    const searchFieldLabel = node("label", "Search in", "sort-label");
    const searchField = node("select"); searchField.id = "search-field";
    const searchEverywhere = node("option", "All fields"); searchEverywhere.value = ""; searchField.append(searchEverywhere);
    for (const field of spec.fields) {
      const option = node("option", field.label); option.value = field.name; searchField.append(option);
    }
    searchFieldLabel.append(searchField);
    searchField.addEventListener("change", () => {
      const field = spec.fields.find(item => item.name === searchField.value);
      search.placeholder = field ? `Search ${field.label}…` : "Search any field…";
      currentPage = 0; render();
    });
    const sortLabel = node("label", "Sort records", "sort-label");
    const sortField = node("select");
    sortField.id = "sort-field";
    const originalOrder = node("option", "Original order");
    originalOrder.value = "";
    sortField.append(originalOrder);
    for (const field of spec.fields) {
      const option = node("option", field.label);
      option.value = field.name;
      sortField.append(option);
    }
    sortLabel.append(sortField);
    let descending = false;
    const sortDirection = button("Ascending", () => {
      descending = !descending;
      sortDirection.textContent = descending ? "Descending" : "Ascending";
      sortDirection.setAttribute("aria-pressed", String(descending));
      currentPage = 0;
      render();
    });
    sortDirection.setAttribute("aria-label", "Reverse sort direction");
    sortDirection.setAttribute("aria-pressed", "false");
    sortDirection.disabled = true;
    sortField.addEventListener("change", () => {
      sortDirection.disabled = !sortField.value;
      currentPage = 0;
      render();
    });
    const filterFields = spec.fields.filter(field => ["boolean", "select"].includes(field.type));
    const filterLabel = node("label", "Filter by", "sort-label");
    const filterField = node("select");
    filterField.id = "filter-field";
    const noFilter = node("option", "All records");
    noFilter.value = "";
    filterField.append(noFilter);
    for (const field of filterFields) {
      const option = node("option", field.label);
      option.value = field.name;
      filterField.append(option);
    }
    filterLabel.append(filterField);
    const filterValueLabel = node("label", "Filter value", "sort-label");
    const filterValue = node("select");
    filterValue.id = "filter-value";
    filterValueLabel.append(filterValue);
    const refreshFilterValues = () => {
      filterValue.replaceChildren();
      const all = node("option", "All values");
      all.value = "*";
      filterValue.append(all);
      const field = filterFields.find(item => item.name === filterField.value);
      filterValue.disabled = !field;
      if (field) {
        const values = field.type === "boolean" ? [true, false] : ["", ...field.options];
        for (const value of values) {
          const option = node("option", field.type === "boolean" ? (value ? "Yes" : "No") : value || "No value");
          option.value = JSON.stringify(value);
          filterValue.append(option);
        }
      }
    };
    refreshFilterValues();
    const viewChanged = () => { currentPage = 0; render(); };
    filterField.addEventListener("change", () => { refreshFilterValues(); viewChanged(); });
    filterValue.addEventListener("change", viewChanged);
    const integerFields = spec.fields.filter(field => field.type === "integer");
    const rangeControls = node("div", undefined, "sort-label");
    const rangeField = node("select"); rangeField.setAttribute("aria-label", "Integer range field");
    const rangeNone = node("option", "No integer range"); rangeNone.value = ""; rangeField.append(rangeNone);
    for (const field of integerFields) {
      const option = node("option", field.label); option.value = field.name; rangeField.append(option);
    }
    const minimum = node("input"), maximum = node("input");
    for (const [input, label] of [[minimum, "Minimum integer"], [maximum, "Maximum integer"]]) {
      input.type = "text"; input.inputMode = "numeric"; input.maxLength = MAX_INTEGER_INPUT_LENGTH;
      input.setAttribute("aria-label", label); input.placeholder = label; input.disabled = true;
    }
    let activeRange = null;
    const applyRange = button("Apply integer range", () => {
      if (!rangeField.value) return;
      const bound = input => {
        if (!input.value.trim()) return null;
        if (!exactIntegerInput(input.value)) throw new Error("Use exact safe integer bounds.");
        return Number(input.value.trim());
      };
      try {
        const low = bound(minimum), high = bound(maximum);
        if (low !== null && high !== null && low > high) throw new Error("Minimum must not exceed maximum.");
        activeRange = low === null && high === null ? null : {name: rangeField.value, low, high};
        viewChanged();
        tell(activeRange ? "Inclusive integer range applied. Empty values are excluded; all matching pages and exports use this range." : "Integer range cleared. Empty values are included again.");
      } catch (error) { tell("Range not applied: " + error.message + " Previous range kept.", true); }
    });
    applyRange.disabled = true;
    const clearRange = () => {
      activeRange = null; minimum.value = maximum.value = "";
      minimum.disabled = maximum.disabled = applyRange.disabled = !rangeField.value;
    };
    rangeField.addEventListener("change", () => {clearRange(); viewChanged();});
    rangeControls.append(rangeField, minimum, maximum, applyRange);
    const resetView = button("Reset view", () => {
      search.value = ""; searchField.value = ""; search.placeholder = "Search any field…";
      sortField.value = "";
      descending = false;
      sortDirection.textContent = "Ascending";
      sortDirection.setAttribute("aria-pressed", "false");
      sortDirection.disabled = true;
      filterField.value = "";
      rangeField.value = ""; clearRange();
      refreshFilterValues();
      viewChanged();
    });
    const count = node("p", "", "count");
    count.setAttribute("aria-live", "polite");
    const newButton = button("New " + (spec.record_label || "record"), () => openEditor());
    const separateCopy = button("Keep editing a separate copy", () => {
      if (committing) return tell("Wait for the current save to finish.", true);
      blockedStorage = true;
      stale = false;
      storageFailure = "This tab is a separate copy. ";
      status.textContent = storageFailure + "Changes are only in memory. Download app or export JSON before closing this tab.";
      separateCopy.hidden = true;
      tell("You can save your editor changes into this separate copy. The other tab’s stored records will be kept.");
    });
    separateCopy.hidden = true;
    const undo = button("Undo delete", async () => {
      if (!lastDeleted) return;
      const entries = lastDeleted.entries || [lastDeleted];
      if (records.length + entries.length > MAX_RECORDS) return tell("Record limit reached. Export your data before removing records.", true);
      const next = [...records];
      for (const entry of entries) next.splice(Math.min(entry.index, next.length), 0, entry.record);
      if (await commit(next)) { lastDeleted = null; undo.hidden = true; tell(entries.length === 1 ? "Deleted record restored." : "Deleted records restored."); }
    });
    undo.hidden = true;
    toolbar.append(searchLabel, searchFieldLabel, sortLabel, sortDirection);
    if (filterFields.length) toolbar.append(filterLabel, filterValueLabel);
    if (integerFields.length) toolbar.append(rangeControls);
    const exportMatching = (format) => {
      if (committing) return tell("Wait for the current save to finish before downloading.", true);
      try {
        const matching = currentView();
        if (format === "json") {
          download(exportDataJSON({...envelope(), records: matching}), spec.app_id + "-matching-data.json", "application/json");
        } else {
          download(exportCSV(spec, matching), spec.app_id + "-matching-text.csv", "text/csv;charset=utf-8;header=present");
        }
        tell(`Download requested for all ${matching.length} matching records in view order, including other pages. Full collection kept. ${format === "csv" ? "CSV text has an apostrophe prefix; use JSON for exact data." : "Keep the app file with this data export."}`);
      } catch (error) { tell(error.message, true); }
    };
    const printMatching = button("Download printable view", () => {
      if (committing) return tell("Wait for the current save to finish before downloading.", true);
      try {
        const matching = currentView();
        download(printableRecords(spec, matching, records.length), spec.app_id+"-matching-print.html", "text/html;charset=utf-8");
        tell(`Printable view requested for all ${matching.length} matching records, including other pages. Open the downloaded file and print from your browser. Full collection kept; use JSON/app download for an editable backup.`);
      } catch (error) {tell(error.message, true);}
    });
    const deleteMatching = button("Delete matching records", async () => {
      if (committing) return tell("Wait for the current save to finish.", true);
      if (dirty) return tell("Save or cancel editor changes before deleting matching records.", true);
      const ids = new Set(currentView().map(record => record.id));
      if (!ids.size) return tell("No matching records to delete.");
      if (!confirm(`Delete all ${ids.size} matching records, including other pages? You can undo this deletion until the next import or reload.`)) return;
      const entries = records.map((record, index) => ({record, index})).filter(entry => ids.has(entry.record.id));
      if (await commit(records.filter(record => !ids.has(record.id)), {resetPage: true})) {
        lastDeleted = {entries}; undo.hidden = false;
        if (ids.has(currentId)) { panel.hidden = true; currentId = null; }
        tell(`Deleted ${entries.length} matching records. Undo is available until the next import or reload.`);
      }
    }, "danger");
    const bulkFields = spec.fields.filter(field => ["boolean", "select"].includes(field.type));
    if (bulkFields.length) {
      const bulkChoice = node("select");
      bulkChoice.setAttribute("aria-label", "Matching field value");
      const placeholder = node("option", "Choose field update…"); placeholder.value = ""; bulkChoice.append(placeholder);
      for (const field of bulkFields) {
        const values = field.type === "boolean" ? [true, false] : [...(field.required ? [] : [""]), ...field.options];
        for (const value of values) {
          const display = field.type === "boolean" ? (value ? "Yes" : "No") : value || "No value";
          const option = node("option", `Set ${field.label} to ${display}`);
          option.value = JSON.stringify([field.name, value]); bulkChoice.append(option);
        }
      }
      const bulkUpdate = button("Update matching records", async () => {
        if (committing) return tell("Wait for the current save to finish.", true);
        if (dirty) return tell("Save or cancel editor changes before updating matching records.", true);
        if (!bulkChoice.value) return;
        const [name, value] = JSON.parse(bulkChoice.value);
        const field = bulkFields.find(item => item.name === name);
        const display = field.type === "boolean" ? (value ? "Yes" : "No") : value || "No value";
        const ids = new Set(currentView().filter(record => record[name] !== value).map(record => record.id));
        if (!ids.size) return tell("No matching records need this field change. Current records kept.");
        if (!confirm(`Set ${field.label} to ${display} for ${ids.size} matching records, including other pages? Export a copy first; this update has no undo.`)) return;
        const next = records.map(record => ids.has(record.id) ? {...record, [name]: value} : record);
        if (await commit(next, {resetPage: true})) {
          panel.hidden = true; currentId = null;
          tell(`Updated ${ids.size} matching records: ${field.label} set to ${display}.`);
        }
      });
      bulkUpdate.disabled = true;
      bulkChoice.addEventListener("change", () => {bulkUpdate.disabled = !bulkChoice.value;});
      toolbar.append(bulkChoice, bulkUpdate);
    }
    toolbar.append(resetView, button("Export matching JSON", () => exportMatching("json")),
      button("Export matching CSV", () => exportMatching("csv")), button("Download matching app", () => saveHTML(true)), printMatching, deleteMatching, count, undo, separateCopy, newButton);
    const pagination = node("nav", undefined, "pagination");
    pagination.setAttribute("aria-label", "Record pages");
    const pageStatus = node("p", "", "page-status");
    pageStatus.id = "page-status";
    pageStatus.setAttribute("role", "status");
    pageStatus.setAttribute("aria-live", "polite");
    pageStatus.setAttribute("aria-atomic", "true");
    const firstPage = button("First page", () => changePage(0));
    const previousPage = button("Previous page", () => changePage(currentPage - 1));
    const nextPage = button("Next page", () => changePage(currentPage + 1));
    const lastPage = button("Last page", () => changePage(pageCount - 1));
    for (const control of [firstPage, previousPage, nextPage, lastPage]) control.setAttribute("aria-controls", "records");
    pagination.append(pageStatus, firstPage, previousPage, nextPage, lastPage);
    let pendingImport = null;
    const importReview = node("section", undefined, "editor import-review");
    importReview.hidden = true;
    importReview.setAttribute("aria-label", "Import review");
    const importSummary = node("p");
    const importChanges = node("details");
    const importIDs = node("pre");
    importChanges.append(node("summary", "Review affected record IDs"), importIDs);
    const cancelImport = button("Cancel import", () => {
      pendingImport = null; importReview.hidden = true; tell("Import cancelled. Current records kept.");
    });
    async function applyPendingImport(addOnly = false) {
      if (!pendingImport) return;
      if (JSON.stringify(records) !== pendingImport.baseline) {
        pendingImport = null; importReview.hidden = true;
        return tell("Records changed after this preview. Choose the import file again to review current differences.", true);
      }
      if (dirty && !confirm("Discard unsaved editor changes and import?")) return;
      if (addOnly && pendingImport.review.counts.changed) {
        return tell("Cannot add records: existing IDs have different values. Review the conflicting IDs or choose replacement import explicitly.", true);
      }
      const existingIDs = new Set(records.map(record => record.id));
      const added = pendingImport.records.filter(record => !existingIDs.has(record.id));
      if (addOnly && !added.length) return tell("No new record IDs to add. Current records kept.");
      const incoming = addOnly ? [...records, ...added] : pendingImport.records;
      if (await commit(incoming, {resetPage: true})) {
        lastDeleted = null; undo.hidden = true; dirty = false; panel.hidden = true; currentId = null;
        pendingImport = null; importReview.hidden = true;
        tell(addOnly ? `Added ${added.length} new records. Existing records kept.` : `Imported ${incoming.length} records.`);
      }
    }
    const applyImport = button("Apply import", () => applyPendingImport(false), "primary");
    const addImport = button("Add new records", () => applyPendingImport(true));
    const exportImportReview = button("Export review JSON", () => {
      if (!pendingImport || committing) return;
      if (stale || JSON.stringify(records) !== pendingImport.baseline) {
        return tell("Review is stale. Choose the import file again before exporting its summary.", true);
      }
      download(JSON.stringify(pendingImport.review, null, 2), spec.app_id + "-import-review.json", "application/json");
      tell("Review summary download requested. Record values are excluded; export data separately to keep a backup.");
    });
    importReview.append(node("h2", "Review import"), importSummary, importChanges, applyImport, addImport, exportImportReview, cancelImport);
    const layout = node("div", undefined, "workspace");
    const list = node("section", undefined, "records");
    list.id = "records";
    list.setAttribute("aria-label", "Records");
    const panel = node("aside", undefined, "editor");
    panel.hidden = true;
    const panelTitle = node("h2");
    const form = node("form");
    form.noValidate = true;
    const fieldInputs = new Map();
    const openedValues = new Map();
    for (const field of spec.fields) {
      const wrapper = node("div", undefined, "field");
      const label = node("label", field.label + (field.required ? " *" : ""));
      let input;
      if (field.type === "select") {
        input = node("select");
        const empty = node("option", "Choose…");
        empty.value = "";
        input.append(empty);
        for (const choice of field.options) {
          const option = node("option", choice);
          option.value = choice;
          input.append(option);
        }
      } else if (field.type === "multiline") {
        input = node("textarea");
        input.rows = 4;
      } else {
        input = node("input");
        input.type = field.type === "boolean" ? "checkbox" : field.type === "integer" ? "number" : "text";
        if (field.type === "integer") input.step = "1";
      }
      input.name = field.name;
      input.id = "field-" + field.name;
      label.htmlFor = input.id;
      input.required = Boolean(field.required);
      if (field.type === "text" || field.type === "multiline") input.maxLength = 20000;
      input.addEventListener("input", () => { dirty = true; });
      wrapper.append(label, input);
      form.append(wrapper);
      fieldInputs.set(field.name, input);
    }
    const formActions = node("div", undefined, "form-actions");
    const save = node("button", "Save record", "primary");
    save.type = "submit";
    const close = () => {
      if (committing) return tell("Wait for the current save to finish.", true);
      if (dirty && !confirm("Discard unsaved changes in the editor?")) return;
      panel.hidden = true;
      dirty = false;
      currentId = null;
      newButton.focus();
    };
    formActions.append(save, button("Cancel", close));
    form.append(formActions);
    panel.append(panelTitle, form);
    layout.append(list, panel);
    app.append(header, status, message, toolbar, importReview, pagination, layout,
      node("footer", "Works without a server. Your downloaded HTML copy includes the app and its current records."));

    function openEditor(record = null, {duplicate = false} = {}) {
      if (committing) return tell("Wait for the current save to finish.", true);
      if (dirty && !confirm("Discard unsaved changes in the editor?")) return;
      currentId = record && !duplicate ? record.id : null;
      panelTitle.textContent = (duplicate ? "Duplicate " : record ? "Edit " : "New ") + (spec.record_label || "record");
      for (const field of spec.fields) {
        const input = fieldInputs.get(field.name);
        const value = record ? record[field.name] : defaultValue(field);
        if (field.type === "boolean") input.checked = value;
        else input.value = value ?? "";
        // Browsers normalize CR/CRLF in textareas and strip line breaks from
        // single-line inputs. Keep the exact original when its displayed value
        // was not edited, including defaults used to create a new record.
        openedValues.set(field.name, {original: value, displayed: input.value});
      }
      dirty = false;
      panel.hidden = false;
      fieldInputs.values().next().value.focus();
    }

    function changePage(page) {
      if (committing) return tell("Wait for the current save to finish.", true);
      currentPage = page;
      render();
    }

    function currentView() {
      return sortRecords(spec, records.filter(record => matches(spec, record, search.value, searchField.value) &&
        (!filterField.value || filterValue.value === "*" || record[filterField.value] === JSON.parse(filterValue.value)) &&
        (!activeRange || record[activeRange.name] !== null &&
          (activeRange.low === null || record[activeRange.name] >= activeRange.low) &&
          (activeRange.high === null || record[activeRange.name] <= activeRange.high))), sortField.value, descending);
    }

    function render() {
      const focusedPageControl = pagination.contains(document.activeElement) ? document.activeElement : null;
      list.replaceChildren();
      const visible = currentView();
      count.textContent = `${visible.length} of ${records.length} records`;
      pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
      currentPage = Math.max(0, Math.min(currentPage, pageCount - 1));
      const start = currentPage * PAGE_SIZE;
      pagination.hidden = visible.length <= PAGE_SIZE;
      firstPage.disabled = previousPage.disabled = currentPage === 0;
      nextPage.disabled = lastPage.disabled = currentPage === pageCount - 1;
      pageStatus.textContent = `Page ${currentPage + 1} of ${pageCount}. Records ${visible.length ? start + 1 : 0}–${Math.min(start + PAGE_SIZE, visible.length)} of ${visible.length}.`;
      if (focusedPageControl && (pagination.hidden || focusedPageControl.disabled)) {
        (pagination.hidden ? search : currentPage === 0 ? nextPage : previousPage).focus();
      }
      if (visible.length === 0) {
        list.append(node("p", records.length ? "No records match your search." : "This copy is empty. Create your first record.", "empty"));
        return;
      }
      const table = node("table");
      const head = node("thead");
      const headings = node("tr");
      for (const field of spec.fields) {
        const th = node("th", field.label);
        th.scope = "col";
        headings.append(th);
      }
      const actionsHeading = node("th", "Actions");
      actionsHeading.scope = "col";
      headings.append(actionsHeading);
      head.append(headings);
      const body = node("tbody");
      for (const record of visible.slice(start, start + PAGE_SIZE)) {
        const row = node("tr");
        row.dataset.recordId = record.id;
        for (const field of spec.fields) {
          const value = record[field.name];
          const cell = node("td", field.type === "boolean" ? (value ? "Yes" : "No") : String(value ?? ""));
          if (field.type === "multiline") cell.className = "long-text";
          row.append(cell);
        }
        const actions = node("td", undefined, "row-actions");
        actions.append(button("Edit", () => openEditor(record)), button("Duplicate", () => openEditor(record, {duplicate: true})), button("Delete", async () => {
          if (!confirm("Delete this record? You can undo the most recent deletion.")) return;
          const index = records.findIndex(item => item.id === record.id);
          if (await commitOperation({op: "delete", id: record.id})) {
            lastDeleted = {record, index}; undo.hidden = false;
            if (currentId === record.id) { dirty = false; panel.hidden = true; currentId = null; }
            tell("Record deleted. Undo is available until the next import or reload.");
          }
        }, "danger"));
        row.append(actions);
        body.append(row);
      }
      table.append(head, body);
      list.append(table);
    }

    async function commit(next, {resetPage = false} = {}) {
      if (committing) { tell("A save is already in progress. Try again when it finishes.", true); return false; }
      committing = true;
      save.disabled = true;
      save.textContent = "Saving…";
      for (const input of fieldInputs.values()) input.disabled = true;
      try {
        if (stale) throw new Error(conflictWarning);
        const {records: checked, serialized} = prepareEnvelope(payload, {...envelope(), records: next}, true);
        if (!blockedStorage) {
          let persisted;
          try {
            persisted = await storeIfCurrent(localStorage, navigator.locks, payload.storage_key, lastStored, serialized);
          } catch (error) {
            persisted = {status: "memory", reason: "storage"};
          }
          if (persisted.status === "busy") {
            throw new Error("Another tab is saving this app. Your editor changes are still here; try saving again.");
          }
          if (persisted.status === "changed") {
            stale = true;
            separateCopy.hidden = false;
            throw new Error(conflictWarning);
          }
          if (persisted.status === "saved") {
            lastStored = serialized;
            status.textContent = "Saved in this browser. Download app to save a portable copy.";
          } else {
            blockedStorage = true;
            storageFailure = persisted.reason === "quota" ? "Browser storage is full. " :
              persisted.reason === "coordination" ? "This browser cannot coordinate saved changes between tabs. " :
              "Browser storage could not be updated. ";
          }
        }
        records = checked;
        if (resetPage) currentPage = 0;
        if (blockedStorage) status.textContent = storageFailure + "Changes are only in memory. Download app or export JSON before closing this tab.";
        render();
        return true;
      } catch (error) { tell(error.message, true); return false; }
      finally {
        committing = false;
        save.disabled = false;
        save.textContent = "Save record";
        for (const input of fieldInputs.values()) input.disabled = false;
      }
    }

    async function commitOperation(operation) {
      try { return await commit(applyOperation(spec, records, operation)); }
      catch (error) { tell(error.message, true); return false; }
    }

    form.addEventListener("submit", async event => {
      event.preventDefault();
      const random = () => [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      const record = {id: currentId || "r-" + random()};
      for (const field of spec.fields) {
        const input = fieldInputs.get(field.name);
        if (field.type === "integer" && input.value.trim() !== "" && !exactIntegerInput(input.value)) {
          return tell(`${field.label} must be an exactly represented safe integer or null.`, true);
        }
        record[field.name] = field.type === "boolean" ? input.checked : field.type === "integer" ?
          (input.value.trim() === "" ? null : Number(input.value)) : input.value;
        const opened = openedValues.get(field.name);
        if ((field.type === "text" || field.type === "multiline") && input.value === opened.displayed) {
          record[field.name] = opened.original;
        }
      }
      if (currentId && !records.some(item => item.id === currentId)) return tell("This record no longer exists. Reopen the editor.", true);
      const {id, ...changes} = record;
      const operation = currentId ? {op: "edit", id: currentId, changes} : {op: "create", record};
      if (await commitOperation(operation)) { dirty = false; panel.hidden = true; currentId = null; tell("Record saved."); newButton.focus(); }
    });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      pendingImport = null; importReview.hidden = true;
      try {
        if (file.size > MAX_BYTES) throw new Error("Import exceeds 10 MiB.");
        const imported = validateEnvelope(payload, parseDataJSON(await file.text()));
        const differences = compareImport(spec, records, imported);
        const currentIDs = new Set(records.map(row => row.id));
        const incomingIDs = new Set(imported.map(row => row.id));
        const previousOrder = records.filter(row => incomingIDs.has(row.id)).map(row => row.id);
        const incomingOrder = imported.filter(row => currentIDs.has(row.id)).map(row => row.id);
        const reordered = JSON.stringify(previousOrder) !== JSON.stringify(incomingOrder);
        pendingImport = {records: imported, baseline: JSON.stringify(records)};
        importSummary.textContent = `Replace ${records.length} records with ${imported.length}: ${differences.added.length} added, ${differences.removed.length} removed, ${differences.changed.length} changed, ${differences.unchanged.length} unchanged.${reordered ? " Retained record order will change." : ""} Export first to keep the current copy.`;
        const previous = new Map(records.map(row => [row.id, row]));
        const changedIDs = new Set(differences.changed);
        const changedFields = imported.filter(row => changedIDs.has(row.id)).map(row => ({id: row.id,
          fields: spec.fields.filter(field => previous.get(row.id)[field.name] !== row[field.name]).map(field => field.name).sort()}));
        importIDs.textContent = JSON.stringify({...differences, changed_fields: changedFields}, null, 2);
        pendingImport.review = {format: "afterlife-import-summary/v1", app_id: spec.app_id,
          spec_fingerprint: payload.spec_fingerprint,
          counts: {current: records.length, incoming: imported.length, added: differences.added.length,
            removed: differences.removed.length, changed: differences.changed.length, unchanged: differences.unchanged.length},
          added: differences.added, removed: differences.removed, changed_fields: changedFields,
          retained_order_changed: reordered,
          scope: "Metadata-only draft preview. IDs and field names included; record values excluded. This is not a data backup, authenticated snapshot, or guarded-restoration report. Separate requests may observe different records; review again before applying."};
        addImport.disabled = differences.changed.length > 0 || differences.added.length === 0;
        importSummary.append(node("span", differences.changed.length ?
          ` Add mode unavailable: ${differences.changed.length} existing IDs have different values.` :
          ` Add mode keeps all current records and adds ${differences.added.length} new IDs; unchanged shared IDs are skipped.`));
        importReview.hidden = false;
        applyImport.focus();
        tell("Import preview ready. Current records have not changed.");
      } catch (error) { tell("Import failed: " + error.message, true); }
    });
    search.addEventListener("input", () => { currentPage = 0; render(); });
    window.addEventListener("storage", event => {
      if (!blockedStorage && (event.key === payload.storage_key || event.key === null)) {
        stale = true;
        separateCopy.hidden = false;
        tell(conflictWarning, true);
      }
    });
    window.addEventListener("beforeunload", event => {
      if (dirty || blockedStorage || committing) { event.preventDefault(); event.returnValue = ""; }
    });
    if (initialWarning) { status.textContent = initialWarning; tell(initialWarning, true); }
    render();
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {validateRecords, validateEnvelope, escapeJSON, matches, sortRecords, exportCSV, compareImport, defaultValue, applyOperation, storeIfCurrent, exportDataJSON};
  }
  if (typeof document !== "undefined") boot();
})();
