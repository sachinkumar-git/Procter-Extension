/** Quotes a field and neutralises spreadsheet formula injection. */
export function csvField(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

export function csvRow(values: unknown[]): string {
  return `${values.map(csvField).join(",")}\r\n`;
}
