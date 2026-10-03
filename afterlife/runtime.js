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

  function sortRecords(spec, records, fieldName, descending = false, secondaryName = "") {
    if (!fieldName) return [...records];
    if (![fieldName, ...(secondaryName ? [secondaryName] : [])].every(name => spec.fields.some(field => field.name === name))) throw new Error("Choose declared fields to sort records.");
    const compareValue = (a,b,reverse) => {
      const absentA = a === null || a === "", absentB = b === null || b === "";
      if (absentA !== absentB) return absentA ? 1 : -1;
      const x = typeof a === "string" ? a.toLowerCase() : a;
      const y = typeof b === "string" ? b.toLowerCase() : b;
      const compared = x < y ? -1 : x > y ? 1 : 0;
      return reverse ? -compared : compared;
    };
    return records.map((record,index) => ({record,index})).sort((left,right) =>
      compareValue(left.record[fieldName],right.record[fieldName],descending) ||
      (secondaryName ? compareValue(left.record[secondaryName],right.record[secondaryName],false) : 0) ||
      left.index-right.index).map(item => item.record);
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

  function exportCSV(spec, records, selectedColumns = null) {
    const columns = [{name: "id"}, ...spec.fields.filter(field => selectedColumns === null || selectedColumns.has(field.name))];
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

  function exactIntegerTotals(rows,name){
    const values=rows.map(row=>row[name]).filter(value=>value!==null),sum=values.reduce((total,value)=>total+BigInt(value),0n),ordered=values.slice().sort((a,b)=>a<b?-1:a>b?1:0),n=values.length;
    const rational=(num,den)=>{let a=num<0n?-num:num,b=den;while(b){const r=a%b;a=b;b=r;}const g=a||1n;return den/g===1n?String(num/g):`${num/g}/${den/g}`;};
    return {integer_values:n,empty_values:rows.length-n,sum:String(sum),min:n?ordered[0]:null,max:n?ordered[n-1]:null,mean:n?rational(sum,BigInt(n)):null,median:n?(n%2?String(ordered[Math.floor(n/2)]):rational(BigInt(ordered[n/2-1])+BigInt(ordered[n/2]),2n)):null};
  }

  function printableRecords(spec, records, total, selectedColumns = null, chosen = false) {
    const escape = value => String(value).replace(/[&<>"']/g, character => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[character]);
    const columns = [{name:"id",label:"Record ID",type:"text"}, ...spec.fields.filter(field => selectedColumns === null || selectedColumns.has(field.name))];
    const columnScope = selectedColumns === null ? "All record fields and Record ID included." : `${columns.length - 1} of ${spec.fields.length} table fields included, plus Record ID. Hidden table fields are omitted from this printable file only; other data exports still contain them.`;
    const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(spec.title)} — Printable records</title><style>body{font:12px/1.5 system-ui,sans-serif;color:#111;margin:2rem}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{text-align:left;vertical-align:top;border:1px solid #999;padding:.4rem;overflow-wrap:anywhere;white-space:pre-wrap}thead{display:table-header-group}tr{break-inside:avoid}@page{margin:15mm}@media print{body{margin:0}}</style></head><body><h1>${escape(spec.title)}</h1><p>${records.length} ${chosen ? "explicitly chosen records of "+total+", in original collection order across all filters/pages." : "matching records of "+total+", in selected view order, including every page."} ${columnScope} Static readable report; use JSON or the app file for an exact editable backup.</p><table><thead><tr>${columns.map(field => `<th scope="col">${escape(field.label)}</th>`).join("")}</tr></thead><tbody>`;
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

  function matches(spec, record, query, fieldName = "", matchMode = "contains") {
    if(fieldName === "id") return !query || (matchMode === "exact" ? record.id === query : record.id.includes(query));
    const needle = query.trim().toLocaleLowerCase();
    return !needle || spec.fields.some(field => (!fieldName || field.name === fieldName) && (matchMode === "exact" ? String(record[field.name] ?? "").toLocaleLowerCase() === needle : String(record[field.name] ?? "").toLocaleLowerCase().includes(needle)));
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
    let lastFieldUpdate = null;
    let lastDuplication = null;
    let lastRecordEdit = null;
    const chosenIDs = new Set();
    let dirty = false;
    let stale = false;
    let lastStored = null;
    let blockedStorage = false;
    let committing = false;
    let currentPage = 0;
    let pageSize = PAGE_SIZE;
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
    const saveHTML = (matching = false, chosen = false) => {
      if (committing) return tell("Wait for the current save to finish before downloading.", true);
      if(chosen&&!chosenIDs.size)return tell("Choose a record first.",true);
      const selected = chosen ? records.filter(record=>chosenIDs.has(record.id)) : matching ? currentView() : records;
      const copy = document.documentElement.cloneNode(true);
      copy.querySelector("#app").replaceChildren();
      const suffix = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      copy.querySelector("#afterlife-data").textContent = escapeJSON({...payload, records: selected,
        storage_key: `afterlife:v1:${spec.app_id}:snapshot:${suffix}`});
      download("<!doctype html>\n" + copy.outerHTML + "\n", spec.app_id + (chosen ? "-chosen-offline.html" : matching ? "-matching-offline.html" : "-offline.html"), "text/html;charset=utf-8");
      tell(chosen ? `Downloaded an editable app with ${selected.length} explicitly chosen records and all fields, in original collection order. Other records, unsaved inputs and session choices excluded. This copy has an independent browser storage identity; protect the private file. Current collection kept.` : matching ? `Download requested for all ${selected.length} matching records in view order, including other pages. App settings retained; full collection kept here. Open the downloaded HTML to verify your copy.` : "Download requested. Open the downloaded HTML file to verify your saved copy.");
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
    const theme = button(document.documentElement.dataset.theme === "dark" ? "Light theme" : "Dark theme", () => {
      const dark = document.documentElement.dataset.theme !== "dark";
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      theme.textContent = dark ? "Light theme" : "Dark theme";
      theme.setAttribute("aria-pressed", String(dark));
    });
    theme.setAttribute("aria-pressed", String(document.documentElement.dataset.theme === "dark"));
    fileActions.append(theme);
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
    const idSearch=node("option","Record ID (case-sensitive)");idSearch.value="id";searchField.append(idSearch);
    searchFieldLabel.append(searchField);
    searchField.addEventListener("change", () => {
      const field = spec.fields.find(item => item.name === searchField.value);
      search.placeholder = searchField.value === "id" ? "Search exact ID characters…" : field ? `Search ${field.label}…` : "Search any field…";
      currentPage = 0; render();
    });
    const searchModeLabel = node("label", "Search match", "sort-label");
    const searchMode = node("select"); searchMode.setAttribute("aria-label", "Search match");
    for (const [value,label] of [["contains","Contains text"],["exact","Whole value"]]) {
      const option = node("option",label); option.value = value; searchMode.append(option);
    }
    searchModeLabel.append(searchMode);
    searchMode.addEventListener("change", () => {currentPage = 0; render();});
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
      sortDirection.disabled = !sortField.value; secondaryField.disabled = !sortField.value;
      currentPage = 0;
      render();
    });
    const secondaryLabel = node("label", "Then by (ascending)", "sort-label");
    const secondaryField = node("select"); secondaryField.setAttribute("aria-label","Secondary sort field");
    const noSecondary = node("option","Original order for ties"); noSecondary.value = ""; secondaryField.append(noSecondary);
    for (const field of spec.fields) {const option = node("option",field.label); option.value = field.name; secondaryField.append(option);}
    secondaryField.disabled = true; secondaryLabel.append(secondaryField);
    secondaryField.addEventListener("change", () => {currentPage=0; render();});
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
    const extraFilterLabel=node("label","Also filter by (AND)","sort-label"),extraFilterField=node("select");extraFilterField.setAttribute("aria-label","Additional category field");
    const noExtra=node("option","No additional category");noExtra.value="";extraFilterField.append(noExtra);
    for(const field of filterFields){const option=node("option",field.label);option.value=field.name;extraFilterField.append(option);}extraFilterLabel.append(extraFilterField);
    const extraFilterValueLabel=node("label","Additional filter value","sort-label"),extraFilterValue=node("select");extraFilterValue.setAttribute("aria-label","Additional category value");extraFilterValueLabel.append(extraFilterValue);
    const refreshExtraFilterValues=()=>{
      extraFilterValue.replaceChildren();const all=node("option","All values");all.value="*";extraFilterValue.append(all);
      const field=filterFields.find(item=>item.name===extraFilterField.value);extraFilterValue.disabled=!field;
      if(field)for(const value of field.type==="boolean"?[true,false]:["",...field.options]){const option=node("option",field.type==="boolean"?(value?"Yes":"No"):value||"No value");option.value=JSON.stringify(value);extraFilterValue.append(option);}
    };
    refreshExtraFilterValues();extraFilterField.addEventListener("change",()=>{refreshExtraFilterValues();viewChanged();});extraFilterValue.addEventListener("change",viewChanged);
    const presenceLabel = node("label", "Field presence", "sort-label");
    const presenceField = node("select"); presenceField.setAttribute("aria-label", "Presence field");
    const presenceNone = node("option", "No presence filter"); presenceNone.value = ""; presenceField.append(presenceNone);
    for (const field of spec.fields) {
      const option = node("option", field.label); option.value = field.name; presenceField.append(option);
    }
    const presenceValue = node("select"); presenceValue.setAttribute("aria-label", "Field presence");
    for (const [value,label] of [["empty","Empty value"],["present","Has value"]]) {
      const option = node("option",label); option.value = value; presenceValue.append(option);
    }
    presenceValue.disabled = true;
    presenceField.addEventListener("change", () => {presenceValue.disabled = !presenceField.value; viewChanged();});
    presenceValue.addEventListener("change",viewChanged);
    presenceLabel.append(presenceField,presenceValue);
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
    const summaryLabel = node("label", "Summarize integers", "sort-label");
    const summaryField = node("select"); summaryField.setAttribute("aria-label", "Integer summary field");
    const summaryNone = node("option", "No integer summary"); summaryNone.value = ""; summaryField.append(summaryNone);
    for (const field of integerFields) {
      const option = node("option",field.label); option.value = field.name; summaryField.append(option);
    }
    const integerSummary = node("p", "", "integer-summary"); integerSummary.setAttribute("role","status");
    summaryLabel.append(summaryField); summaryField.addEventListener("change", () => render());
    const pageSizeLabel = node("label","Records per page","sort-label");
    const pageSizeChoice = node("select"); pageSizeChoice.setAttribute("aria-label","Records per page");
    for (const size of [25,50,100]) {const option=node("option",String(size));option.value=String(size);pageSizeChoice.append(option);}
    pageSizeChoice.value=String(pageSize);pageSizeLabel.append(pageSizeChoice);
    pageSizeChoice.addEventListener("change", () => {
      const selected=Number(pageSizeChoice.value);
      if (committing || ![25,50,100].includes(selected)) {pageSizeChoice.value=String(pageSize);return tell("Wait for the current save to finish.",true);}
      const first=currentPage*pageSize;pageSize=selected;currentPage=Math.floor(first/pageSize);render();
    });
    const visibleFields = new Set(spec.fields.map(field => field.name));
    const columnChoices = new Map();
    const columnPanel = node("details", undefined, "column-choices");
    columnPanel.append(node("summary", "Table columns"),node("p", "Choose columns for this tab. Hidden fields remain in search, editors and full JSON/app/CSV exports. Printable and matching CSV output omit them only with an explicit visible-column choice. Hiding is not data removal.", "storage-note"));
    const refreshColumns = () => {for(const [name,input] of columnChoices)input.checked=visibleFields.has(name);};
    for(const field of spec.fields){
      const label=node("label"),input=node("input");input.type="checkbox";input.checked=true;input.setAttribute("aria-label","Show "+field.label+" column");
      input.addEventListener("change",()=>{
        if(!input.checked&&visibleFields.size===1){input.checked=true;return tell("Keep at least one table column visible.",true);}
        if(input.checked)visibleFields.add(field.name);else visibleFields.delete(field.name);
        render();tell("Table columns updated for this tab. Hidden fields remain in records and default data exports.");
      });label.append(input,document.createTextNode(field.label));columnChoices.set(field.name,input);columnPanel.append(label);
    }
    const resetView = button("Reset view", () => {
      visibleFields.clear();for(const field of spec.fields)visibleFields.add(field.name);refreshColumns();
      search.value = ""; searchField.value = ""; searchMode.value = "contains"; search.placeholder = "Search any field…";
      sortField.value = ""; secondaryField.value = ""; secondaryField.disabled = true;
      descending = false; pageSize=PAGE_SIZE; pageSizeChoice.value=String(pageSize);
      sortDirection.textContent = "Ascending";
      sortDirection.setAttribute("aria-pressed", "false");
      sortDirection.disabled = true;
      presenceField.value = ""; presenceValue.value = "empty"; presenceValue.disabled = true;
      filterField.value = "";
      rangeField.value = ""; clearRange(); summaryField.value = "";
      refreshFilterValues();extraFilterField.value="";refreshExtraFilterValues();
      viewChanged();
    });
    const sessionViews = new Map();
    let viewRevision=0,presetReadVersion=0;
    const viewPanel = node("section", undefined, "saved-views");
    viewPanel.setAttribute("aria-label", "Session views");
    const viewName = node("input");viewName.type="text";viewName.maxLength=80;viewName.setAttribute("aria-label","View name");viewName.placeholder="Name this review view…";
    const viewChoice = node("select");viewChoice.setAttribute("aria-label","Saved session view");
    const refreshViews = () => {const previous=viewChoice.value;viewChoice.replaceChildren();const empty=node("option","Choose a session view");empty.value="";viewChoice.append(empty);for(const name of sessionViews.keys()){const option=node("option",name);option.value=name;viewChoice.append(option);}if(sessionViews.has(previous))viewChoice.value=previous;};
    const captureView = () => ({search:search.value,searchField:searchField.value,searchMode:searchMode.value,sort:sortField.value,secondary:secondaryField.value,descending,filter:filterField.value,value:filterValue.value,extraFilter:extraFilterField.value,extraValue:extraFilterValue.value,presence:presenceField.value,presenceValue:presenceValue.value,pageSize,summary:summaryField.value,range:activeRange?{...activeRange}:null,columns:[...visibleFields]});
    const saveView = button("Save session view", () => {
      const name=viewName.value.trim();
      if(!name)return tell("Choose a view name first.",true);
      if(name.length>80)return tell("View names must be at most80 characters.",true);
      if(!sessionViews.has(name)&&sessionViews.size>=20)return tell("This tab already holds20 session views. Remove one first.",true);
      if(sessionViews.has(name))return tell("That view name already exists. Remove it explicitly before saving a replacement.",true);
      sessionViews.set(name,captureView());viewRevision++;refreshViews();viewChoice.value=name;viewName.value="";tell("Session view saved in this tab only. Reloading or closing the tab removes it; records and downloaded apps are unchanged.");
    });
    const applyView = button("Apply session view", () => {
      const saved=sessionViews.get(viewChoice.value);if(!saved)return tell("Choose a saved session view first.",true);
      if(committing)return tell("Wait for the current save before changing views.",true);
      visibleFields.clear();for(const name of saved.columns)visibleFields.add(name);refreshColumns();
      search.value=saved.search;searchField.value=saved.searchField;searchMode.value=saved.searchMode;search.placeholder=saved.searchField?"Search selected field…":"Search any field…";
      sortField.value=saved.sort;secondaryField.value=saved.secondary;secondaryField.disabled=!saved.sort;descending=saved.descending;
      sortDirection.disabled=!saved.sort;sortDirection.textContent=descending?"Descending":"Ascending";sortDirection.setAttribute("aria-pressed",String(descending));
      filterField.value=saved.filter;refreshFilterValues();filterValue.value=saved.value;
      extraFilterField.value=saved.extraFilter||"";refreshExtraFilterValues();extraFilterValue.value=saved.extraValue||"*";
      presenceField.value=saved.presence;presenceValue.value=saved.presenceValue;presenceValue.disabled=!saved.presence;
      pageSize=saved.pageSize;pageSizeChoice.value=String(pageSize);summaryField.value=saved.summary;
      rangeField.value=saved.range?.name||"";clearRange();activeRange=saved.range?{...saved.range}:null;
      if(activeRange){minimum.value=activeRange.low===null?"":String(activeRange.low);maximum.value=activeRange.high===null?"":String(activeRange.high);}
      currentPage=0;render();tell("Saved session view applied. This changes filters and ordering only; all records remain in the collection.");
    });
    const removeView = button("Remove session view", () => {if(!sessionViews.delete(viewChoice.value))return tell("Choose a saved session view first.",true);viewRevision++;refreshViews();tell("Session view removed. Current filters and records are unchanged.");});
    const exportViews=button("Download session views",()=>{
      if(!sessionViews.size)return tell("Save at least one session view first.",true);
      let serialized;try{const preset={format:"afterlife-views/v1",app_id:spec.app_id,spec_fingerprint:payload.spec_fingerprint,views:[...sessionViews].map(([name,view])=>({name,view:validView(view)}))};serialized=JSON.stringify(preset,null,2);if(new Blob([serialized]).size>1024*1024)throw new Error("View presets exceed1 MiB; remove large views first.");}catch(error){return tell("Views not exported: "+error.message,true);}
      download(serialized,spec.app_id+"-view-presets.json","application/json");tell("Downloaded view presets only. Search text and view names may be private; protect the file. Records were not exported or changed.");
    });
    const importViewsLabel=node("label","Import session views"),importViews=node("input");importViews.type="file";importViews.accept=".json,application/json";importViews.setAttribute("aria-label","Import session views");importViewsLabel.append(importViews);
    const validView=view=>{
      const keys=Object.keys(captureView());
      if(!isObject(view)||Object.keys(view).length!==keys.length||keys.some(key=>!Object.hasOwn(view,key)))throw new Error("Invalid view settings.");
      const option=(select,value)=>typeof value==="string"&&[...select.options].some(item=>item.value===value);
      if(!validText(view.search,10000)||!option(searchField,view.searchField)||!option(searchMode,view.searchMode)||!option(sortField,view.sort)||!option(secondaryField,view.secondary)||typeof view.descending!=="boolean")throw new Error("Invalid search or sort settings.");
      const category=(name,value)=>{
        if(name==="")return value==="*";
        const field=filterFields.find(item=>item.name===name);if(!field)return false;
        return value==="*"||(field.type==="boolean"?[true,false]:["",...field.options]).some(item=>JSON.stringify(item)===value);
      };
      if(!category(view.filter,view.value)||!category(view.extraFilter,view.extraValue)||(filterFields.length<2&&view.extraFilter!==""))throw new Error("Invalid category settings.");
      if(!option(presenceField,view.presence)||!option(presenceValue,view.presenceValue)||![25,50,100].includes(view.pageSize)||!option(summaryField,view.summary))throw new Error("Invalid presence, summary or page settings.");
      if(!Array.isArray(view.columns)||!view.columns.length||view.columns.length>spec.fields.length||new Set(view.columns).size!==view.columns.length||view.columns.some(name=>!spec.fields.some(field=>field.name===name)))throw new Error("Invalid table columns.");
      if(view.range!==null){
        const range=view.range;
        if(!isObject(range)||Object.keys(range).length!==3||!["name","low","high"].every(key=>Object.hasOwn(range,key))||!integerFields.some(field=>field.name===range.name)||[range.low,range.high].some(value=>value!==null&&!Number.isSafeInteger(value))||(range.low===null&&range.high===null)||(range.low!==null&&range.high!==null&&range.low>range.high))throw new Error("Invalid integer range.");
      }
      return view;
    };
    importViews.addEventListener("change",async()=>{
      const version=++presetReadVersion,revision=viewRevision,file=importViews.files[0];if(!file)return;
      try{
        if(file.size>1024*1024)throw new Error("View preset file exceeds1 MiB.");
        const preset=parseDataJSON(await file.text());if(version!==presetReadVersion)return;
        if(revision!==viewRevision)throw new Error("Session views changed while reading. Reopen the file.");
        if(!isObject(preset)||Object.keys(preset).length!==4||preset.format!=="afterlife-views/v1"||preset.app_id!==spec.app_id||preset.spec_fingerprint!==payload.spec_fingerprint||!Array.isArray(preset.views)||!preset.views.length||preset.views.length>20)throw new Error("Presets must match this app and specification, with1..20 views.");
        const pending=new Map();
        for(const entry of preset.views){
          if(!isObject(entry)||Object.keys(entry).length!==2||typeof entry.name!=="string"||!entry.name.trim()||entry.name.length>80||entry.name!==entry.name.trim()||sessionViews.has(entry.name)||pending.has(entry.name))throw new Error("Invalid or duplicate view name. Existing views are never replaced.");
          pending.set(entry.name,validView(entry.view));
        }
        if(sessionViews.size+pending.size>20)throw new Error("Import would exceed20 session views.");
        for(const [name,view] of pending)sessionViews.set(name,view);
        viewRevision++;refreshViews();tell("Imported "+pending.size+" session view(s). Choose and apply one explicitly; current filters and records are unchanged. Presets are not saved automatically across reloads.");
      }catch(error){if(version===presetReadVersion)tell("Views not imported: "+error.message+" Existing views, filters and records kept.",true);}
      finally{if(version===presetReadVersion)importViews.value="";}
    });
    viewPanel.append(node("h2","Session views"),node("p","Keep up to20 named review views in this tab. They are not stored automatically across reloads or included in record/app downloads; use the explicit preset file to keep them.","storage-note"),viewName,saveView,viewChoice,applyView,removeView,exportViews,importViewsLabel,node("p","Explicit presets contain view names and search/filter settings, not records. Search text can be private. Only matching app/spec presets import, up to1 MiB; existing view names are never replaced.","storage-note"));refreshViews();

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
    const undoFieldUpdate = button("Undo field update", async () => {
      if (!lastFieldUpdate || committing) return;
      if (dirty) return tell("Save or cancel editor changes before undoing the field update.", true);
      if (JSON.stringify(records) !== lastFieldUpdate.after) {
        lastFieldUpdate = null; undoFieldUpdate.hidden = true;
        return tell("Records changed after the field update. Undo refused; current records kept.", true);
      }
      if (await commit(lastFieldUpdate.before, {resetPage:true})) {
        lastFieldUpdate = null; undoFieldUpdate.hidden = true; panel.hidden = true; currentId = null;
        tell("Matching field update undone. Previous record values restored.");
      }
    });
    undoFieldUpdate.hidden = true;
    const undoEdit = button("Undo last edit", async () => {
      if(!lastRecordEdit||committing)return;
      if(dirty)return tell("Save or cancel editor changes before undoing the last edit.",true);
      if(JSON.stringify(records)!==lastRecordEdit.after){lastRecordEdit=null;undoEdit.hidden=true;return tell("Records changed after that edit. Undo refused; current records kept.",true);}
      const before=lastRecordEdit.before;
      if(await commit(before,{resetPage:true})){panel.hidden=true;currentId=null;dirty=false;tell("Last edit undone. Original field values restored; further record changes, imports or reloads clear this undo.");newButton.focus();}
    });
    undoEdit.hidden=true;
    toolbar.append(searchLabel, searchFieldLabel, searchModeLabel, sortLabel, sortDirection, secondaryLabel);
    if (filterFields.length) toolbar.append(filterLabel, filterValueLabel);
    if (integerFields.length) toolbar.append(rangeControls,summaryLabel,integerSummary);
    toolbar.append(presenceLabel);
    const exportMatching = (format) => {
      if (committing) return tell("Wait for the current save to finish before downloading.", true);
      try {
        const matching = currentView();
        if (format === "json") {
          download(exportDataJSON({...envelope(), records: matching}), spec.app_id + "-matching-data.json", "application/json");
        } else {
          download(exportCSV(spec, matching, csvScope.value === "visible" ? visibleFields : null), spec.app_id + (csvScope.value === "visible" ? "-matching-visible-columns-text.csv" : "-matching-text.csv"), "text/csv;charset=utf-8;header=present");
        }
        tell(`Download requested for all ${matching.length} matching records in view order, including other pages. Full collection kept. ${format === "csv" ? (csvScope.value === "visible" ? "Only visible table fields plus Record ID included. " : "All fields included. ")+"CSV text has an apostrophe prefix; use JSON for exact full-field data." : "Keep the app file with this data export."}`);
      } catch (error) { tell(error.message, true); }
    };
    const csvScopeLabel=node("label","Matching CSV columns","sort-label"),csvScope=node("select");csvScope.setAttribute("aria-label","Matching CSV columns");
    for(const [value,text] of [["all","All fields and Record ID"],["visible","Visible table columns and Record ID"]]){const option=node("option",text);option.value=value;csvScope.append(option);}csvScopeLabel.append(csvScope);
    const printScopeLabel=node("label","Printable columns","sort-label"),printScope=node("select");printScope.setAttribute("aria-label","Printable columns");
    for(const [value,text] of [["all","All fields and Record ID"],["visible","Visible table columns and Record ID"]]){const option=node("option",text);option.value=value;printScope.append(option);}printScopeLabel.append(printScope);
    const printMatching = button("Download printable view", () => {
      if (committing) return tell("Wait for the current save to finish before downloading.", true);
      try {
        const matching = currentView();
        download(printableRecords(spec, matching, records.length, printScope.value === "visible" ? visibleFields : null), spec.app_id+"-matching-print.html", "text/html;charset=utf-8");
        tell(`Printable view requested for all ${matching.length} matching records, including other pages. ${printScope.value === "visible" ? "Only visible table fields plus Record ID included." : "All fields plus Record ID included."} Open the downloaded file and print from your browser. Full collection kept; use JSON/app download for an editable backup.`);
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
    const exportControls=node("div",undefined,"toolbar-group-content");
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
      const fieldUpdateProposal = () => {
        if (!bulkChoice.value) return null;
        const [name, value] = JSON.parse(bulkChoice.value);
        const field = bulkFields.find(item => item.name === name);
        const matching = currentView();
        return {name, value, field,
          display: field.type === "boolean" ? (value ? "Yes" : "No") : value || "No value",
          matchingCount: matching.length,
          changes: matching.filter(record => record[name] !== value)
            .map(record => ({id: record.id, before: record[name], after: value}))};
      };
      const previewUpdate = button("Download matching update preview", () => {
        if (committing) return tell("Wait for the current save to finish.", true);
        const proposal = fieldUpdateProposal();
        if (!proposal) return;
        const preview = {format: "afterlife-field-update-preview/v1", app_id: spec.app_id,
          spec_fingerprint: payload.spec_fingerprint, field: proposal.name, new_value: proposal.value,
          total_records: records.length, matching_records: proposal.matchingCount, changes: proposal.changes,
          scope: "Read-only snapshot of current in-tab records across all matching pages; unsaved editor inputs excluded. IDs and field values may be private. This file cannot apply an update and does not authorize a later change; filters and records can change."};
        const serialized = JSON.stringify(preview, null, 2);
        if (new Blob([serialized]).size > MAX_BYTES) return tell("Update preview exceeds 10 MiB. Narrow the matching view first.", true);
        download(serialized, spec.app_id + "-field-update-preview.json", "application/json");
        tell(`Downloaded preview of ${proposal.changes.length} field changes among ${proposal.matchingCount} matching records. No records changed; protect IDs and values in the file.`);
      });
      const bulkUpdate = button("Update matching records", async () => {
        if (committing) return tell("Wait for the current save to finish.", true);
        if (dirty) return tell("Save or cancel editor changes before updating matching records.", true);
        const proposal = fieldUpdateProposal();
        if (!proposal) return;
        const {name, value, field, display, changes} = proposal;
        const ids = new Set(changes.map(change => change.id));
        if (!ids.size) return tell("No matching records need this field change. Current records kept.");
        if (!confirm(`Set ${field.label} to ${display} for ${ids.size} matching records, including other pages? You can undo this field update until another record change, import or reload.`)) return;
        const beforeUpdate = records.map(record => ({...record}));
        const next = records.map(record => ids.has(record.id) ? {...record, [name]: value} : record);
        if (await commit(next, {resetPage: true})) {
          lastFieldUpdate = {before:beforeUpdate, after:JSON.stringify(records)}; undoFieldUpdate.hidden = false;
          panel.hidden = true; currentId = null;
          tell(`Updated ${ids.size} matching records: ${field.label} set to ${display}.`);
        }
      });
      bulkUpdate.disabled = true; previewUpdate.disabled = true;
      bulkChoice.addEventListener("change", () => {bulkUpdate.disabled = !bulkChoice.value; previewUpdate.disabled = !bulkChoice.value;});
      exportControls.append(bulkChoice, previewUpdate, bulkUpdate);
    }
    if(integerFields.length){
      const numericField=node("select");numericField.setAttribute("aria-label","Matching integer field");const none=node("option","Choose integer field…");none.value="";numericField.append(none);
      for(const field of integerFields){const option=node("option",field.label);option.value=field.name;numericField.append(option);}
      const numericValue=node("input");numericValue.type="text";numericValue.inputMode="numeric";numericValue.maxLength=MAX_INTEGER_INPUT_LENGTH;numericValue.setAttribute("aria-label","Matching integer value");numericValue.placeholder="Exact integer; blank means null";
      const numericScope=node("p","Explicit integer assignment across all matching pages. Blank means null, allowed only for optional fields. No arithmetic or inferred values. Preview excludes unsaved editor inputs; private IDs/values are included in the file.","storage-note");
      function numericProposal(){
        const field=integerFields.find(row=>row.name===numericField.value);if(!field)throw new Error("Choose an integer field first.");
        const raw=numericValue.value.trim();if(raw&&!exactIntegerInput(raw))throw new Error("Use an exactly represented safe integer or blank for null.");
        const value=raw?Number(raw):null,matching=currentView(),ids=new Set(matching.map(row=>row.id));
        const next=records.map(row=>ids.has(row.id)?{...row,[field.name]:value}:row);
        prepareEnvelope(payload,{...envelope(),records:next},true);
        return {field,value,next,matching_records:matching.length,changes:matching.filter(row=>row[field.name]!==value).map(row=>({id:row.id,before:row[field.name],after:value}))};
      }
      const previewNumeric=button("Preview matching integer update",()=>{
        if(committing)return tell("Wait for the current save to finish.",true);
        try{const proposal=numericProposal(),text=JSON.stringify({format:"afterlife-field-update-preview/v1",app_id:spec.app_id,spec_fingerprint:payload.spec_fingerprint,field:proposal.field.name,new_value:proposal.value,total_records:records.length,matching_records:proposal.matching_records,changes:proposal.changes,scope:numericScope.textContent+" Read-only snapshot, not an apply plan or authorization for a later update."},null,2);if(new Blob([text]).size>MAX_BYTES)throw new Error("Preview exceeds10 MiB.");download(text,spec.app_id+"-integer-update-preview.json","application/json");tell(`Previewed ${proposal.changes.length} exact integer changes. Nothing saved.`);}catch(error){tell("Integer preview refused: "+error.message,true);}
      });
      const updateNumeric=button("Set matching integer",async()=>{
        if(committing)return tell("Wait for the current save to finish.",true);
        if(dirty)return tell("Save or cancel editor changes before updating matching records.",true);
        try{const proposal=numericProposal();if(!proposal.changes.length)return tell("Matching records already have this integer value.");
          if(!confirm(`Set ${proposal.field.label} to ${proposal.value===null?"null":proposal.value} for ${proposal.changes.length} matching records across all pages?`))return;
          const before=records.map(row=>({...row}));if(await commit(proposal.next,{resetPage:true})){lastFieldUpdate={before,after:JSON.stringify(records)};undoFieldUpdate.hidden=false;panel.hidden=true;currentId=null;tell(`Updated ${proposal.changes.length} matching integer values. Undo last field update is available until another record change, import or reload.`);}
        }catch(error){tell("Integer update refused: "+error.message,true);}
      });
      exportControls.append(numericField,numericValue,numericScope,previewNumeric,updateNumeric);
    }
    const selectionPanel=node("details",undefined,"toolbar-group chosen-records"),selectionHeading=node("summary","Chosen record handoff"),selectionContent=node("div",undefined,"toolbar-group-content");
    const chooseLabel=node("label"," Choose individual records"),chooseMode=node("input");chooseMode.type="checkbox";chooseLabel.prepend(chooseMode);
    const selectionScope=node("p","Choose records explicitly across filters and pages. Downloads include all fields, including hidden fields, in original collection order. Choices stay only in this tab, are not view presets, and clear after any saved record change/import/undo. Chosen-record deletion and field updates use only these choices; matching-view actions remain separate.");
    const chosenCount=node("p");chosenCount.setAttribute("aria-live","polite");
    function refreshChosen(){
      selectionHeading.textContent="Chosen record handoff"+(chosenIDs.size?` (${chosenIDs.size} chosen)`:"");
      chosenCount.textContent=`${chosenIDs.size} records chosen across all filters/pages. Unsaved editor inputs are excluded.`;
      exportChosenSelection.disabled=duplicateChosen.disabled=previewChosenDuplicate.disabled=chosenPrint.disabled=previewChosenDelete.disabled=deleteChosen.disabled=chosenApp.disabled=chosenJSON.disabled=chosenCSV.disabled=clearChosen.disabled=!chosenIDs.size;
      previewChosenField.disabled=updateChosenField.disabled=!chosenIDs.size||!chosenFieldChoice.value;
      refreshChosenTotals();
      refreshScopeChoices();
      previewChosenText.disabled=updateChosenText.disabled=!chosenIDs.size||!chosenTextField.value;
    }
    function exportChosen(kind){
      if(committing)return tell("Wait for the current save to finish.",true);
      if(!chosenIDs.size)return tell("Choose a record first.",true);
      const selected=records.filter(record=>chosenIDs.has(record.id));
      try{download(kind==="json"?exportDataJSON({...envelope(),records:selected}):exportCSV(spec,selected),spec.app_id+"-chosen-data."+(kind==="json"?"json":"csv"),kind==="json"?"application/json":"text/csv;charset=utf-8;header=present");tell(`Downloaded ${selected.length} explicitly chosen records with all fields. Current records unchanged; protect the file.`);}catch(error){tell(error.message,true);}
    }
    const chosenJSON=button("Export chosen JSON",()=>exportChosen("json")),chosenCSV=button("Export chosen CSV",()=>exportChosen("csv")),clearChosen=button("Clear chosen records",()=>{chosenIDs.clear();render();});
    const scopeChoices = node("fieldset", undefined, "toolbar-group");
    scopeChoices.append(node("legend", "Choose from the current view"));
    const choiceScope = node("select"), choiceAction = node("select");
    choiceScope.setAttribute("aria-label", "Record choice scope");
    choiceAction.setAttribute("aria-label", "Record choice action");
    for (const [value, text] of [["", "Choose a scope…"], ["page", "Current page"], ["matching", "All matching pages"]]) {
      const option = node("option", text); option.value = value; choiceScope.append(option);
    }
    for (const [value, text] of [["add", "Add to chosen records"], ["remove", "Remove from chosen records"]]) {
      const option = node("option", text); option.value = value; choiceAction.append(option);
    }
    const scopeChoiceSummary = node("p");
    scopeChoiceSummary.setAttribute("aria-live", "polite");
    function scopeChoiceProposal() {
      const visible = currentView();
      const page = Math.max(0, Math.min(currentPage, Math.max(0, Math.ceil(visible.length / pageSize) - 1)));
      const scoped = choiceScope.value === "matching" ? visible : choiceScope.value === "page" ? visible.slice(page * pageSize, (page + 1) * pageSize) : [];
      const add = choiceAction.value === "add";
      return {scope: choiceScope.value, action: choiceAction.value, scoped_records: scoped.length,
        changed_ids: scoped.filter(row => chosenIDs.has(row.id) !== add).map(row => row.id)};
    }
    function refreshScopeChoices() {
      const proposal = scopeChoiceProposal();
      previewScopeChoices.disabled = applyScopeChoices.disabled = !proposal.scope || !proposal.changed_ids.length;
      scopeChoiceSummary.textContent = !proposal.scope ? "Choose a scope explicitly. Filters and page changes never alter choices automatically." :
        `${proposal.scoped_records} current ${proposal.scope === "page" ? "page" : "matching"} records; ${proposal.changed_ids.length} choices would ${proposal.action === "add" ? "be added" : "be removed"}. Other choices are kept. No record values change.`;
    }
    const previewScopeChoices = button("Preview view choices", () => {
      if (committing) return tell("Wait for the current save to finish.", true);
      const proposal = scopeChoiceProposal(); if (!proposal.scope || !proposal.changed_ids.length) return;
      const text = JSON.stringify({format: "afterlife-view-choice-preview/v1", app_id: spec.app_id,
        spec_fingerprint: payload.spec_fingerprint, ...proposal, chosen_before: chosenIDs.size,
        scope_note: "Private IDs-only snapshot of current in-tab scope and choices. No fields exported or choices changed. Not an apply plan; later action recomputes its current view and requires confirmation. Other choices and all records are kept."}, null, 2);
      if (new Blob([text]).size > MAX_BYTES) return tell("Choice preview exceeds10 MiB.", true);
      download(text, spec.app_id + "-view-choice-preview.json", "application/json");
      tell("Downloaded private choice preview. No choices or records changed.");
    });
    const applyScopeChoices = button("Apply view choices", () => {
      if (committing) return tell("Wait for the current save to finish.", true);
      const proposal = scopeChoiceProposal(); if (!proposal.scope || !proposal.changed_ids.length) return;
      if (!confirm(`${proposal.action === "add" ? "Add" : "Remove"} ${proposal.changed_ids.length} choices from ${proposal.scope === "page" ? "the current page" : "all current matching pages"}? Other choices and all record values stay unchanged. This only changes session choices, not saved records.`)) return;
      for (const id of proposal.changed_ids) {
        if (proposal.action === "add") chosenIDs.add(id); else chosenIDs.delete(id);
      }
      if (proposal.action === "add") chooseMode.checked = true;
      render();
      tell(`${proposal.action === "add" ? "Added" : "Removed"} ${proposal.changed_ids.length} explicit view choices. Other choices and records kept; choices clear after saved record changes/import/undo or reload.`);
    });
    choiceScope.addEventListener("change", refreshScopeChoices);
    choiceAction.addEventListener("change", refreshScopeChoices);
    scopeChoices.append(choiceScope, choiceAction, scopeChoiceSummary, previewScopeChoices, applyScopeChoices);
    selectionContent.append(scopeChoices);
    const chosenPrint=button("Download chosen printable view",()=>{
      if(committing)return tell("Wait for the current save to finish.",true);
      if(!chosenIDs.size)return tell("Choose records explicitly first.",true);
      try{const selected=records.filter(row=>chosenIDs.has(row.id));download(printableRecords(spec,selected,records.length,printScope.value==="visible"?visibleFields:null,true),spec.app_id+"-chosen-print.html","text/html;charset=utf-8");tell(`Downloaded printable view of ${selected.length} explicitly chosen records in original order. Printable columns setting applies; editable exports still keep all fields. Current records unchanged.`);}catch(error){tell(error.message,true);}
    });
    const undoDuplication=button("Undo chosen duplication",async()=>{
      if(committing||!lastDuplication)return;
      if(dirty)return tell("Save or cancel editor changes before undoing duplication.",true);
      if(JSON.stringify(records)!==lastDuplication.after){lastDuplication=null;undoDuplication.hidden=true;return tell("Records changed since duplication; undo is unavailable.",true);}
      const before=lastDuplication.before;if(await commit(before,{resetPage:true})){panel.hidden=true;currentId=null;tell("Chosen duplication undone; original collection restored.");}
    });undoDuplication.hidden=true;
    const previewChosenDuplicate=button("Preview chosen duplication",()=>{
      if(committing)return tell("Wait for the current save to finish.",true);
      const ids=records.filter(row=>chosenIDs.has(row.id)).map(row=>row.id);if(!ids.length)return tell("Choose records explicitly first.",true);
      const text=JSON.stringify({format:"afterlife-duplication-preview/v1",app_id:spec.app_id,spec_fingerprint:payload.spec_fingerprint,total_records:records.length,chosen_record_ids:ids,proposed_total:records.length+ids.length,
        scope:"Read-only IDs/counts for duplicating explicit chosen records in original order across all filters/pages. No new IDs reserved or record fields emitted. Copies would include all fields, including hidden fields; unsaved editor inputs excluded. Later duplicate revalidates current selection/capacity and requires confirmation; this is not an apply plan or freshness proof."},null,2);
      if(new Blob([text]).size>MAX_BYTES)return tell("Duplication preview exceeds10 MiB.",true);download(text,spec.app_id+"-duplication-preview.json","application/json");tell("Downloaded chosen duplication preview. No records or IDs created.");
    });
    const duplicateChosen=button("Duplicate chosen records",async()=>{
      if(committing)return tell("Wait for the current save to finish.",true);
      if(dirty)return tell("Save or cancel editor changes before duplicating chosen records.",true);
      const selected=records.filter(row=>chosenIDs.has(row.id));if(!selected.length)return tell("Choose records explicitly first.",true);
      if(records.length+selected.length>MAX_RECORDS)return tell("Duplication exceeds the record limit. Original records kept.",true);
      if(!confirm(`Duplicate ${selected.length} explicitly chosen records with all fields, including hidden fields? Originals stay; fresh IDs and copies append in original order. Undo is available until another record change, import or reload.`))return;
      try{const ids=new Set(records.map(row=>row.id)),copies=[];for(const row of selected){let id=null;for(let attempt=0;attempt<8;attempt++){const candidate="r-"+[...crypto.getRandomValues(new Uint8Array(16))].map(byte=>byte.toString(16).padStart(2,"0")).join("");if(!ids.has(candidate)){id=candidate;break;}}if(!id)throw new Error("Could not create a distinct record ID.");ids.add(id);copies.push({...row,id});}
        const before=records.map(row=>({...row}));if(await commit([...records,...copies],{resetPage:true})){lastDuplication={before,after:JSON.stringify(records)};undoDuplication.hidden=false;panel.hidden=true;currentId=null;tell(`Duplicated ${copies.length} explicitly chosen records with fresh IDs. Originals kept; undo chosen duplication is available.`);}
      }catch(error){tell("Duplication refused: "+error.message,true);}
    });
    let pendingChosenSelection=null,chosenReadVersion=0;
    const recordsHash=async text=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,"0")).join("");
    const exportChosenSelection=button("Download chosen selection",async()=>{
      if(committing)return tell("Wait for the current save to finish.",true);
      const baseline=JSON.stringify(records),chosenSnapshot=JSON.stringify([...chosenIDs]),ids=records.filter(row=>chosenIDs.has(row.id)).map(row=>row.id);if(!ids.length)return tell("Choose records explicitly first.",true);
      try{const fingerprint=await recordsHash(baseline);if(JSON.stringify(records)!==baseline||JSON.stringify([...chosenIDs])!==chosenSnapshot)throw new Error("Records or choices changed while preparing. Try again.");
        const text=JSON.stringify({format:"afterlife-chosen-selection/v1",app_id:spec.app_id,spec_fingerprint:payload.spec_fingerprint,records_sha256:fingerprint,record_ids:ids},null,2);if(new Blob([text]).size>MAX_BYTES)throw new Error("Selection exceeds10 MiB.");download(text,spec.app_id+"-chosen-selection.json","application/json");tell("Downloaded private IDs-only selection for this exact current-tab record snapshot. No record fields saved; hash is a consistency guard, not authentication.");
      }catch(error){tell("Selection export refused: "+error.message,true);}
    });
    const chosenSelectionLabel=node("label","Resume chosen selection"),chosenSelectionFile=node("input");chosenSelectionFile.type="file";chosenSelectionFile.accept=".json,application/json";chosenSelectionLabel.append(chosenSelectionFile);
    const chosenSelectionReview=node("section"),chosenSelectionSummary=node("p");chosenSelectionReview.setAttribute("aria-label","Chosen selection import preview");chosenSelectionReview.hidden=true;
    const useChosenSelection=button("Use imported choices",()=>{
      if(!pendingChosenSelection)return;
      if(committing||JSON.stringify(records)!==pendingChosenSelection.baseline||JSON.stringify([...chosenIDs])!==pendingChosenSelection.chosenSnapshot){pendingChosenSelection=null;chosenSelectionReview.hidden=true;return tell("Records or choices changed after preview. Reopen the selection; existing choices kept.",true);}
      const ids=pendingChosenSelection.ids;chosenIDs.clear();for(const id of ids)chosenIDs.add(id);pendingChosenSelection=null;chosenSelectionReview.hidden=true;chosenReadVersion++;render();tell(`Resumed ${ids.length} explicit choices. Records unchanged; no import, deletion or save authorized.`);
    });
    const cancelChosenSelection=button("Cancel chosen selection import",()=>{pendingChosenSelection=null;chosenSelectionReview.hidden=true;chosenReadVersion++;chosenSelectionFile.value="";tell("Selection import cancelled. Existing choices kept.");});chosenSelectionReview.append(chosenSelectionSummary,useChosenSelection,cancelChosenSelection);
    chosenSelectionFile.addEventListener("change",async()=>{
      const file=chosenSelectionFile.files[0],request=++chosenReadVersion,baseline=JSON.stringify(records),chosenSnapshot=JSON.stringify([...chosenIDs]);pendingChosenSelection=null;chosenSelectionReview.hidden=true;if(!file)return;
      try{if(committing)throw new Error("Wait for the current save to finish.");if(file.size>MAX_BYTES)throw new Error("Selection exceeds10 MiB.");const value=parseDataJSON(await file.text());if(request!==chosenReadVersion)return;
        const fields=["format","app_id","spec_fingerprint","records_sha256","record_ids"];
        if(!isObject(value)||Object.keys(value).length!==fields.length||!fields.every(key=>own(value,key))||value.format!=="afterlife-chosen-selection/v1"||value.app_id!==spec.app_id||value.spec_fingerprint!==payload.spec_fingerprint||typeof value.records_sha256!=="string"||!/^[a-f0-9]{64}$/.test(value.records_sha256))throw new Error("Selection belongs to a different app/spec or unsupported format.");
        const ids=value.record_ids,known=new Set(records.map(row=>row.id));if(!Array.isArray(ids)||ids.length<1||ids.length>MAX_RECORDS||ids.some(id=>typeof id!=="string"||!known.has(id))||new Set(ids).size!==ids.length)throw new Error("Expected distinct existing record IDs.");
        const fingerprint=await recordsHash(baseline);if(request!==chosenReadVersion)return;
        if(fingerprint!==value.records_sha256||JSON.stringify(records)!==baseline||JSON.stringify([...chosenIDs])!==chosenSnapshot)throw new Error("Record snapshot or choices changed; inspect a fresh selection.");
        pendingChosenSelection={ids:[...ids],baseline,chosenSnapshot};chosenSelectionSummary.textContent=`Replace current choices with ${ids.length} explicit IDs from this exact record snapshot. Record values are not included in this preview. Nothing saved or changed until Use imported choices.`;chosenSelectionReview.hidden=false;
      }catch(error){if(request===chosenReadVersion)tell("Selection import refused: "+error.message+" Existing choices kept.",true);}finally{if(request===chosenReadVersion)chosenSelectionFile.value="";}
    });
    selectionContent.append(exportChosenSelection,chosenSelectionLabel,node("p","Explicit selection files contain private record IDs and an exact current-tab record hash. Resume only on matching app/spec and unchanged records; preview before replacing choices. They do not authorize record mutations, establish cross-tab freshness or change saved app data."),chosenSelectionReview);
    const chosenApp=button("Download chosen app",()=>saveHTML(false,true));
    const previewChosenDelete=button("Preview chosen deletion",()=>{
      if(committing)return tell("Wait for the current save to finish.",true);
      const ids=records.filter(row=>chosenIDs.has(row.id)).map(row=>row.id);if(!ids.length)return tell("Choose records explicitly first.",true);
      const text=JSON.stringify({format:"afterlife-record-deletion-preview/v1",app_id:spec.app_id,spec_fingerprint:payload.spec_fingerprint,total_records:records.length,chosen_record_ids:ids,
        scope:"Read-only proposed deletion of explicit chosen IDs in original collection order, across all filters/pages. Unsaved inputs excluded. IDs may be private. No deletion, save or cross-tab freshness check occurred. This file is not an apply plan; later deletion uses current choices and requires confirmation."},null,2);
      if(new Blob([text]).size>MAX_BYTES)return tell("Chosen deletion preview exceeds10 MiB.",true);
      download(text,spec.app_id+"-chosen-deletion-preview.json","application/json");tell(`Downloaded preview of ${ids.length} chosen record IDs. Nothing deleted; later confirmation uses current choices.`);
    });
    const deleteChosen=button("Delete chosen records",async()=>{
      if(committing)return tell("Wait for the current save to finish.",true);
      if(dirty)return tell("Save or cancel editor changes before deleting chosen records.",true);
      const ids=new Set(records.filter(row=>chosenIDs.has(row.id)).map(row=>row.id));if(!ids.size)return tell("Choose records explicitly first.",true);
      if(!confirm(`Delete ${ids.size} explicitly chosen records across all filters/pages? Other matching records are kept. Undo is available until the next import or reload.`))return;
      const entries=records.map((record,index)=>({record,index})).filter(entry=>ids.has(entry.record.id));
      if(await commit(records.filter(row=>!ids.has(row.id)),{resetPage:true})){
        lastDeleted={entries};undo.hidden=false;if(ids.has(currentId)){panel.hidden=true;currentId=null;}
        tell(`Deleted ${entries.length} explicitly chosen records. Other matching records kept. Undo is available until the next import or reload.`);
      }
    },"danger");
    const chosenFieldChoice=node("select");chosenFieldChoice.setAttribute("aria-label","Chosen field value");
    const noChosenField=node("option","Choose field update…");noChosenField.value="";chosenFieldChoice.append(noChosenField);
    for(const field of bulkFields)for(const value of field.type==="boolean"?[true,false]:[...(field.required?[]:[""]),...field.options]){
      const option=node("option",`Set ${field.label} to ${field.type==="boolean"?(value?"Yes":"No"):value||"No value"}`);option.value=JSON.stringify([field.name,value]);chosenFieldChoice.append(option);
    }
    function chosenFieldProposal(){
      if(!chosenFieldChoice.value)throw new Error("Choose a field update first.");
      const [name,value]=JSON.parse(chosenFieldChoice.value),field=bulkFields.find(row=>row.name===name);if(!field)throw new Error("Unknown chosen field.");
      const selected=records.filter(row=>chosenIDs.has(row.id)),ids=new Set(selected.map(row=>row.id));if(!ids.size)throw new Error("Choose records explicitly first.");
      const next=records.map(row=>ids.has(row.id)?{...row,[name]:value}:row);prepareEnvelope(payload,{...envelope(),records:next},true);
      return {field,value,next,chosen_records:selected.length,changes:selected.filter(row=>row[name]!==value).map(row=>({id:row.id,before:row[name],after:value}))};
    }
    const previewChosenField=button("Preview chosen field update",()=>{
      if(committing)return tell("Wait for the current save to finish.",true);
      try{const proposal=chosenFieldProposal(),text=JSON.stringify({format:"afterlife-field-update-preview/v1",app_id:spec.app_id,spec_fingerprint:payload.spec_fingerprint,selection:"explicit_chosen",field:proposal.field.name,new_value:proposal.value,total_records:records.length,chosen_records:proposal.chosen_records,changes:proposal.changes,scope:"Readonly current-tab proposal for explicit chosen records across all filters/pages. Private IDs/values included; unsaved editor inputs excluded. Not an apply plan or freshness proof. Later update uses current choices/value and requires separate confirmation."},null,2);
        if(new Blob([text]).size>MAX_BYTES)throw new Error("Chosen field preview exceeds10 MiB.");download(text,spec.app_id+"-chosen-field-preview.json","application/json");tell(`Downloaded ${proposal.changes.length} proposed chosen field changes; no records saved.`);
      }catch(error){tell(error.message,true);}
    });
    const updateChosenField=button("Update chosen records",async()=>{
      if(committing)return tell("Wait for the current save to finish.",true);
      if(dirty)return tell("Save or cancel editor changes before updating chosen records.",true);
      try{const proposal=chosenFieldProposal();if(!proposal.changes.length)return tell("Chosen records already have this value. Nothing changed.");
        const display=proposal.field.type==="boolean"?(proposal.value?"Yes":"No"):proposal.value||"No value";
        if(!confirm(`Set ${proposal.field.label} to ${display} for ${proposal.changes.length} explicitly chosen records across all filters/pages? Other records are kept; undo is available until another record change, import or reload.`))return;
        const before=records.map(row=>({...row}));if(await commit(proposal.next,{resetPage:true})){lastFieldUpdate={before,after:JSON.stringify(records)};undoFieldUpdate.hidden=false;panel.hidden=true;currentId=null;tell(`Updated ${proposal.changes.length} explicitly chosen records. Other records kept; undo last field update is available.`);}
      }catch(error){tell(error.message,true);}
    });
    chosenFieldChoice.hidden=previewChosenField.hidden=updateChosenField.hidden=!bulkFields.length;chosenFieldChoice.addEventListener("change",refreshChosen);
    chooseMode.addEventListener("change",render);selectionContent.append(chooseLabel,selectionScope,chosenCount,chosenJSON,chosenCSV,chosenApp,chosenPrint,previewChosenDuplicate,duplicateChosen,undoDuplication,previewChosenDelete,deleteChosen,chosenFieldChoice,previewChosenField,updateChosenField,clearChosen);selectionPanel.append(selectionHeading,selectionContent);
    if(integerFields.length){
      const numericField=node("select");numericField.setAttribute("aria-label","Chosen integer field");const none=node("option","Choose integer field…");none.value="";numericField.append(none);
      for(const field of integerFields){const option=node("option",field.label);option.value=field.name;numericField.append(option);}
      const numericValue=node("input");numericValue.type="text";numericValue.inputMode="numeric";numericValue.maxLength=MAX_INTEGER_INPUT_LENGTH;numericValue.setAttribute("aria-label","Chosen integer value");numericValue.placeholder="Exact integer; blank means null";
      const numericMode=node("select");numericMode.setAttribute("aria-label","Chosen integer operation");
      for(const [value,text]of [["set","Set one value"],["add","Add or subtract an amount"]]){const option=node("option",text);option.value=value;numericMode.append(option);}
      const numericScope=node("p",undefined,"storage-note");
      function numericProposal(){
        const field=integerFields.find(row=>row.name===numericField.value);if(!field)throw new Error("Choose an integer field first.");
        const adjustment=numericMode.value==="add",raw=numericValue.value.trim();
        if((adjustment&&!raw)||(raw&&!exactIntegerInput(raw)))throw new Error(adjustment?"Use an exactly represented safe integer amount; blank is not an adjustment.":"Use an exactly represented safe integer or blank for null.");
        const value=raw?Number(raw):null,chosen=records.filter(row=>chosenIDs.has(row.id)),ids=new Set(chosen.map(row=>row.id));
        if(!ids.size)throw new Error("Choose records explicitly first.");
        const next=records.map(row=>{
          if(!ids.has(row.id))return row;
          if(!adjustment)return {...row,[field.name]:value};
          if(!Number.isSafeInteger(row[field.name]))throw new Error("Every chosen value must be an integer. Empty values are not adjusted; nothing saved.");
          const exact=BigInt(row[field.name])+BigInt(value);
          if(exact<BigInt(Number.MIN_SAFE_INTEGER)||exact>BigInt(Number.MAX_SAFE_INTEGER))throw new Error("An adjusted value exceeds the safe integer range; nothing saved.");
          return {...row,[field.name]:Number(exact)};
        });
        prepareEnvelope(payload,{...envelope(),records:next},true);
        const changes=records.flatMap((row,index)=>ids.has(row.id)&&row[field.name]!==next[index][field.name]?[{id:row.id,before:row[field.name],after:next[index][field.name]}]:[]);
        return {field,value,next,adjustment,chosen_records:chosen.length,changes};
      }
      const previewNumeric=button("Preview chosen integer update",()=>{
        if(committing)return tell("Wait for the current save to finish.",true);
        try{const proposal=numericProposal(),text=JSON.stringify({format:"afterlife-field-update-preview/v1",app_id:spec.app_id,spec_fingerprint:payload.spec_fingerprint,selection:"explicit_chosen",field:proposal.field.name,operation:proposal.adjustment?"add":"set",...(proposal.adjustment?{delta:proposal.value}:{new_value:proposal.value}),total_records:records.length,chosen_records:proposal.chosen_records,changes:proposal.changes,scope:numericScope.textContent+" Read-only snapshot, not an apply plan or authorization for a later update. Private IDs/values included; unsaved editor inputs excluded."},null,2);if(new Blob([text]).size>MAX_BYTES)throw new Error("Preview exceeds10 MiB.");download(text,spec.app_id+"-integer-update-preview.json","application/json");tell(`Previewed ${proposal.changes.length} exact integer changes. Nothing saved.`);}catch(error){tell("Integer preview refused: "+error.message,true);}
      });
      const updateNumeric=button("Set chosen integer",async()=>{
        if(committing)return tell("Wait for the current save to finish.",true);
        if(dirty)return tell("Save or cancel editor changes before updating chosen records.",true);
        try{const proposal=numericProposal();if(!proposal.changes.length)return tell("Chosen integer values already match this proposal. Nothing changed.");
          const action=proposal.adjustment?`Add ${proposal.value} to ${proposal.field.label}`:`Set ${proposal.field.label} to ${proposal.value===null?"null":proposal.value}`;
          if(!confirm(`${action} for ${proposal.changes.length} chosen records across all pages? Other records stay unchanged; undo is available until another record change, import or reload.`))return;
          const before=records.map(row=>({...row}));if(await commit(proposal.next,{resetPage:true})){lastFieldUpdate={before,after:JSON.stringify(records)};undoFieldUpdate.hidden=false;panel.hidden=true;currentId=null;tell(`${proposal.adjustment?"Adjusted":"Updated"} ${proposal.changes.length} chosen integer values. Undo last field update is available until another record change, import or reload.`);}
        }catch(error){tell("Integer update refused: "+error.message,true);}
      });
      function refreshNumericMode(){
        const adjustment=numericMode.value==="add";
        numericValue.setAttribute("aria-label",adjustment?"Chosen integer delta":"Chosen integer value");
        numericValue.placeholder=adjustment?"Exact signed amount; negative subtracts":"Exact integer; blank means null";
        previewNumeric.textContent=adjustment?"Preview chosen integer adjustment":"Preview chosen integer update";
        updateNumeric.textContent=adjustment?"Adjust chosen integer":"Set chosen integer";
        numericScope.textContent=adjustment?"Add the supplied exact integer amount to every chosen value across filters/pages. Negative amounts subtract. Empty values or any unsafe result refuse the whole update; no rounding, clipping or skipped records. Preview before saving; undo restores original values.":"Explicit integer assignment for chosen records across filters/pages. Blank means null, allowed only for optional fields. Preview before saving; undo restores original values.";
      }
      numericMode.addEventListener("change",refreshNumericMode);refreshNumericMode();
      selectionContent.append(numericMode,numericField,numericValue,numericScope,previewNumeric,updateNumeric);
    }

    const chosenTotalsField=node("select");chosenTotalsField.setAttribute("aria-label","Summarize chosen field");const noChosenTotals=node("option","Choose field for totals…");noChosenTotals.value="";chosenTotalsField.append(noChosenTotals);
    for(const field of spec.fields.filter(row=>["integer","boolean","select"].includes(row.type))){const option=node("option",field.label);option.value=field.name;chosenTotalsField.append(option);}
    const chosenTotalsOutput=node("p");chosenTotalsOutput.setAttribute("role","status");chosenTotalsOutput.setAttribute("aria-label","Chosen field totals");
    function chosenTotals(){
      const field=spec.fields.find(row=>row.name===chosenTotalsField.value);if(!field)return null;
      const selected=records.filter(row=>chosenIDs.has(row.id)),base={format:"afterlife-chosen-field-totals/v1",app_id:spec.app_id,spec_fingerprint:payload.spec_fingerprint,selection:"explicit_chosen",field:field.name,kind:field.type,chosen_records:selected.length,total_records:records.length,scope:"Read-only current-tab totals over explicit chosen records across every filter/page; unsaved editor inputs excluded. Field/category labels and counts can be private. Integer sums/means/medians use exact integers and reduced fractions, never rounded estimates. No record IDs/text emitted, mutation, freshness proof or semantic conclusion; choices clear after any saved record change/import/undo."};
      if(field.type==="integer")return {...base,...exactIntegerTotals(selected,field.name)};
      const values=field.type==="boolean"?[true,false]:[...(field.required?[]:[""]),...field.options];return {...base,categories:values.map(value=>({value,count:selected.filter(row=>row[field.name]===value).length}))};
    }
    const exportChosenTotals=button("Download chosen totals",()=>{if(committing)return tell("Wait for the current save to finish.",true);const report=chosenTotals();if(!report||!chosenIDs.size)return;const text=JSON.stringify(report,null,2);if(new Blob([text]).size>MAX_BYTES)return tell("Chosen totals exceed10 MiB.",true);download(text,spec.app_id+"-chosen-totals.json","application/json");tell("Downloaded exact chosen field totals; no records saved or IDs/text exported.");});
    function refreshChosenTotals(){const report=chosenTotals();exportChosenTotals.disabled=!report||!chosenIDs.size;chosenTotalsOutput.textContent=!report?"Choose a field to summarize explicit choices.":report.kind==="integer"?`${report.chosen_records} chosen; ${report.integer_values} integer values; ${report.empty_values} empty; sum ${report.sum}; min ${report.min===null?"none":report.min}; max ${report.max===null?"none":report.max}; mean ${report.mean===null?"none":report.mean}; median ${report.median===null?"none":report.median}.`:report.chosen_records+" chosen; "+report.categories.map(row=>(typeof row.value==="boolean"?(row.value?"Yes":"No"):row.value||"No value")+": "+row.count).join("; ");}
    chosenTotalsField.addEventListener("change",refreshChosenTotals);selectionContent.append(chosenTotalsField,chosenTotalsOutput,exportChosenTotals);
    const chosenTextPanel=node("fieldset",undefined,"toolbar-group"),chosenTextContent=node("div",undefined,"toolbar-group-content"),chosenTextField=node("select"),chosenTextValue=node("textarea");chosenTextPanel.append(node("legend","Set text on chosen records"),chosenTextContent);chosenTextField.setAttribute("aria-label","Chosen text field");chosenTextValue.setAttribute("aria-label","Chosen text value");chosenTextValue.rows=3;
    const noTextField=node("option","Choose text field…");noTextField.value="";chosenTextField.append(noTextField);const textFields=spec.fields.filter(row=>["text","multiline"].includes(row.type));
    for(const field of textFields){const option=node("option",field.label);option.value=field.name;chosenTextField.append(option);}
    function chosenTextProposal(){const field=textFields.find(row=>row.name===chosenTextField.value);if(!field)throw new Error("Choose a text field first.");const value=chosenTextValue.value,selected=records.filter(row=>chosenIDs.has(row.id)),ids=new Set(selected.map(row=>row.id));if(!ids.size)throw new Error("Choose records explicitly first.");const next=records.map(row=>ids.has(row.id)?{...row,[field.name]:value}:row);prepareEnvelope(payload,{...envelope(),records:next},true);return {field,value,next,chosen_records:selected.length,changes:selected.filter(row=>row[field.name]!==value).map(row=>({id:row.id,before:row[field.name],after:value}))};}
    const previewChosenText=button("Preview chosen text update",()=>{
      if(committing)return tell("Wait for the current save to finish.",true);
      try{const proposal=chosenTextProposal(),text=JSON.stringify({format:"afterlife-field-update-preview/v1",app_id:spec.app_id,spec_fingerprint:payload.spec_fingerprint,selection:"explicit_chosen",field:proposal.field.name,new_value:proposal.value,total_records:records.length,chosen_records:proposal.chosen_records,changes:proposal.changes,scope:"Read-only exact text assignment for explicit chosen IDs across filters/pages. Private previous/new text included; no trimming, inferred values or unsaved editor inputs. No save or freshness proof. Later native update revalidates current choices/text and requires confirmation; this is not an apply plan."},null,2);if(new Blob([text]).size>MAX_BYTES)throw new Error("Text preview exceeds10 MiB.");download(text,spec.app_id+"-chosen-text-preview.json","application/json");tell(`Previewed ${proposal.changes.length} exact chosen text changes. Nothing saved; protect the private file.`);}catch(error){tell("Text preview refused: "+error.message,true);}
    });
    const updateChosenText=button("Set chosen text",async()=>{
      if(committing)return tell("Wait for the current save to finish.",true);if(dirty)return tell("Save or cancel editor changes before updating chosen records.",true);
      try{const proposal=chosenTextProposal();if(!proposal.changes.length)return tell("Chosen records already have this exact text. Nothing changed.");if(!confirm(`Set ${proposal.field.label} to the supplied exact text for ${proposal.changes.length} explicitly chosen records? Originals can be restored with Undo field update until another record change, import or reload.`))return;
        const before=records.map(row=>({...row}));if(await commit(proposal.next,{resetPage:true})){lastFieldUpdate={before,after:JSON.stringify(records)};undoFieldUpdate.hidden=false;panel.hidden=true;currentId=null;tell(`Updated ${proposal.changes.length} chosen text values. Other fields/records kept; undo last field update is available.`);}
      }catch(error){tell("Text update refused: "+error.message,true);}
    });
    chosenTextField.addEventListener("change",refreshChosen);chosenTextContent.append(chosenTextField,chosenTextValue,node("p","Assign exactly the supplied text to explicit chosen records only. Empty values require an optional field. Native Unicode,10000-character and whole-file limits apply; preview includes private text. No text cleanup or automatic saving."),previewChosenText,updateChosenText);chosenTextPanel.hidden=!textFields.length;selectionContent.append(chosenTextPanel);
    const categoryPanel=node("details",undefined,"toolbar-group category-totals"),categoryContent=node("div",undefined,"toolbar-group-content");
    categoryPanel.append(node("summary","Matching category totals"),categoryContent);
    const categoryLabel=node("label","Count categories in"),categoryField=node("select");categoryField.setAttribute("aria-label","Count categories in");
    const noCategory=node("option","Choose a category field…");noCategory.value="";categoryField.append(noCategory);
    for(const field of bulkFields){const option=node("option",field.label);option.value=field.name;categoryField.append(option);}
    categoryLabel.append(categoryField);const categoryOutput=node("div"),categoryScope=node("p","Counts cover all matching pages of current in-tab records only; unsaved editor inputs are excluded. Field labels and category values may be private. This summary selection stays in this tab and is not included in view presets.");
    function categoryTotals(matching=currentView()){
      const field=bulkFields.find(item=>item.name===categoryField.value);if(!field)return null;
      const values=field.type==="boolean"?[true,false]:[...(field.required?[]:[""]),...field.options];
      const counts=new Map(values.map(value=>[value,0]));for(const record of matching)counts.set(record[field.name],counts.get(record[field.name])+1);
      return {format:"afterlife-category-totals/v1",app_id:spec.app_id,spec_fingerprint:payload.spec_fingerprint,
        field:field.name,matching_records:matching.length,total_records:records.length,
        categories:values.map(value=>({value,count:counts.get(value)})),scope:categoryScope.textContent};
    }
    const exportCategory=button("Download category totals",()=>{
      if(committing)return tell("Wait for the current save to finish.",true);const totals=categoryTotals();if(!totals)return;
      const text=JSON.stringify(totals,null,2);if(new Blob([text]).size>MAX_BYTES)return tell("Category totals exceed10 MiB.",true);
      download(text,spec.app_id+"-category-totals.json","application/json");tell("Downloaded matching category counts only. No records changed; protect category values in the file.");
    });
    categoryField.addEventListener("change",render);categoryContent.append(categoryLabel,categoryScope,categoryOutput,exportCategory);categoryPanel.hidden=!bulkFields.length;
    const advanced=node("details",undefined,"toolbar-group advanced-filters"),advancedSummary=node("summary","Filter and sort"),advancedContent=node("div",undefined,"toolbar-group-content");
    advanced.open=window.matchMedia("(min-width: 900px)").matches;advanced.append(advancedSummary,advancedContent);
    toolbar.insertBefore(advanced,sortLabel);
    advancedContent.append(sortLabel,sortDirection,secondaryLabel);
    if(filterFields.length)advancedContent.append(filterLabel,filterValueLabel);
    if(filterFields.length>1)advancedContent.append(extraFilterLabel,extraFilterValueLabel);
    if(integerFields.length)advancedContent.append(rangeControls,summaryLabel,integerSummary);
    advancedContent.append(presenceLabel,pageSizeLabel);
    const exportsPanel=node("details",undefined,"toolbar-group export-actions");exportsPanel.open=window.matchMedia("(min-width: 900px)").matches;
    exportsPanel.append(node("summary","Exports and bulk actions"),exportControls);
    exportControls.append(button("Export matching JSON",()=>exportMatching("json")),button("Export matching CSV",()=>exportMatching("csv")),csvScopeLabel,button("Download matching app",()=>saveHTML(true)),printScopeLabel,printMatching,deleteMatching);
    toolbar.append(resetView,count,undo,undoFieldUpdate,undoEdit,separateCopy,newButton,exportsPanel,categoryPanel,selectionPanel);
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
        lastDuplication=null;undoDuplication.hidden=true;lastDeleted = null; undo.hidden = true; lastFieldUpdate = null; undoFieldUpdate.hidden = true; dirty = false; panel.hidden = true; currentId = null;
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
    const savePrevious = node("button", "Save and previous matching");
    savePrevious.type = "submit";
    const saveNext = node("button", "Save and next matching");
    saveNext.type = "submit";
    const continueHint = node("p", "Save and previous/next use the matching order before this edit is saved.");
    savePrevious.hidden = saveNext.hidden = continueHint.hidden = true;
    const close = () => {
      if (committing) return tell("Wait for the current save to finish.", true);
      if (dirty && !confirm("Discard unsaved changes in the editor?")) return;
      panel.hidden = true;
      dirty = false;
      currentId = null;
      newButton.focus();
    };
    const previewEdit=button("Download edit preview",()=>{
      if(committing)return tell("Wait for the current save to finish.",true);
      if(stale)return tell(conflictWarning,true);
      if(!currentId)return tell("Open an existing record to review its edits.",true);
      try{
        const before=records.find(row=>row.id===currentId);
        if(!before)throw new Error("This record no longer exists. Reopen the editor.");
        const proposed=editorRecord(currentId),{id,...changes}=proposed;
        applyOperation(spec,records,{op:"edit",id,changes});
        const fields=spec.fields.filter(field=>before[field.name]!==proposed[field.name]).map(field=>({field:field.name,before:before[field.name],after:proposed[field.name]}));
        const text=JSON.stringify({format:"afterlife-edit-preview/v1",app_id:spec.app_id,spec_fingerprint:payload.spec_fingerprint,record_id:id,changes:fields,scope:"Unsaved editor proposal against this tab's current stored record only. Private field values included. No save, cross-tab freshness check or authorization for later application. This snapshot is not an apply plan; native Save still validates and coordinates publication."},null,2);
        if(new Blob([text]).size>MAX_BYTES)throw new Error("Edit preview exceeds10 MiB.");
        download(text,spec.app_id+"-edit-preview.json","application/json");tell(`Downloaded ${fields.length} proposed field changes. Record and browser storage unchanged; protect private field values.`);
      }catch(error){tell("Edit preview refused: "+error.message,true);}
    });
    previewEdit.hidden=true;
    formActions.append(save, savePrevious, saveNext, previewEdit, button("Cancel", close));
    form.append(continueHint, formActions);
    const editorNavigation = node("nav", undefined, "form-actions");
    editorNavigation.setAttribute("aria-label", "Matching record navigation");
    const editorPosition = node("span");
    editorPosition.setAttribute("role", "status");
    const previousRecord = button("Previous matching record", () => moveEditor(-1));
    const nextRecord = button("Next matching record", () => moveEditor(1));
    editorNavigation.append(previousRecord, editorPosition, nextRecord);
    editorNavigation.hidden = true;
    panel.append(panelTitle, editorNavigation, form);
    layout.append(list, panel);
    app.append(header, status, message, toolbar, columnPanel, viewPanel, importReview, pagination, layout,
      node("footer", "Works without a server. Your downloaded HTML copy includes the app and its current records."));

    const reviewDialog=node("dialog",undefined,"record-review");reviewDialog.setAttribute("aria-labelledby","record-review-title");
    const reviewTitle=node("h2","Read-only record review");reviewTitle.id="record-review-title";
    const reviewNote=node("p","All stored fields shown, including hidden table columns. Unsaved editor inputs excluded. This review cannot save changes; closing it preserves your editor.");
    const reviewPosition=node("p");reviewPosition.setAttribute("role","status");
    const reviewValues=node("dl"),reviewActions=node("nav");reviewActions.setAttribute("aria-label","Read-only record navigation");
    let reviewIDs=[],reviewIndex=0;
    const previousReview=button("Previous review record",()=>{if(reviewIndex>0){reviewIndex--;renderReview();}}),nextReview=button("Next review record",()=>{if(reviewIndex+1<reviewIDs.length){reviewIndex++;renderReview();}}),closeReview=button("Close record review",()=>reviewDialog.close());
    reviewActions.append(previousReview,nextReview,closeReview);reviewDialog.append(reviewTitle,reviewNote,reviewPosition,reviewValues,reviewActions);app.append(reviewDialog);
    function renderReview(){
      const record=records.find(row=>row.id===reviewIDs[reviewIndex]);reviewValues.replaceChildren();
      if(!record){reviewPosition.textContent="This stored record is no longer available. Close and reopen the review.";previousReview.disabled=nextReview.disabled=true;return;}
      reviewPosition.textContent=`Matching record ${reviewIndex+1} of ${reviewIDs.length} · ${record.id}`;
      reviewValues.append(node("dt","Record ID"),node("dd",record.id));
      for(const field of spec.fields){const value=record[field.name];reviewValues.append(node("dt",field.label),node("dd",field.type==="boolean"?(value?"Yes":"No"):String(value??"")));}
      previousReview.disabled=reviewIndex===0;nextReview.disabled=reviewIndex+1===reviewIDs.length;
    }
    function openReview(id){
      if(committing)return tell("Wait for the current save to finish.",true);
      reviewIDs=currentView().map(row=>row.id);reviewIndex=reviewIDs.indexOf(id);if(reviewIndex<0)return tell("Record is outside the current view. Refresh the list.",true);
      renderReview();reviewDialog.showModal();closeReview.focus();
    }

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
      refreshEditorNavigation();
      fieldInputs.values().next().value.focus();
    }

    function refreshEditorNavigation() {
      previewEdit.hidden = editorNavigation.hidden = savePrevious.hidden = saveNext.hidden = continueHint.hidden = currentId === null;
      if (currentId === null) return;
      const visible = currentView(), index = visible.findIndex(record => record.id === currentId);
      previousRecord.disabled = committing || index <= 0;
      nextRecord.disabled = committing || index < 0 || index >= visible.length - 1;
      savePrevious.disabled = previousRecord.disabled;
      saveNext.disabled = nextRecord.disabled;
      editorPosition.textContent = index < 0 ? "Edited record is outside the current view" : `Matching record ${index + 1} of ${visible.length}`;
    }

    function moveEditor(direction) {
      const visible = currentView(), index = visible.findIndex(record => record.id === currentId);
      if (index >= 0 && visible[index + direction]) openEditor(visible[index + direction]);
    }

    function changePage(page) {
      if (committing) return tell("Wait for the current save to finish.", true);
      currentPage = page;
      render();
    }

    function currentView() {
      return sortRecords(spec, records.filter(record => matches(spec, record, search.value, searchField.value, searchMode.value) &&
        (!filterField.value || filterValue.value === "*" || record[filterField.value] === JSON.parse(filterValue.value)) &&
        (!extraFilterField.value || extraFilterValue.value === "*" || record[extraFilterField.value] === JSON.parse(extraFilterValue.value)) &&
        (!presenceField.value || ((record[presenceField.value] === null || record[presenceField.value] === "") === (presenceValue.value === "empty"))) &&
        (!activeRange || record[activeRange.name] !== null &&
          (activeRange.low === null || record[activeRange.name] >= activeRange.low) &&
          (activeRange.high === null || record[activeRange.name] <= activeRange.high))), sortField.value, descending, secondaryField.value);
    }

    function render() {
      const focusedPageControl = pagination.contains(document.activeElement) ? document.activeElement : null;
      list.replaceChildren();
      const visible = currentView();
      refreshEditorNavigation();
      refreshChosen();
      const advancedActive=Number(Boolean(sortField.value))+Number(Boolean(filterField.value&&filterValue.value!=="*"))+Number(Boolean(extraFilterField.value&&extraFilterValue.value!=="*"))+Number(Boolean(presenceField.value))+Number(Boolean(activeRange))+Number(Boolean(summaryField.value))+Number(pageSize!==PAGE_SIZE);
      advancedSummary.textContent="Filter and sort"+(advancedActive?" ("+advancedActive+" settings active)":"");
      count.textContent = `${visible.length} of ${records.length} records`;
      categoryOutput.replaceChildren();const totals=categoryTotals(visible);exportCategory.disabled=!totals;
      if(totals){
        categoryOutput.append(node("p",`${totals.matching_records} matching records across all pages; ${totals.total_records} total records.`));
        const list=node("dl");list.setAttribute("aria-label","Matching category counts");
        for(const row of totals.categories){list.append(node("dt",typeof row.value==="boolean"?(row.value?"Yes":"No"):row.value||"No value"),node("dd",String(row.count)));}
        categoryOutput.append(list);
      }
      integerSummary.hidden = !summaryField.value;
      if (summaryField.value) {
        const totals=exactIntegerTotals(visible,summaryField.value);
        integerSummary.textContent = `${totals.integer_values} integer values; ${totals.empty_values} empty; sum ${totals.sum}; min ${totals.min===null?"none":totals.min}; max ${totals.max===null?"none":totals.max}; mean ${totals.mean===null?"none":totals.mean}; median ${totals.median===null?"none":totals.median}. All matching pages; exact integers and reduced rational fractions, never rounded decimal estimates.`;
      }
      pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
      currentPage = Math.max(0, Math.min(currentPage, pageCount - 1));
      const start = currentPage * pageSize;
      pagination.hidden = visible.length <= pageSize;
      firstPage.disabled = previousPage.disabled = currentPage === 0;
      nextPage.disabled = lastPage.disabled = currentPage === pageCount - 1;
      pageStatus.textContent = `Page ${currentPage + 1} of ${pageCount}. Records ${visible.length ? start + 1 : 0}–${Math.min(start + pageSize, visible.length)} of ${visible.length}.`;
      if (focusedPageControl && (pagination.hidden || focusedPageControl.disabled)) {
        (pagination.hidden ? search : currentPage === 0 ? nextPage : previousPage).focus();
      }
      if (visible.length === 0) {
        list.append(node("p", records.length ? "No records match your search." : "This copy is empty. Create your first record.", "empty"));
        return;
      }
      const tableFields=spec.fields.filter(field=>visibleFields.has(field.name));
      const table = node("table");
      const head = node("thead");
      const headings = node("tr");
      for (const field of tableFields) {
        const th = node("th", field.label);
        th.scope = "col";
        headings.append(th);
      }
      const actionsHeading = node("th", "Actions");
      actionsHeading.scope = "col";
      headings.append(actionsHeading);
      head.append(headings);
      const body = node("tbody");
      for (const record of visible.slice(start, start + pageSize)) {
        const row = node("tr");
        row.dataset.recordId = record.id;
        for (const field of tableFields) {
          const value = record[field.name];
          const cell = node("td", field.type === "boolean" ? (value ? "Yes" : "No") : String(value ?? ""));
          if (field.type === "multiline") cell.className = "long-text";
          row.append(cell);
        }
        const actions = node("td", undefined, "row-actions");
        actions.append(node("small","ID: "+record.id,"record-identity"));
        if(chooseMode.checked){
          const label=node("label"," Choose"),selected=node("input");selected.type="checkbox";selected.checked=chosenIDs.has(record.id);selected.setAttribute("aria-label","Choose record "+record.id);
          selected.addEventListener("change",()=>{if(selected.checked)chosenIDs.add(record.id);else chosenIDs.delete(record.id);refreshChosen();});label.prepend(selected);actions.append(label);
        }
        actions.append(button("View", () => openReview(record.id)), button("Edit", () => openEditor(record)), button("Duplicate", () => openEditor(record, {duplicate: true})), button("Delete", async () => {
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
      save.disabled = savePrevious.disabled = saveNext.disabled = true;
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
        pendingChosenSelection=null;chosenSelectionReview.hidden=true;chosenReadVersion++;
        lastDuplication=null;undoDuplication.hidden=true;
        records = checked;
        chosenIDs.clear();
        lastRecordEdit=null;undoEdit.hidden=true;
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
        refreshEditorNavigation();
      }
    }

    async function commitOperation(operation) {
      try { return await commit(applyOperation(spec, records, operation)); }
      catch (error) { tell(error.message, true); return false; }
    }

    function editorRecord(id) {
      const record = {id};
      for (const field of spec.fields) {
        const input = fieldInputs.get(field.name);
        if (field.type === "integer" && input.value.trim() !== "" && !exactIntegerInput(input.value)) {
          throw new Error(`${field.label} must be an exactly represented safe integer or null.`);
        }
        record[field.name] = field.type === "boolean" ? input.checked : field.type === "integer" ?
          (input.value.trim() === "" ? null : Number(input.value)) : input.value;
        const opened = openedValues.get(field.name);
        if ((field.type === "text" || field.type === "multiline") && input.value === opened.displayed) {
          record[field.name] = opened.original;
        }
      }
      return record;
    }

    form.addEventListener("submit", async event => {
      event.preventDefault();
      const viewBeforeSave = currentView(), currentIndex = viewBeforeSave.findIndex(row => row.id === currentId);
      const direction = event.submitter === saveNext ? 1 : event.submitter === savePrevious ? -1 : 0;
      const continueId = direction && currentIndex >= 0 ? viewBeforeSave[currentIndex + direction]?.id : null;
      if (direction && !continueId) return tell(`No ${direction < 0 ? "previous" : "next"} matching record. Use Save record to finish this edit.`, true);
      const random = () => [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      let record;
      try{record=editorRecord(currentId || "r-" + random());}catch(error){return tell(error.message,true);}
      if (currentId && !records.some(item => item.id === currentId)) return tell("This record no longer exists. Reopen the editor.", true);
      const {id, ...changes} = record;
      const operation = currentId ? {op: "edit", id: currentId, changes} : {op: "create", record};
      const beforeEdit=currentId?records.map(row=>({...row})):null;
      if (await commitOperation(operation)) {
        if(beforeEdit&&JSON.stringify(beforeEdit)!==JSON.stringify(records)){lastRecordEdit={before:beforeEdit,after:JSON.stringify(records)};undoEdit.hidden=false;}
        dirty = false;
        const following = continueId && currentView().find(row => row.id === continueId);
        if (following) {
          openEditor(following);
          tell(`Record saved. Opened the ${direction < 0 ? "previous" : "next"} matching record from the view before saving. Undo last edit remains available until another record change, import or reload.`);
        } else {
          panel.hidden = true; currentId = null;
          tell(lastRecordEdit?"Record saved. Undo last edit is available in this tab until another record change, import or reload.":"Record saved.");
          newButton.focus();
        }
      }
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
