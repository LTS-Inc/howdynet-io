// Vendor-chaos and downtime calculators on /plans#calculators.
function fmtMoney(n) {
  if (n >= 1000000) return "$" + (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return "$" + Math.round(n / 1000) + "K";
  return "$" + n.toLocaleString();
}
const $ = (id) => document.getElementById(id);
const val = (id) => parseInt($(id).value, 10);

function updateVendorCalc() {
  const v = val("vc-count"), h = val("vc-hours"), r = val("vc-rate");
  $("vc-count-val").textContent = String(v);
  $("vc-hours-val").textContent = h + " hrs";
  $("vc-rate-val").textContent = "$" + r + "/hr";
  // Each vendor adds about 1.5 hrs/month of coordination (calls, invoices, escalations).
  const overhead = v * 1.5;
  const annual = Math.round((h + overhead) * r * 12);
  const days = Math.round(annual / (r * 8));
  const overheadCost = Math.round(overhead * r * 12);
  $("vc-result").textContent = fmtMoney(annual);
  let msg;
  if (v <= 2) msg = days + " full work days lost a year. Even with " + v + " vendor" + (v === 1 ? "" : "s") + ", coordination adds up: each one averages 1.5 hrs a month in calls, invoices and follow-ups.";
  else if (v <= 5) msg = days + " full work days lost a year. " + v + " vendors means " + v + " invoices, " + v + " support queues and " + fmtMoney(overheadCost) + " in pure coordination overhead beyond your base hours.";
  else if (v <= 10) msg = days + " full work days. Managing " + v + " vendors is practically a part-time job: " + fmtMoney(overheadCost) + " a year just keeping them coordinated.";
  else msg = days + " full work days. " + v + " vendors is vendor chaos: " + fmtMoney(overheadCost) + " in coordination overhead a year.";
  $("vc-insight").textContent = msg;
}

function updateDowntimeCalc() {
  const base = val("dt-industry"), emp = val("dt-emp"), hrs = val("dt-hrs");
  $("dt-emp-val").textContent = String(emp);
  $("dt-hrs-val").textContent = hrs + " hrs";
  const perHour = base + emp * 35;
  const annual = perHour * hrs;
  $("dt-result").textContent = fmtMoney(annual);
  $("dt-per-hour").textContent = fmtMoney(perHour) + "/hr";
  const msg = annual < 5000
    ? "Proactive monitoring typically prevents issues before they become outages."
    : annual < 20000
      ? "24/7 monitoring pays for itself with one prevented outage."
      : "At this scale, downtime without proactive monitoring is a certainty.";
  $("dt-insight").textContent = "At " + fmtMoney(perHour) + "/hr, " + hrs + " outage hours cost " + fmtMoney(annual) + " a year. " + msg;
}

if ($("vc-count")) {
  ["vc-count", "vc-hours", "vc-rate"].forEach((id) => $(id).addEventListener("input", updateVendorCalc));
  ["dt-industry", "dt-emp", "dt-hrs"].forEach((id) => $(id).addEventListener("input", updateDowntimeCalc));
  updateVendorCalc();
  updateDowntimeCalc();
}
