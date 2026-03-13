import tls from'tls';import WebSocket from'ws';import http2 from'http2';
const config={discordToken:"MTM2MDczNjU3MjA5MzIzNTI5MA.GD5gcO.0xN3QAZAFRNO2OmkhswMXMTDkpBf-w_Vwy94w4",guildId:"1411743133766516748",password:"1fatmanur211"},
headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0','Authorization':config.discordToken,
'Content-Type':'application/json','X-Super-Properties':'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRmlyZWZveCIsImRldmljZSI6IiIsInN5c3RlbV9sb2NhbGUiOiJ0ci1UUiIsImJyb3dzZXJfdXNlcl9hZ2VudCI6Ik1vemlsbGEvNS4wIChXaW5kb3dzIE5UIDEwLjA7IFdpbjY0OyB4NjQ7IHJ2OjEzMy4wKSBHZWNrby8yMDEwMDEwMSBGaXJlZm94LzEzMy4wIiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTMzLjAiLCJvc192ZXJzaW9uIjoiMTAiLCJyZWZlcnJlciI6Imh0dHBzOi8vd3d3Lmdvb2dsZS5jb20vIiwicmVmZXJyaW5nX2RvbWFpbiI6Ind3dy5nb29nbGUuY29tIiwic2VhcmNoX2VuZ2luZSI6Imdvb2dsZSIsInJlZmVycmVyX2N1cnJlbnQiOiIiLCJyZWZlcnJpbmdfZG9tYWluX2N1cnJlbnQiOiIiLCJyZWxlYXNlX2NoYW5uZWwiOiJjYW5hcnkiLCJjbGllbnRfYnVpbGRfbnVtYmVyIjozNTYxNDAsImNsaWVudF9ldmVudF9zb3VyY2UiOm51bGwsImhhc19jbGllbnRfbW9kcyI6ZmFsc2V9'};
let mfaToken=null,savedTicket=null,guilds={},lastRequestTime=0,retryCount=0,isUpdating=false,vanityQueue=[];

const sessionManager=new class{constructor(){this.session=null;this.isConnecting=false;this.pendingRequests=[];this.createSession();}
createSession(){if(this.isConnecting)return;this.isConnecting=true;if(this.session)this.session.destroy();
this.session=http2.connect("https://canary.discord.com",{settings:{enablePush:false},secureContext:tls.createSecureContext(
{ciphers:'AES256-SHA:RC4-SHA:DES-CBC3-SHA',rejectUnauthorized:true})});
this.session.on('error',()=>{this.isConnecting=false;setTimeout(()=>this.createSession(),3000);});
this.session.on('connect',()=>{this.isConnecting=false;while(this.pendingRequests.length>0){const{resolve,reject,options,body}=this.pendingRequests.shift();
this._makeRequest(options,body).then(resolve).catch(reject);}});
this.session.on('close',()=>{this.isConnecting=false;setTimeout(()=>this.createSession(),3000);});}
_makeRequest(options,body){return new Promise((r,j)=>{const s=this.session.request(options),c=[];
s.on("data",chunk=>c.push(chunk));s.on("end",()=>{try{r(Buffer.concat(c).toString());}catch(e){j(e);}});
s.on("error",j);body?s.end(body):s.end();});}
async request(m,p,h={},b=null){const now=Date.now();const wait=Math.max(0,lastRequestTime+10-now);
if(wait>0)await new Promise(r=>setTimeout(r,wait));lastRequestTime=Date.now();
if(!this.session||this.session.destroyed){if(this.isConnecting){return new Promise((r,j)=>{this.pendingRequests.push({
resolve:r,reject:j,options:{...headers,...h,":method":m,":path":p,":authority":"canary.discord.com",":scheme":"https"},body:b});});}
await new Promise(r=>setTimeout(r,100));this.createSession();}try{return await this._makeRequest(
{...headers,...h,":method":m,":path":p,":authority":"canary.discord.com",":scheme":"https"},b);}catch(e){
if(retryCount<3){retryCount++;await new Promise(r=>setTimeout(r,100));const result=await this.request(m,p,h,b);
retryCount=0;return result;}throw e;}}};

