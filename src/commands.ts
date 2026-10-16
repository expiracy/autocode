export type AutoCodeCommand = "config" | "log" | "status" | "help";

export const AUTOCODE_HELP = [
  "AutoCode commands",
  "/autocode config — Configure automatic approval and its review model.",
  "/autocode log — View recent reviewer verdicts and clear the log.",
  "/autocode status — Show the effective settings for this project.",
  "/autocode help — Show these commands.",
  "Running /autocode without a subcommand also opens help.",
].join("\n");

export function parseAutoCodeCommand(input: string): AutoCodeCommand | undefined {
  const command = input.trim().toLowerCase().replace(/^\/?autocode(?:\s+|$)/, "").trim();
  if (command === "") return "help";
  return command === "config" || command === "log" || command === "status" || command === "help" ? command : undefined;
}
