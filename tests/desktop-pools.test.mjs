import test from "node:test";
import assert from "node:assert/strict";
import { sourceConfiguration, widgetSnapshot } from "../collector/desktop-preferences.mjs";
import { groupGrokSharedUsage } from "../collector/providers/grok.mjs";

test("desktop overrides are allowlisted and scoped to a selected source", () => {
  const settings = {sources: {deepseek: {mode:"on", values:{DEEPSEEK_API_KEY:"sample", PATH:"ignored"}}, claude:{mode:"off"}}};
  assert.deepEqual(sourceConfiguration("deepseek",settings,{PATH:"original"}).env,{DEEPSEEK_API_KEY:"sample",PATH:"original"});
  assert.equal(sourceConfiguration("claude",settings,{}).mode,"off");
  assert.deepEqual(sourceConfiguration("grok",settings,{}).env,{});
  assert.notEqual(sourceConfiguration("deepseek",settings,{}).revision,sourceConfiguration("deepseek",{},{}).revision);
});

test("widget exposes quota fields only and honors disabled, missing and expired windows", () => {
  const now=Date.parse("2030-01-01T00:00:00Z");
  const provider={id:"demo",name:"Demo",updatedAt:new Date(now).toISOString(),state:"ready",account:"private",windows:[{id:"weekly",usedPercent:17.22,resetsAt:"2030-01-02T00:00:00Z"}]};
  const snapshot={providers:[provider,{...provider,id:"empty",windows:[]},{...provider,id:"expired",windows:[{id:"weekly",usedPercent:100,resetsAt:"2029-12-31T00:00:00Z"}]}]};
  assert.deepEqual(widgetSnapshot(snapshot,false,now),{enabled:false,pools:[]});
  assert.deepEqual(widgetSnapshot(snapshot,true,now).pools,[{id:"demo",name:"Demo",remaining:83,reset:"2030-01-02T00:00:00Z",dayOnly:false,stale:false}]);
});

test("unified Grok keeps source readings but never absorbs the Cursor billing pool", () => {
  const base={state:"ready",sharedWeekStart:"2030-01-01T00:00:00Z",windows:[{id:"weekly",resetsAt:"2030-01-08T00:00:00Z"}]};
  const providers=[{...base,id:"grok"},{...base,id:"grok-bot",cursorAccount:"sample"},{...base,id:"cursor",cursorAccount:"sample"}];
  const grouped=groupGrokSharedUsage(providers,Date.parse("2030-01-05"));
  assert.deepEqual(grouped.map(p=>p.id),["grok","cursor"]);
  assert.deepEqual(grouped[0].readings.map(p=>p.id),["grok","grok-bot"]);
});
