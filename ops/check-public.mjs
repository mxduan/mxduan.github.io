// scripts/check-public.mjs
import { appendFile } from "node:fs/promises";

// src/view.js
var validAlert = (alert) => alert && typeof alert === "object" && typeof alert.header === "string" && typeof alert.type === "string" && typeof alert.planned === "boolean" && Array.isArray(alert.periods) && alert.periods.every((period) => period && typeof period === "object" && !Array.isArray(period) && ["start", "end"].every((key) => period[key] == null || Number.isFinite(period[key]) && period[key] >= 0) && (period.start == null || period.end == null || period.end > period.start));
function alertState(current, now = Date.now()) {
  if (!Number.isFinite(now) || !current || !Array.isArray(current.alerts) || !current.alerts.every(validAlert)) return "unavailable";
  const source = typeof current.sourceAt === "string" ? Date.parse(current.sourceAt) : NaN;
  const fetched = typeof current.fetchedAt === "string" ? Date.parse(current.fetchedAt) : NaN;
  if (!Number.isFinite(source) || !Number.isFinite(fetched) || source > now + 5e3 || fetched > now + 5e3) return "unavailable";
  if (current.state !== "ok") return current.state === "error" ? "error" : "unavailable";
  return now - source > 6e5 || now - fetched > 12e4 ? "stale" : "fresh";
}
function riderState(value, now = Date.now()) {
  if (!value || value.state !== "ok") return value?.state === "error" ? "error" : "unavailable";
  const source = Date.parse(value.sourceAt), fetched = Date.parse(value.fetchedAt);
  if (!Number.isFinite(source) || !Number.isFinite(fetched) || source > now + 5e3 || fetched > now + 5e3) return "unavailable";
  return now - source > 12e4 || now - fetched > 12e4 ? "stale" : "fresh";
}
function arrivalChoices(value, station, direction, destination = "", now = Date.now()) {
  if (riderState(value, now) !== "fresh") return [];
  const epoch = now / 1e3;
  const out = [];
  for (const report of value.reports || []) {
    if (report.direction !== direction) continue;
    const index = report.stops.findIndex((s) => s.stopId === station + direction);
    if (index < 0) continue;
    const stop = report.stops[index];
    const kind = stop.arrivalAt >= epoch ? "arrival" : stop.departureAt >= epoch ? "departure" : null;
    if (!kind) continue;
    const at = kind === "arrival" ? stop.arrivalAt : stop.departureAt;
    if (at - epoch > 7200) continue;
    const target = destination ? report.stops.slice(index + 1).find((s) => s.stopId === destination + direction) : null;
    const end = target?.arrivalAt ?? target?.departureAt;
    const base2 = stop.departureAt >= at ? stop.departureAt : at;
    out.push({ at, kind, minutes: Math.ceil((at - epoch) / 60), nextStopId: report.nextStopId, rideMinutes: end >= base2 && end - base2 <= 7200 ? Math.ceil((end - base2) / 60) : null, destinationAt: end >= base2 ? end : null });
  }
  return out.sort((a, b) => a.at - b.at).slice(0, 5);
}

// src/rider-loader.js
function selectFreshRider(values, previous, now) {
  const valid = values.filter((value) => value?.route === "E" && value.model === "e-rider-estimates-v1" && Array.isArray(value.reports) && riderState(value, now) === "fresh");
  const floor = Number.isFinite(Date.parse(previous?.sourceAt)) ? Date.parse(previous.sourceAt) : -Infinity;
  return valid.filter((value) => Date.parse(value.sourceAt) >= floor).sort((a, b) => Date.parse(b.sourceAt) - Date.parse(a.sourceAt) || Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))[0];
}
async function fetchFreshRider(baseURL, previous, { fetcher = fetch, clock = Date.now, timeoutMs = 5e3 } = {}) {
  const minute = Math.floor(clock() / 6e4);
  const urls = [minute, minute - 1, minute - 2].map((bucket) => baseURL + bucket + ".json");
  urls.push(new URL("../rider.json", baseURL).href);
  const values = await Promise.all(urls.map(async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, { cache: "no-store", credentials: "omit", signal: controller.signal });
      return response.ok ? await response.json() : void 0;
    } catch {
      return void 0;
    } finally {
      clearTimeout(timer);
    }
  }));
  return selectFreshRider(values, previous, clock());
}

// src/operational.js
function operationalFresh(r, now = Date.now()) {
  const age2 = (now - Date.parse(r?.sourceAt)) / 1e3;
  return r?.state === "ok" && Number.isFinite(age2) && age2 >= -5 && age2 <= 120;
}

