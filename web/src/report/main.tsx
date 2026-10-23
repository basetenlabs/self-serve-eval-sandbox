import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/globals.css";
import type { Report } from "@/lib/types";
import { ReportApp } from "./ReportApp";

// report.py writes the run's data into the #report-data script. Under `npm run dev` the script
// still holds its placeholder, so `?data=<run>/report.json` loads a run from `pr-eval serve`.
async function load(): Promise<Report> {
  const text = document.getElementById("report-data")?.textContent?.trim() ?? "";
  if (text.startsWith("{")) return JSON.parse(text) as Report;
  const url = new URLSearchParams(location.search).get("data");
  if (import.meta.env.DEV && url) return (await fetch(url)).json() as Promise<Report>;
  throw new Error("This report has no data.");
}

const root = createRoot(document.getElementById("root")!);
load().then(
  (report) => root.render(<StrictMode><ReportApp report={report} /></StrictMode>),
  (e: Error) => root.render(<p style={{ padding: 32, fontFamily: "monospace" }}>{e.message}</p>),
);
