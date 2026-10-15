export interface ApprovalModel {
  providerID: string;
  id: string;
  variant?: string;
}

export interface ResolvedOptions {
  enabled: boolean;
  model?: ApprovalModel;
  timeoutMs: number;
  maxContextChars: number;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\s\p{C}]/u.test(value)) {
    throw new TypeError(`autocode: ${name} must be a nonempty string without whitespace or control characters.`);
  }
  return value;
}

function rejectUnknownKeys(input: Record<string, unknown>, keys: string[], name: string): void {
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) {
      throw new TypeError(`autocode: unknown ${name} ${JSON.stringify(key)}; valid options are ${keys.join(", ")}.`);
    }
  }
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`autocode: ${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export function parseOptions(input: Record<string, unknown>): ResolvedOptions {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("autocode: plugin options must be an object.");
  }
  rejectUnknownKeys(input, ["enabled", "model", "timeoutMs", "maxContextChars"], "option");
  if (Object.hasOwn(input, "enabled") && typeof input.enabled !== "boolean") {
    throw new TypeError("autocode: enabled must be a boolean.");
  }
  const options: ResolvedOptions = {
    enabled: input.enabled !== false,
    timeoutMs: Object.hasOwn(input, "timeoutMs")
      ? boundedInteger(input.timeoutMs, "timeoutMs", 1, 300_000) : 30_000,
    maxContextChars: Object.hasOwn(input, "maxContextChars")
      ? boundedInteger(input.maxContextChars, "maxContextChars", 1000, 1_000_000) : 64_000,
  };
  if (typeof input.model === "string" && input.model !== "inherit") {
    const separator = input.model.indexOf("/");
    if (separator <= 0 || separator === input.model.length - 1) {
      throw new TypeError("autocode: model must be 'inherit', a provider/model string, or an object with providerID and id.");
    }
    options.model = {
      providerID: identifier(input.model.slice(0, separator), "model.providerID"),
      id: identifier(input.model.slice(separator + 1), "model.id"),
    };
  } else if (typeof input.model === "object" && input.model !== null) {
    const model = input.model as Record<string, unknown>;
    rejectUnknownKeys(model, ["providerID", "id", "variant"], "model option");
    options.model = {
      providerID: identifier(model.providerID, "model.providerID"),
      id: identifier(model.id, "model.id"),
    };
    if (options.model.providerID.includes("/")) {
      throw new TypeError("autocode: model.providerID must not contain a slash; put the model name in model.id.");
    }
    if (Object.hasOwn(model, "variant")) {
      options.model.variant = identifier(model.variant, "model.variant");
    }
  } else if (Object.hasOwn(input, "model") && input.model !== "inherit") {
    throw new TypeError("autocode: model must be 'inherit', a provider/model string, or an object with providerID and id.");
  }
  return options;
}
