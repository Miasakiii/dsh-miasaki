window.__ModuleLoader__.load({ id: "@yeesy369/dsh-browser-playwright", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/Card.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var fieldStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  marginBottom: 12,
  fontSize: 13
};
var inputStyle = {
  font: "inherit",
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--dsw-alias-border-l1, #d0d0d0)",
  background: "var(--dsw-alias-bg-layer-1, transparent)",
  color: "inherit"
};
function BrowserPlaywrightCard(props) {
  const { t } = props;
  const state = props.useBrowserPlaywrightCard((snapshot) => snapshot);
  const [open, setOpen] = (0, import_react.useState)(true);
  if (!state.available) return null;
  const blocked = !state.dirty || state.invalid || state.saving || !state.writable;
  const visibility = state.fields.windowVisibility.value || "visible";
  const stealth = state.fields.stealth.value === "" ? true : state.fields.stealth.value === "true";
  const allowFakeIp = state.fields.allowFakeIp.value === "" ? true : state.fields.allowFakeIp.value === "true";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "section",
    {
      style: {
        border: "1px solid var(--dsw-alias-border-l1, #d0d0d0)",
        borderRadius: 10,
        padding: 12,
        marginBottom: 12,
        background: "var(--dsw-alias-bg-layer-1, transparent)"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "button",
          {
            type: "button",
            onClick: () => {
              setOpen(!open);
            },
            style: { all: "unset", cursor: "pointer", display: "block", width: "100%" },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t("title") }),
              state.dirty ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { marginLeft: 8 }, children: t("unsaved") }) : null,
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { opacity: 0.75, marginTop: 4 }, children: t("description") })
            ]
          }
        ),
        open ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 12 }, children: [
          !state.writable ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: t("readOnly") }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { fontSize: 12, opacity: 0.8 }, children: t("restart") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: fieldStyle, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
              t("windowVisibility"),
              state.fields.windowVisibility.overridden ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: () => {
                props.resetField("windowVisibility");
              }, style: { marginLeft: 8 }, children: t("reset") }) : null
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
              "select",
              {
                style: inputStyle,
                value: visibility,
                onChange: (event) => {
                  props.edit("windowVisibility", event.target.value);
                },
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "visible", children: t("visible") }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "hidden", children: t("hidden") }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "headless", children: t("headless") })
                ]
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { ...fieldStyle, flexDirection: "row", alignItems: "center" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                checked: stealth,
                onChange: (event) => {
                  props.edit("stealth", event.target.checked ? "true" : "false");
                }
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("stealth") }),
            state.fields.stealth.overridden ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: () => {
              props.resetField("stealth");
            }, children: t("reset") }) : null
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { ...fieldStyle, flexDirection: "row", alignItems: "center" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                checked: allowFakeIp,
                onChange: (event) => {
                  props.edit("allowFakeIp", event.target.checked ? "true" : "false");
                }
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("allowFakeIp") }),
            state.fields.allowFakeIp.overridden ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: () => {
              props.resetField("allowFakeIp");
            }, children: t("reset") }) : null
          ] }),
          state.failed ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: t("saveFailed") }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: !state.dirty || state.saving, onClick: () => {
              props.discard();
            }, children: t("discard") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: blocked, onClick: () => {
              props.save();
            }, children: t(state.saving ? "saving" : "save") })
          ] })
        ] }) : null
      ]
    }
  );
}

