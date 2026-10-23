import { DatabaseSync } from "node:sqlite";
import { Ledger } from "../src/ledger/db.ts";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceAdapter } from "../src/adapters/types.ts";
import { ConfigSchema, type Config } from "../src/config.ts";
import { differences } from "../src/run/differences.ts";
import { caseIds, loadReadTruth, normalizeTruthInputs, notFromOldCode, verifyTruthOnOld } from "../src/run/legacy-env.ts";
import { canonicalData, compareRuns, dataChanges, fieldValue, plainValue, runSteps, type Step } from "../src/run/parity-check.ts";
import { contractDiffs, runContracts, type ParityContract } from "../src/run/parity-contracts.ts";
import { isExactJsonNumber, parseExactJson } from "../src/run/exact-json.ts";
import { dumpData } from "../src/run/parity.ts";

let root: string, config: Config;
beforeEach(() => {
 root=mkdtempSync(join(tmpdir(),"br-exact-json-"));
 config=ConfigSchema.parse({source:{path:root,stack:"php"},target:{path:root,stacks:["nestjs"]},models:{}});
});
afterEach(() => rmSync(root,{recursive:true,force:true}));
const older='{"id":9007199254740992,"amount":0.1}';
const newer='{"id":9007199254740993,"amount":0.10000000000000001}';
const command=(text: string)=>({cmd:process.execPath,args:["-e",`process.stdout.write(${JSON.stringify(text)})`]});

describe("exact numbers through parity boundaries",()=>{
 it("detects changed large identifiers and precise amounts in real HTTP JSON responses",async()=>{
  const server=createServer((q,s)=>{s.setHeader("content-type","application/json");s.end(q.url==="/old"?older:newer);});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
   const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
   const step: Step={id:"values",route:"GET /values",compare:"data",method:"GET",path:"/old",target:{path:"/new"}};
   const old=await runSteps([step],{side:"legacy",base:()=>base,strict:true});
   const neu=await runSteps([step],{side:"target",base:()=>base,strict:true});
   const result=compareRuns([step],old,old,neu,false,true);
   expect(result.diffs.map(d=>d.path)).toEqual(["body.id","body.amount"]);
   expect(JSON.stringify(neu[0]!.body)).toContain("9007199254740993");
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
 });
 it("preserves both changed numeric observations from executable checks",async()=>{
  const check: ParityContract={id:"numbers",kind:"data",covers:[],why:"exact business values",command:command(older),inputs:[import.meta.filename]};
  const context={root,config,appDir:root,urls:{}};
  const old=await runContracts([check],{...context,side:"legacy"});
  const neu=await runContracts([{...check,command:command(newer)}],{...context,side:"target"});
  expect(contractDiffs([check],[],old,old,neu).map(d=>d.path)).toEqual(["id","amount"]);
 });
 it("preserves exact dump values through normalization, row sorting and removed-row evidence",async()=>{
  const recipe=(text:string)=>({dir:".",ready:"http://127.0.0.1:1/",start:command(""),dump:command('{"orders":['+text+']}')});
  const old=canonicalData(plainValue(await dumpData(recipe(older),root),[]) as Record<string,unknown[]>);
  const neu=canonicalData(plainValue(await dumpData(recipe(newer),root),[]) as Record<string,unknown[]>);
  expect(differences(old,neu).map(d=>d.path)).toEqual(["orders[0].amount","orders[0].id"]);
  const delta=dataChanges(neu,old);
  expect(JSON.stringify(delta.orders!.removed)).toContain("9007199254740993");
  expect(JSON.stringify(delta.orders!.removed)).toContain("10000000000000001");
 });
 it("rejects large-number nondeterminism in two actual legacy truth runs",async()=>{
  const dir=join(root,"truth");mkdirSync(dir);
  writeFileSync(join(dir,"cases.cjs"),`const fs=require('node:fs');const p=${JSON.stringify(join(root,"count"))};const n=fs.existsSync(p)?'9007199254740993':'9007199254740992';fs.writeFileSync(p,'1');process.stdout.write('[{"symbol":"value","inputs":[],"expected":'+n+'}]');`);
  const source={truth:{scriptName:"cases.cjs",run:(_root:string,path:string)=>({cmd:process.execPath,args:[path]})}} as SourceAdapter;
  const result=await verifyTruthOnOld(dir,config,source);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("expected values differ between two runs");
 });
 it("keeps exact read-truth inputs, outputs and distinct stable case ids",()=>{
  const dir=join(root,"truth");mkdirSync(dir);
  writeFileSync(join(dir,"cases.json"),'[{"symbol":"value","inputs":[9007199254740992],"expected":9007199254740992},{"symbol":"value","inputs":[9007199254740993],"expected":9007199254740993}]');
  const result=loadReadTruth(dir);expect(result.ok).toBe(true);
  const ids=caseIds("u",[{id:"u#8",symbol_id:"value",inputs:"[9007199254740992]"},{id:"u#9",symbol_id:"value",inputs:"[9007199254740993]"}],result.cases);
  expect(ids).toEqual(["u#8","u#9"]);
  expect(JSON.stringify(result.cases[1])).toContain("9007199254740993");
 });
});