// src/service-health.js
var age = (value, now) => {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? Math.round((now - parsed) / 1e3) : null;
};
var within = (seconds, maximum) => seconds !== null && seconds >= -5 && seconds <= maximum;
function serviceHealth({ rider: rider2, observations: observations2, dashboard: dashboard2 }, now = Date.now()) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, ...detail });
  let usable = 0;
  if (riderState(rider2, now) === "fresh" && rider2?.route === "E" && rider2?.model === "e-rider-estimates-v1") {
    for (const report of rider2.reports || []) {
      for (const stop of report.stops || []) {
        const station = stop.stopId?.slice(0, -1);
        if (station && rider2.stations?.[station] && ["N", "S"].includes(report.direction))
          usable += arrivalChoices(rider2, station, report.direction, "", now).length;
      }
    }
  }
  add("arrival_estimates", usable > 0, { state: riderState(rider2, now), sourceAgeSeconds: age(rider2?.sourceAt, now), hasSelectableFutureEstimate: usable > 0 });
  const recordAge = age(observations2?.sourceAt, now), publishedAge = age(observations2?.generatedAt, now);
  add(
    "observation_collection",
    observations2?.health === "fresh" && ["fresh", "duplicate"].includes(observations2?.lastSampleState) && within(recordAge, 1200) && within(publishedAge, 1200),
    { state: observations2?.lastSampleState || "unavailable", sourceAgeSeconds: recordAge, publicationAgeSeconds: publishedAge, publicationAllowanceSeconds: 1200 }
  );
  const alerts = rider2?.current || dashboard2?.current;
  const alertStatus = alertState(alerts, now);
  add("service_alerts", alertStatus === "fresh", { state: alertStatus, sourceAgeSeconds: age(alerts?.sourceAt, now), fetchedAgeSeconds: age(alerts?.fetchedAt, now), sourceAllowanceSeconds: 600, downloadAllowanceSeconds: 120 });
  const operational = rider2?.operational || observations2?.operational;
  for (const line of ["E", "F"]) {
    const route = operational?.routes?.[line];
    add("operational_" + line, rider2?.state !== "error" && operationalFresh(route, now), { state: route?.state || "unavailable", sourceAgeSeconds: age(route?.sourceAt, now) });
  }
  const healthy = checks.every((c) => c.ok), coreAvailable = checks.filter((c) => c.name !== "service_alerts").every((c) => c.ok);
  const upstreamExpired = alertStatus === "stale" && alerts.state === "ok" && now - Date.parse(alerts.sourceAt) > 6e5 && now - Date.parse(alerts.fetchedAt) <= 12e4;
  if (upstreamExpired) checks.find((c) => c.name === "service_alerts").degradationReason = "upstream_source_age";
  const status = healthy ? "healthy" : coreAvailable && upstreamExpired ? "degraded" : "unhealthy";
  return { checkedAt: new Date(now).toISOString(), healthy, coreAvailable, status, checks, scope: "Published evidence availability. No browser rendering or physical punctuality claim." };
}

// scripts/check-public.mjs
var base = "https://mxduan.github.io/rail-reliability/";
var riderURL = "https://raw.githubusercontent.com/mxduan/mxduan.github.io/master/rail-reliability/data/rider/";
async function json(url) {
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1e4) });
    if (!response.ok) return void 0;
    return await response.json();
  } catch {
    return void 0;
  }
}
var [rider, observations, dashboard] = await Promise.all([
  fetchFreshRider(riderURL, void 0),
  json(base + "data/observations.json"),
  json(base + "data/dashboard.json")
]);
var result;
try {
  result = serviceHealth({ rider, observations, dashboard });
} catch {
  result = { checkedAt: (/* @__PURE__ */ new Date()).toISOString(), healthy: false, coreAvailable: false, status: "unhealthy", checks: [{ name: "published_schema", ok: false, state: "invalid" }] };
}
console.log(JSON.stringify(result, null, 2));
if (result.status === "degraded") console.log("::warning::The MTA alert source is older than 10 minutes despite a recent successful download; current alert status is unknown. Core transit evidence remains available.");
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = result.checks.map((c) => `| ${c.name} | ${c.ok ? "Available" : "UNAVAILABLE"} | ${c.sourceAgeSeconds ?? "unknown"} |`).join("\n");
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `
### Published service availability

Status: **${result.status}**. All services healthy: **${result.healthy}**. Core evidence available: **${result.coreAvailable}**.

| Check | Result | Source age (seconds) |
|---|---|---|
${rows}

Checks use source timestamps and selectable future forecasts, not commit/deployment time. The observation publication allowance is 20 minutes; live forecasts expire at 2 minutes. Alerts allow 10 minutes of source age and 2 minutes since download. Only an old upstream alert source with a recent successful download warns as degraded; download errors, expired downloads, missing or malformed alerts and any core failure fail the check. This checks payload usability, not browser rendering or physical punctuality.
`);
}
process.exitCode = result.status === "healthy" || result.status === "degraded" ? 0 : 1;
