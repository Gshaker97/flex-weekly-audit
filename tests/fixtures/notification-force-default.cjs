// Test-only preload. Keep every real implementation, but force all concrete lazy
// binding acquisitions through a default-only namespace. Child processes inherit it.
const Module = require("node:module");
const original = Module._load;
Module._load = function(request, parent, isMain) {
  const loaded = original.call(this, request, parent, isMain);
  if (!/notification-module-interop(?:\.ts)?$/.test(request)) return loaded;
  return { ...loaded, notificationModuleFunctions(namespace, names) {
    (globalThis[Symbol.for("notification.test.default-only.calls")] ??= []).push(...names);
    const defaults = Object.fromEntries(names.map(name => [name,
      namespace[name] === undefined ? namespace.default?.[name] : namespace[name]]));
    if (process.env.NOTIFICATION_TEST_INTEROP_TRACE) require("node:fs").appendFileSync(
      process.env.NOTIFICATION_TEST_INTEROP_TRACE, JSON.stringify(names) + "\n");
    return loaded.notificationModuleFunctions({ default: defaults }, names);
  } };
};
