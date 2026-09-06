// Explicitly opt-in only: may use provider quota. Does not create or modify a GitHub PR.
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
if(process.env.WR_NEXT_LIVE!=='1'){
 console.log('SKIP: live runtime/GitHub verification requires WR_NEXT_LIVE=1 and an explicitly selected runtime or PR.');
 process.exit(0);
}
const runtime=process.env.WR_NEXT_LIVE_RUNTIME,pr=process.env.WR_NEXT_LIVE_PR;
if(!runtime&&!pr)throw new Error('Select WR_NEXT_LIVE_RUNTIME=claude and/or WR_NEXT_LIVE_PR=owner/repo#number');
const {startLocal}=await import('../dist/src/server/local.js');
const {Client}=await import('../dist/src/cli/client.js');
const {launch}=await import('../dist/src/runtime/launcher.js');
const {syncPr}=await import('../dist/src/integrations/github.js');
const home=mkdtempSync(join(tmpdir(),'wr-next-live-'));const previous=process.env.WR_NEXT_HOME;process.env.WR_NEXT_HOME=home;
const server=await startLocal({database:join(home,'live.sqlite')});
const cfg={server:server.url,workspace:'local',device:'live-test',token:server.secret};
try{
 if(runtime){
  if(runtime!=='claude')throw new Error('Only the Claude adapter has an opt-in live contract');
  if(spawnSync('claude',['--version'],{stdio:'ignore'}).status!==0)throw new Error('Claude CLI is not installed');
  const client=new Client(cfg),work=await client.command({type:'work.create',title:'Explicit live adapter smoke test'});
  const argv=process.env.WR_NEXT_LIVE_ARGV_JSON?JSON.parse(process.env.WR_NEXT_LIVE_ARGV_JSON):['claude','-p','Use Bash to run wr-next status, then wr-next done --summary "live adapter smoke test". Do not change files or contact GitHub.'];
  if(!Array.isArray(argv)||!argv.length||!argv.every(x=>typeof x==='string'))throw new Error('ARGV must be a string array');
  const result=await launch(cfg,{work:work.result.id,runtime:'claude',argv,cwd:home});
  if(result.exitCode!==0||server.workspace.store.snapshot().work[work.result.id].state!=='done')throw new Error('Live adapter did not submit and accept its assigned result');
  console.log('PASS: real Claude invocation and result submission');
 }
 if(pr){
  const match=pr.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);if(!match)throw new Error('Use owner/repo#number');
  if(spawnSync('gh',['auth','status'],{stdio:'ignore',env:{...process.env,GH_PROMPT_DISABLED:'1'}}).status!==0)throw new Error('GitHub CLI authentication is required');
  await syncPr(cfg,match[1],Number(match[2]));console.log('PASS: real GitHub read-only PR synchronization');
 }
}finally{await server.close();if(previous===undefined)delete process.env.WR_NEXT_HOME;else process.env.WR_NEXT_HOME=previous;rmSync(home,{recursive:true,force:true});}