describe("exact JSON values and evidence", () => {
 it("migrates old ledgers without labeling their historical cases as exact-number proof",()=>{
  const file=join(root,"ledger.sqlite");let ledger=new Ledger(file);
  ledger.createUnit({id:"u",tier:"T0",symbolIds:[]});
  ledger.db.prepare("INSERT INTO truth_cases(id,unit_id,symbol_id,inputs,expected,verified_on_old,ported_test_path,created_at) VALUES ('u#7','u','s','[9007199254740993]','9007199254740993',1,'test.php','t')").run();
  ledger.close();
  const old=new DatabaseSync(file);old.exec("ALTER TABLE truth_cases DROP COLUMN numeric_version");old.close();
  ledger=new Ledger(file);
  try {expect(ledger.db.prepare("SELECT id,inputs,expected,verified_on_old,numeric_version,ported_test_path FROM truth_cases").get()).toEqual({id:"u#7",inputs:"[9007199254740993]",expected:"9007199254740993",verified_on_old:1,numeric_version:0,ported_test_path:"test.php"});}
  finally {ledger.close();}
 });
 it.each(["9007199254740993", "18446744073709551615", "-9007199254740993", "0.10000000000000001", "1e400", "1e-400", "-0", "1e1000000000000000000000000"])("round-trips %s without losing its numeric value", literal => {
  const first=parseExactJson('{"nested":['+literal+']}');
  const serialized=JSON.stringify(first);
  expect(differences(first,parseExactJson(serialized))).toEqual([]);
  expect(serialized.length).toBeLessThan(100);
  expect(serialized).not.toContain('"literal"');
 });
 it("compares mathematically equal notation without equating numbers to strings or ordinary objects",()=>{
  for(const [a,b] of [["9007199254740993","9.007199254740993e15"],["0.10000000000000001","10000000000000001e-17"],["1000","1e3"]])
   expect(differences(parseExactJson(a!),parseExactJson(b!))).toEqual([]);
  const number=parseExactJson("9007199254740993");
  expect(differences(number,"9007199254740993")).toHaveLength(1);
  expect(differences(number,{literal:"9007199254740993"})).toHaveLength(1);
  expect(differences(parseExactJson("-0"),0)).toHaveLength(1);
  expect(differences(parseExactJson("1e400"),null)).toHaveLength(1);
 });
 it("rejects a primitive numeric check result rather than treating the exact-number holder as an observation object",async()=>{
  const check:ParityContract={id:"invalid",kind:"data",covers:[],why:"must be observations",command:command("9007199254740993"),inputs:[import.meta.filename]};
  const [result]=await runContracts([check],{root,config,appDir:root,urls:{},side:"legacy"});
  expect(result!.error).toContain("non-empty JSON object");
 });
 it("preserves exact saved identifiers and request bodies through real HTTP steps",async()=>{
  const received:string[]=[];
  const server=createServer(async(q,s)=>{
   s.setHeader("content-type","application/json");
   if(q.method==="POST") {let body="";for await(const chunk of q)body+=chunk;received.push(body);s.end(body);}
   else if(q.url!.startsWith("/follow/")){received.push(q.url!);s.end('{}');}
   else s.end('{"id":9007199254740993}');
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
   const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
   const steps:Step[]=[{id:"get",route:"GET /id",compare:"data",method:"GET",path:"/id",save:{id:"does-not-match"}},
    {id:"follow",route:"GET /follow/{id}",compare:"data",method:"GET",path:"/follow/{{id}}"},
    {id:"post",route:"POST /id",compare:"data",method:"POST",path:"/id",body:{id:"{{id}}",numeric:parseExactJson("9007199254740993")}}];
   const result=await runSteps(steps,{side:"legacy",base:()=>base,strict:true});
   expect(result.every(r=>!r.error)).toBe(true);
   expect(received[0]).toBe("/follow/9007199254740993");
   expect(received[1]).toBe('{"id":"9007199254740993","numeric":9007199254740993}');
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 it("keeps exact literals subject to the typed-in expected-value guard",()=>{
  const expected=parseExactJson("9007199254740993");
  expect(isExactJsonNumber(expected)).toBe(true);
  expect(notFromOldCode("require 'app.php'; echo 9007199254740993;",[{symbol:"s",inputs:[],expected}],["app.php"])).toContain("written into the script");
  expect(notFromOldCode("require 'app.php'; echo 1e-400;",[{symbol:"s",inputs:[],expected:parseExactJson("10e-401")}],["app.php"])).toContain("written into the script");
  expect(notFromOldCode("require 'app.php'; echo 90071992547409930;",[{symbol:"s",inputs:parseExactJson("[9.007199254740993e16]"),expected:parseExactJson("90071992547409930")}],["app.php"])).toBeUndefined();
 });
 it("does not expose a number holder as JSON fields or named argument objects",()=>{
  expect(fieldValue("9007199254740993","literal")).toBeUndefined();
  writeFileSync(join(root,"import.json"),JSON.stringify({inputKeys:{s:["literal"]}}));
  expect(()=>normalizeTruthInputs(root,[{symbol:"s",inputs:parseExactJson("9007199254740993"),expected:null}])).toThrow("Inputs do not match");
 });
 it("matches stable case ids across equivalent large-number input notation",()=>{
  expect(caseIds("u",[{id:"u#7",symbol_id:"s",inputs:"[90071992547409930]"}],[{symbol:"s",inputs:parseExactJson("[9.007199254740993e16]"),expected:null}])).toEqual(["u#7"]);
 });
});
