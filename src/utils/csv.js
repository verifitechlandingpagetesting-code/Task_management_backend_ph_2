// Shared CSV helpers (used by task calendar + task import)

export const parseCSVLine = (line) => {
  const values = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && inQuotes && next === '"') { cur += '"'; i++; }
    else if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) { values.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  values.push(cur.trim());
  return values;
};

export const normalizeHeader = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// → { headers: [...normalized], rows: [{ line: <1-based line no>, values: [...] }] }
export const readCSV = (text) => {
  const lines = String(text || "")
    .replace(/^﻿/, "")
    .split(/\r?\n/);

  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx === -1) throw new Error("The CSV file is empty.");

  const headers = parseCSVLine(lines[firstIdx]).map(normalizeHeader);
  const rows = [];
  for (let i = firstIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    rows.push({ line: i + 1, values: parseCSVLine(lines[i]) });
  }
  return { headers, rows };
};

// Strict YYYY-MM-DD that is also a real calendar day
export const isValidISODate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};
