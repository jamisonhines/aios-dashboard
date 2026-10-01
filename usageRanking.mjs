// Pure export-anchored ranking shared by the plugin and offline palette search.
// Provider and bucket normalization are supplied by the canonical model helpers.
export function rankUsageModels(days, providerFor, totalTokens) {
  const dates=days.map(day=>day.date).filter(date=>/^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
  const recentEnd=dates.at(-1)||null;
  const recentStart=recentEnd ? new Date(Date.parse(`${recentEnd}T00:00:00Z`)-6*86400000).toISOString().slice(0,10) : null;
  const models=new Map();
  for(const day of days) for(const [model,bucket] of Object.entries(day.models)) {
    const row=models.get(model)||{model,provider:providerFor(model),recentTokens:0,wholeTokens:0};
    const tokens=totalTokens(bucket);
    row.wholeTokens+=tokens;
    if(recentStart && day.date>=recentStart && day.date<=recentEnd) row.recentTokens+=tokens;
    models.set(model,row);
  }
  const byProvider={};
  for(const row of models.values()) (byProvider[row.provider] ||= []).push(row);
  for(const rows of Object.values(byProvider)) {
    const recentTotal=rows.reduce((sum,row)=>sum+row.recentTokens,0);
    const wholeTotal=rows.reduce((sum,row)=>sum+row.wholeTokens,0);
    for(const row of rows) {
      row.recentShare=recentTotal ? row.recentTokens/recentTotal : 0;
      row.wholeShare=wholeTotal ? row.wholeTokens/wholeTotal : 0;
    }
    rows.sort((a,b)=>b.recentShare-a.recentShare || b.wholeShare-a.wholeShare || a.model.localeCompare(b.model));
  }
  return {recentStart,recentEnd,byProvider};
}
