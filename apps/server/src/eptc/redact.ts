const tokenPattern = /\b(ark-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/g;
const secretNamePattern = /(KEY|TOKEN|SECRET|PASSWORD)/i;
const maximumLength = 4_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactString(value: string): string {
  let redacted = value;
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && secretNamePattern.test(name)) {
      redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
    }
  }
  redacted = redacted.replace(tokenPattern, "[REDACTED]");
  return redacted.slice(0, maximumLength);
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redactString(key), redactValue(item)]),
    );
  }
  return value;
}
