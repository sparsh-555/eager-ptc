export type ErrorClass = "throttle" | "transient" | "permanent";

function errorText(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; status?: unknown; statusCode?: unknown };
    return [candidate.message, candidate.status, candidate.statusCode]
      .filter((value) => value !== undefined && value !== null)
      .map(String)
      .join(" ");
  }
  return String(error);
}

export function classifyError(error: unknown): ErrorClass {
  const text = errorText(error).toLowerCase();
  if (/\b429\b|toomanyrequests|setlimitexceeded|rate limit|exceeded retry limit/.test(text)) return "throttle";
  if (/\b500\b|\b502\b|\b503\b|\b504\b|econnreset|etimedout|socket hang up/.test(text)) return "transient";
  return "permanent";
}
