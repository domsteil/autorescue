export function sanitizeForReport(value) {
  if (value == null) return value;
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForReport(item));
  }
  if (valueType === 'object') {
    try {
      return JSON.parse(
        JSON.stringify(value, (key, val) =>
          typeof val === 'function' || typeof val === 'bigint' ? String(val) : val,
        ),
      );
    } catch {
      return value;
    }
  }
  return value;
}