async function refreshMfaToken(){try{if(mfaToken&&Date.now()-lastRequestTime<60000)return true;
const r=await sessionManager.request("PATCH",`/api/v7/guilds/${config.guildId}/vanity-url`);const d=JSON.parse(r);
if(d.code===60003){savedTicket=d.mfa.ticket;const mr=await sessionManager.request("POST","/api/v9/mfa/finish",
{"Content-Type":"application/json"},JSON.stringify({ticket:savedTicket,mfa_type:"password",data:config.password}));
const md=JSON.parse(mr);if(md.token){mfaToken=md.token;console.log("MFA token yenilendi");return true;}return false;}
return d.code===200;}catch{return false;}}

async function vanityUpdate(find){if(isUpdating){vanityQueue.push(find);return;}try{isUpdating=true;
const resp=await sessionManager.request("PATCH",`/api/v10/guilds/${config.guildId}/vanity-url`,{"X-Discord-MFA-Authorization":mfaToken||'',
"Content-Type":"application/json","X-Context-Properties":"eyJsb2NhdGlvbiI6IlNlcnZlciBTZXR0aW5ncyJ9",
"Origin":"https://discord.com","Accept":"*/*"},JSON.stringify({code:find}));try{const result=JSON.parse(resp);
if(result.code===10057)console.log(JSON.stringify({code:find,uses:0}));
else console.log(JSON.stringify({code:find,uses:0}));}catch{}
}catch(e){}finally{isUpdating=false;if(vanityQueue.length>0){const nextVanity=vanityQueue.shift();setTimeout(()=>vanityUpdate(nextVanity),5);}}}

function processVanityChange(guildId,newVanity){const currentVanity=guilds[guildId];
if(currentVanity&&currentVanity!==newVanity){vanityUpdate(currentVanity);return true;}return false;}

function connectWS(){const ws=new WebSocket("wss://gateway-us-east1-b.discord.gg",{headers:{'User-Agent':headers['User-Agent'],
'Origin':'https://canary.discord.com'},handshakeTimeout:10000});let hi,ls=null;
ws.onclose=()=>{clearInterval(hi);setTimeout(connectWS,500);};ws.onerror=()=>ws.close();
ws.onmessage=async(m)=>{try{const p=JSON.parse(m.data);if(p.s)ls=p.s;switch(p.op){
case 10:clearInterval(hi);ws.send(JSON.stringify({op:2,d:{token:config.discordToken,intents:1,
properties:{os:"Windows",browser:"Firefox",device:"mobile"}}}));
hi=setInterval(()=>{ws.readyState===WebSocket.OPEN?ws.send(JSON.stringify({op:1,d:ls})):clearInterval(hi);},p.d.heartbeat_interval);break;
case 0:const{t:t,d:e}=p;if(t==="GUILD_UPDATE")processVanityChange(e.guild_id,e.vanity_url_code);
else if(t==="READY"){e.guilds.forEach(g=>{if(g.vanity_url_code)guilds[g.id]=g.vanity_url_code;});
console.log("Hazır sunucular:",Object.keys(guilds).length);}break;case 7:ws.close();break;}}catch{}};}

(async()=>{try{console.log("Başlatılıyo");if(!mfaToken)await refreshMfaToken();connectWS();
setInterval(refreshMfaToken,30*1000);setInterval(()=>sessionManager.request("HEAD","/"),300000);}
catch(e){console.error("Hata:",e.message);setTimeout(arguments.callee,500);}})();

process.on('uncaughtException',(e)=>{console.error("Yakalanmamış hata:",e.message);})
.on('unhandledRejection',(e)=>{console.error("İşlenmeyen reddetme:",e.message);});
