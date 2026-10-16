import { Rpc } from "@opencode/plugin";

const object = { type: "object", additionalProperties: true } as const;
const string = { type: "string", minLength: 1 } as const;
const input = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
} as const);
const errors = { settings_error: input({ message: string }, ["message"]) };
const diagnosticsErrors = { diagnostics_error: input({ message: string }, ["message"]) };
const model = input({ providerID: string, id: string, variant: string }, ["providerID", "id"]);
const logEntry = input({
  id: string, timestamp: { type: "string", format: "date-time" }, sessionID: string,
  decision: { type: "string", enum: ["allow", "ask", "deny"] }, reason: string,
  durationMs: { type: "number", minimum: 0 }, model,
}, ["id", "timestamp", "sessionID", "decision", "reason", "durationMs"]);

export const AutoCodeRpc = Rpc.define({
  id: "autocode",
  methods: {
    settings: { input: input({}), output: object, errors },
    saveSettings: {
      input: input({ revision: string, options: object }, ["revision", "options"]),
      output: object,
      errors,
    },
    status: {
      input: input({}),
      output: input({
        enabled: { type: "boolean" }, model,
        timeoutMs: { type: "integer", minimum: 1, maximum: 300_000 },
        maxContextChars: { type: "integer", minimum: 1000, maximum: 1_000_000 },
        logLimit: { const: 100 },
      }, ["enabled", "timeoutMs", "maxContextChars", "logLimit"]),
      errors: diagnosticsErrors,
    },
    log: {
      input: input({}),
      output: input({
        entries: { type: "array", items: logEntry, maxItems: 100 }, maxEntries: { const: 100 },
      }, ["entries", "maxEntries"]),
      errors: diagnosticsErrors,
    },
    clearLog: {
      input: input({}),
      output: input({ cleared: { const: true } }, ["cleared"]),
      errors: diagnosticsErrors,
    },
  },
  events: {
    openSettings: { schema: input({ sessionID: string }, ["sessionID"]) },
    openHelp: { schema: input({ sessionID: string }, ["sessionID"]) },
    openLog: { schema: input({ sessionID: string }, ["sessionID"]) },
    openStatus: { schema: input({ sessionID: string }, ["sessionID"]) },
  },
});
