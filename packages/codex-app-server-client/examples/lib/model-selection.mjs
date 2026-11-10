const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

// Mirror the official example's advertised-upgrade/lexical heuristic, not a quality ranking.
export function selectModel(models) {
  const visible = models.filter((model) => !model.hidden);
  const names = new Set(visible.flatMap((model) => [model.id, model.model]));
  const candidates = visible.filter((model) => !model.upgrade || !names.has(model.upgrade));
  candidates.sort((a, b) => a.model < b.model ? -1 : a.model > b.model ? 1
    : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const model = candidates.at(-1);
  if (!model) throw new Error("No top-level visible model advertised");
  const efforts = model.supportedReasoningEfforts.map((option) => option.reasoningEffort);
  if (!efforts.length || efforts.some((effort) => !effortOrder.includes(effort))) {
    throw new Error("Missing or unknown advertised reasoning effort");
  }
  efforts.sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b));
  return { model, effort: efforts.at(-1) };
}

export async function listModels(client) {
  const models = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await client.modelList({ includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) });
    models.push(...page.data);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("Repeated model-list cursor");
    if (cursor) cursors.add(cursor);
    if (cursors.size > 100) throw new Error("Model-list pagination exceeded example limit");
  } while (cursor);
  return models;
}
