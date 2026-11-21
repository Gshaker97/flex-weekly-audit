/** Resolve only the requested lazy bindings across native ESM and CommonJS namespaces.
 * No imports, ambient clients or IO. Missing/non-function exports fail closed at acquisition. */
export function notificationModuleFunctions<M extends object, K extends keyof M & string>(
  namespace: M, names: readonly K[],
): Pick<M, K> {
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && (typeof value === "object" || typeof value === "function");
  const own = (value: unknown, key: string): unknown =>
    object(value) && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
  const resolved = {} as Pick<M, K>;
  for (const name of names) {
    const named = own(namespace, name);
    const value = named === undefined ? own(own(namespace, "default"), name) : named;
    if (typeof value !== "function") throw new Error(`notification_module_function_unavailable:${name}`);
    resolved[name] = value as M[K];
  }
  return Object.freeze(resolved);
}
