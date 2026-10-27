const COLORS = {
  reset: "\u001b[0m",
  gray: "\u001b[90m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  magenta: "\u001b[35m",
} as const;

type Level = "info" | "warn" | "error" | "debug";

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function paint(level: Level, text: string): string {
  switch (level) {
    case "warn":
      return COLORS.yellow + text + COLORS.reset;
    case "error":
      return COLORS.red + text + COLORS.reset;
    case "debug":
      return COLORS.gray + text + COLORS.reset;
    default:
      return COLORS.cyan + text + COLORS.reset;
  }
}

export function log(level: Level, scope: string, message: string): void {
  const prefix = `${COLORS.gray}${stamp()}${COLORS.reset} ${paint(level, level.toUpperCase().padEnd(5))} ${COLORS.magenta}[${scope}]${COLORS.reset}`;
  if (level === "error") {
    console.error(prefix, message);
  } else {
    console.log(prefix, message);
  }
}

export const logger = {
  info: (scope: string, message: string) => log("info", scope, message),
  warn: (scope: string, message: string) => log("warn", scope, message),
  error: (scope: string, message: string) => log("error", scope, message),
  debug: (scope: string, message: string) => log("debug", scope, message),
};
