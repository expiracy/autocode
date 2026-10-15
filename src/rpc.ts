import { Rpc } from "@opencode/plugin";

const object = { type: "object", additionalProperties: true } as const;
const string = { type: "string", minLength: 1 } as const;
const input = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
} as const);
const errors = { settings_error: input({ message: string }, ["message"]) };

export const AutoCodeRpc = Rpc.define({
  id: "autocode",
  methods: {
    settings: { input: input({}), output: object, errors },
    saveSettings: {
      input: input({ revision: string, options: object }, ["revision", "options"]),
      output: object,
      errors,
    },
  },
  events: {
    openSettings: { schema: input({ sessionID: string }, ["sessionID"]) },
  },
});
