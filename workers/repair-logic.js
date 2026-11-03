/** Decide what an hourly check may do. No secrets and no deploys. */

export function actionFor(text) {
  var line = String(text || "").toLowerCase();
  if (/config|secret|deploy|code change|wrangler/.test(line)) return "propose";
  if (/cache|ticker|price/.test(line)) return "clear-cache";
  if (/llm|chat|model/.test(line)) return "rotate-llm";
  if (/paper|stuck/.test(line)) return "restart-paper";
  if (/queue|job|webhook/.test(line)) return "requeue";
  return "degrade";
}

export function alertFor(streak) {
  return Number(streak) >= 3;
}