// src/client/form.ts
function asRecord(value) {
  if (typeof value === "object" && value !== null) return value;
  return {};
}
function encodeValue(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join("\n");
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value == null) return "";
  return String(value);
}
function decodeValue(text, current) {
  if (Array.isArray(current)) {
    return text.split(/[\n,]+/u).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof current === "boolean" || text === "true" || text === "false") return text === "true";
  return text;
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function createCardForm(scope, fieldNames) {
  const draft = /* @__PURE__ */ new Map();
  const listeners = /* @__PURE__ */ new Set();
  let saving = false;
  let failed = false;
  let snapshot = project();
  const notify = () => {
    snapshot = project();
    for (const listener of listeners) listener();
  };
  scope.subscribe(() => {
    if (saving) return;
    notify();
  });
  function host() {
    return scope.getSnapshot();
  }
  function project() {
    const snap = host();
    const available = snap.status === "ready" || snap.status === void 0 && snap.value !== void 0;
    const writable = available && snap.writable !== false;
    const value = asRecord(snap.value);
    const user = asRecord(snap.user);
    const fields = {};
    let dirty = false;
    for (const name of fieldNames) {
      const encoded = encodeValue(value[name]);
      const text = draft.has(name) ? draft.get(name) : encoded;
      if (draft.has(name) && text !== encoded) dirty = true;
      fields[name] = {
        value: text,
        overridden: Object.prototype.hasOwnProperty.call(user, name)
      };
    }
    return {
      available,
      writable,
      dirty,
      invalid: false,
      saving,
      failed,
      fields
    };
  }
  const store = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
  const actions = {
    edit(field, text) {
      if (!snapshot.writable) return;
      draft.set(field, text);
      failed = false;
      notify();
    },
    resetField(field) {
      draft.delete(field);
      void Promise.resolve(scope.unset(field)).catch(() => {
        failed = true;
        notify();
      });
      notify();
    },
    discard() {
      draft.clear();
      failed = false;
      notify();
    },
    save() {
      if (!snapshot.writable || !snapshot.dirty || saving) return;
      saving = true;
      failed = false;
      notify();
      const snap = host();
      const value = asRecord(snap.value);
      const base = asRecord(snap.base);
      const writes = [];
      for (const name of fieldNames) {
        if (!draft.has(name)) continue;
        const current = value[name] ?? base[name];
        const next = decodeValue(draft.get(name), current);
        writes.push(Promise.resolve(
          same(next, base[name]) ? scope.unset(name) : scope.set(name, next)
        ));
      }
      void Promise.all(writes).then(() => {
        draft.clear();
        saving = false;
        failed = false;
        notify();
      }, () => {
        saving = false;
        failed = true;
        notify();
      });
    }
  };
  return { store, actions };
}

// src/client/locales.ts
var NS = "settings.browserPlaywright";
var zh = {
  title: "\u6D4F\u89C8\u5668\u7A97\u53E3",
  description: "\u7A97\u53E3\u6A21\u5F0F\u4E0E\u53CD\u68C0\u6D4B\u3002\u8FD9\u4E9B\u9879\u5728\u4E0B\u6B21\u542F\u52A8\u6D4F\u89C8\u5668\u65F6\u751F\u6548\u3002",
  windowVisibility: "\u7A97\u53E3\u6A21\u5F0F",
  stealth: "\u8F7B\u91CF\u53CD\u68C0\u6D4B\u8865\u4E01",
  allowFakeIp: "\u5141\u8BB8\u4EE3\u7406 fake-ip DNS\uFF08Clash/Surge 198.18\uFF09",
  restart: "\u4FDD\u5B58\u540E\u8BF7\u91CD\u542F dsh\uFF0C\u6216\u7B49\u4E0B\u4E00\u6B21\u542F\u52A8\u6D4F\u89C8\u5668\u65F6\u751F\u6548\u3002",
  save: "\u4FDD\u5B58",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  discard: "\u653E\u5F03",
  saveFailed: "\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002",
  unsaved: "\u672A\u4FDD\u5B58",
  readOnly: "\u5F53\u524D\u53EA\u8BFB\u3002",
  reset: "\u6062\u590D\u9ED8\u8BA4",
  visible: "\u53EF\u89C1\u7A97\u53E3",
  hidden: "\u9690\u85CF\u7A97\u53E3",
  headless: "\u65E0\u5934"
};
var en = {
  title: "Browser window",
  description: "Window mode and anti-detection. These apply the next time the browser launches.",
  windowVisibility: "Window mode",
  stealth: "Lightweight stealth patch",
  allowFakeIp: "Allow proxy fake-ip DNS (Clash/Surge 198.18)",
  restart: "Restart dsh after saving, or wait until the next browser launch.",
  save: "Save",
  saving: "Saving\u2026",
  discard: "Discard",
  saveFailed: "Save failed. Try again.",
  unsaved: "Unsaved",
  readOnly: "Read-only right now.",
  reset: "Reset",
  visible: "Visible window",
  hidden: "Hidden window",
  headless: "Headless"
};

// src/client/index.ts
var inject = ["slots", "locale", "settingsScope"];
var FIELDS = ["windowVisibility", "stealth", "allowFakeIp"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "browser-playwright: settings card copy");
  const form = createCardForm(ctx.settingsScope.bind({ namespace: "browser-playwright" }), FIELDS);
  ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
    name: "settings.plugin.item",
    key: "browser-playwright",
    locale: NS,
    inject: () => ({
      hooks: { browserPlaywrightCard: form.store },
      ...form.actions
    })
  }, BrowserPlaywrightCard));
}

return module.exports; } });

//# sourceMappingURL=client.js.map
