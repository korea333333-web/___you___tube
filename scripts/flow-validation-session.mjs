import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const fork=path.join(root,"tools","google-flow-mcp");
const require=createRequire(path.join(fork,"package.json"));
const {Client}=await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
const {StdioClientTransport}=await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);
const allowed=new Set(["flow_help","flow_list_accounts","flow_begin_account_connection","flow_complete_account_connection","flow_inspect_account","flow_validate_generation_settings","flow_login_bridge_status"]);

// This is a client of the dedicated Flow MCP server, not browser automation.
// The validation client cannot call generation, upscale or download tools.
export async function startFlowValidationSession() {
  const transport=new StdioClientTransport({
    command:"node", args:[path.join(fork,"dist","index.js")], cwd:fork,
    env:{
      FLOW_MCP_BROWSER_EXECUTABLE:"C:\\Program Files\\Naver\\Naver Whale\\Application\\4.39.410.14\\whale.exe",
      FLOW_MCP_HEADLESS:"0",
      FLOW_MCP_DATA_DIR:"C:\\Users\\kikuke\\AppData\\Local\\flow-mcp-youtube-validation",
    },stderr:"pipe",
  });
  const client=new Client({name:"youtube-flow-validation",version:"1.0.0"});
  await client.connect(transport);
  const listed=await client.listTools();
  const available=new Set(listed.tools.map(tool=>tool.name));
  return {
    tools:[...available],
    call:async(name,args={})=>{
      if(!allowed.has(name)||!available.has(name)) throw Error("This validation session does not allow "+name);
      return client.callTool({name,arguments:args},undefined,{timeout:name === "flow_complete_account_connection" ? (Number(args.waitForAccountSelectionSeconds ?? 300) + 60) * 1000 : 360000});
    },
    close:()=>client.close(),
  };
}
