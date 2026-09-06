// Uses the real local workerd runtime, not the Bun SQLite contract harness.
// May download the pinned Wrangler when it is not already cached. Never deploys.
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac,randomUUID} from 'node:crypto';
const state=mkdtempSync(join(tmpdir(),'wr-next-workerd-'));
const port=Number(process.env.WR_NEXT_SMOKE_PORT??48739),secret='synthetic-local-smoke-secret-not-a-production-key';
const payload=Buffer.from(JSON.stringify({id:'smoke-user',device:'smoke-device',role:'operator',workspace:'smoke',expires:Math.floor(Date.now()/1000)+300})).toString('base64url');
const token=`wn1.${payload}.${createHmac('sha256',secret).update(payload).digest('base64url')}`;
const child=spawn('bunx',['wrangler@4.123.0','dev','--local','--config','test/fixtures/wrangler-smoke.jsonc','--port',String(port),'--persist-to',state],{detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
let logs='',spawnError=null,closed=false;
const ended=new Promise(resolve=>child.once('close',()=>{closed=true;resolve();}));
function terminate(signal){try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch(error){if(error.code!=='ESRCH')throw error;}}
child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);child.on('error',e=>spawnError=e);
const headers={authorization:`Bearer ${token}`,'x-wr-next-workspace':'smoke','content-type':'application/json'};
try{
 let ready=false;for(let i=0;i<120;i++){
  if(spawnError)throw spawnError;if(child.exitCode!==null)throw new Error(`Wrangler exited: ${logs}`);
  try{const r=await fetch(`http://127.0.0.1:${port}/v1/status`,{headers,signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,1000));
 }
 if(!ready)throw new Error(`workerd did not become ready: ${logs}`);
 const response=await fetch(`http://127.0.0.1:${port}/v1/commands`,{method:'POST',headers,body:JSON.stringify({schemaVersion:1,operationId:randomUUID(),command:{type:'work.create',title:'Real workerd smoke'}})});
 const result=await response.json();if(!response.ok||result.result?.key!=='W1')throw new Error(JSON.stringify(result));
 const status=await (await fetch(`http://127.0.0.1:${port}/v1/status`,{headers})).json();if(status.items.length!==1)throw new Error('Durable Object write was not readable');
 console.log('PASS: real workerd / SQLite Durable Object / capability gateway');
}finally{
 if(!closed){
  terminate('SIGTERM');
  let timer;await Promise.race([ended,new Promise(resolve=>{timer=setTimeout(resolve,3000);})]);clearTimeout(timer);
  if(!closed){terminate('SIGKILL');let forceTimer;await Promise.race([ended,new Promise(resolve=>{forceTimer=setTimeout(resolve,1000);})]);clearTimeout(forceTimer);}
 }
 rmSync(state,{recursive:true,force:true});
}
