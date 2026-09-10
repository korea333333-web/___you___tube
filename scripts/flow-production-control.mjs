import readline from 'node:readline';
import {writeFile} from 'node:fs/promises';
import { startFlowProductionSession } from './flow-production-session.mjs';
const flow=await startFlowProductionSession();
console.log(JSON.stringify({state:'READY',tools:flow.tools}));
console.log(JSON.stringify({tool:'flow_list_accounts',result:await flow.call('flow_list_accounts',{})}));
const lines=readline.createInterface({input:process.stdin,terminal:false});
let pending=Promise.resolve();
lines.on('line',line=>{
 pending=pending.then(async()=>{
  if(!line.trim())return;
  try{
   const command=JSON.parse(line);
   if(command.action==='close'){await flow.close();lines.close();process.exitCode=0;return;}
   const result=await flow.call(command.tool,command.arguments??{});
   if(command.tool==='flow_inspect_account' && !result.isError){
    const block=result.content.find(item=>item.type==='text');
    if(block){
     const value=JSON.parse(block.text);
     const fields=['url','signedIn','workspaceAvailable','pageKind','language','models','aspectRatiosByMedia','outputCountsByMedia','visibleModels','visibleAspectRatios','visibleDurations','availableUpscales','unavailableUpscales','upscaleOptions','screenshot'];
     const evidence={observedAt:new Date().toISOString(),...Object.fromEntries(fields.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]))};
     await writeFile(new URL('../validation/live-capabilities.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
    }
   }
   const audit= {tool:command.tool,arguments:command.arguments??{},result,receivedAt:new Date().toISOString()};
   await writeFile(new URL('../validation/production-call-'+Date.now()+'-'+command.tool+'.json',import.meta.url),JSON.stringify(audit,null,2)+'\n',{flag:'wx'});
   console.log(JSON.stringify({tool:command.tool,result}));
  }catch(error){console.log(JSON.stringify({error:String(error)}));}
 });
});
lines.on('close',()=>{void pending.finally(()=>flow.close());});
