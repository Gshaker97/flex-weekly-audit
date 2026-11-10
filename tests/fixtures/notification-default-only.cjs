// Deliberately opaque assignment: native import() exposes only `default`, not named exports.
module.exports = Object.fromEntries([
  ["binding", () => "default-only"],
  ["Reader", class Reader { read() { return "fixture"; } }],
]);
