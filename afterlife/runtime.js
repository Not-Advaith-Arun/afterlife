(function () {
  "use strict";
  const MAX_RECORDS = 10000;
  const MAX_BYTES = 10 * 1024 * 1024;
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

  function matches(spec, record, query) {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || spec.fields.some(field => String(record[field.name] ?? "").toLocaleLowerCase().includes(needle));
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
        records = validateEnvelope(payload, JSON.parse(lastStored));
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
    const saveHTML = () => {
      if (committing) return tell("Wait for the current save to finish before downloading.", true);
      const copy = document.documentElement.cloneNode(true);
      copy.querySelector("#app").replaceChildren();
      const suffix = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      copy.querySelector("#afterlife-data").textContent = escapeJSON({...payload, records,
        storage_key: `afterlife:v1:${spec.app_id}:snapshot:${suffix}`});
      download("<!doctype html>\n" + copy.outerHTML + "\n", spec.app_id + "-offline.html", "text/html;charset=utf-8");
      tell("Download requested. Open the downloaded HTML file to verify your saved copy.");
    };
    const fileInput = node("input");
    fileInput.type = "file";
    fileInput.accept = ".json,application/json";
    fileInput.id = "import-file";
    fileInput.hidden = true;
    fileActions.append(button("Download app", saveHTML, "primary"),
      button("Export JSON", () => {
        if (committing) return tell("Wait for the current save to finish before downloading.", true);
        try {
          download(exportDataJSON(envelope()), spec.app_id + "-data.json", "application/json");
          tell("JSON download requested. Keep the app file with this export.");
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
      if (records.length >= MAX_RECORDS) return tell("Record limit reached. Export your data before removing records.", true);
      const next = [...records];
      next.splice(Math.min(lastDeleted.index, records.length), 0, lastDeleted.record);
      if (await commit(next)) { lastDeleted = null; undo.hidden = true; tell("Deleted record restored."); }
    });
    undo.hidden = true;
    toolbar.append(searchLabel, count, undo, separateCopy, newButton);
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
    app.append(header, status, message, toolbar, pagination, layout,
      node("footer", "Works without a server. Your downloaded HTML copy includes the app and its current records."));

    function openEditor(record = null) {
      if (committing) return tell("Wait for the current save to finish.", true);
      if (dirty && !confirm("Discard unsaved changes in the editor?")) return;
      currentId = record ? record.id : null;
      panelTitle.textContent = record ? "Edit " + (spec.record_label || "record") : "New " + (spec.record_label || "record");
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

    function render() {
      const focusedPageControl = pagination.contains(document.activeElement) ? document.activeElement : null;
      list.replaceChildren();
      const visible = records.filter(record => matches(spec, record, search.value));
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
        actions.append(button("Edit", () => openEditor(record)), button("Delete", async () => {
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
      try {
        if (file.size > MAX_BYTES) throw new Error("Import exceeds 10 MiB.");
        const imported = validateEnvelope(payload, JSON.parse(await file.text()));
        if (!confirm(`Replace all ${records.length} records with ${imported.length} imported records? Export first if you need the current copy.`)) return;
        if (dirty && !confirm("Discard unsaved editor changes and import?")) return;
        if (await commit(imported, {resetPage: true})) {
          lastDeleted = null; undo.hidden = true; dirty = false; panel.hidden = true; currentId = null;
          tell(`Imported ${imported.length} records.`);
        }
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
    module.exports = {validateRecords, validateEnvelope, escapeJSON, matches, defaultValue, applyOperation, storeIfCurrent, exportDataJSON};
  }
  if (typeof document !== "undefined") boot();
})();
