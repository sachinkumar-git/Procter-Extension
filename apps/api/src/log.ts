export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

function write(level: string, message: string, fields: LogFields = {}) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...fields,
    }),
  );
}

export const jsonLogger: Logger = {
  info: (message, fields) => write("info", message, fields),
  error: (message, fields) => write("error", message, fields),
};
