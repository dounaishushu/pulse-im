// Local development only: retained Web pages and a same-origin Go reverse proxy.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.PULSE_WEB_PORT||18081);
const backend=new URL(process.env.PULSE_DEV_BACKEND||'http://127.0.0.1:18080');
if(backend.protocol!=='http:'||!['127.0.0.1','localhost'].includes(backend.hostname)||backend.username||backend.password)throw Error('Development proxy requires a loopback HTTP backend');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json','.woff2':'font/woff2'};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.startsWith('/api/v2/')){
    const proxy=http.request(new URL(req.url,backend),{method:req.method,headers:{...req.headers,host:backend.host}},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
    proxy.on('error',()=>{res.writeHead(502);res.end('Backend unavailable');});req.on('aborted',()=>proxy.destroy());req.pipe(proxy);return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
  const pc=url.pathname.startsWith('/pc/'),base=path.join(root,pc?'pc/web':'web');
  let file;try{file=path.resolve(base,'.'+decodeURIComponent(pc?url.pathname.slice(3):url.pathname));}catch{res.writeHead(400);res.end();return;}
  if(url.pathname.endsWith('/'))file=path.join(file,'index.html');
  const relative=path.relative(base,file);
  if(relative.startsWith('..')||path.isAbsolute(relative)){res.writeHead(403);res.end();return;}
  fs.stat(file,(error,stat)=>{if(error||!stat.isFile()){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});if(req.method==='HEAD')res.end();else fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);});
});
server.on('upgrade',(req,socket,head)=>{
  if(!req.url.startsWith('/api/v2/realtime?')){socket.destroy();return;}
  const proxy=http.request(new URL(req.url,backend),{headers:{...req.headers,host:backend.host}});
  proxy.on('upgrade',(res,upstream,rest)=>{socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(res.headers).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');if(rest.length)socket.write(rest);if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());});
  proxy.on('response',res=>{socket.end('HTTP/1.1 '+res.statusCode+' Rejected\r\nConnection: close\r\n\r\n');res.resume();});proxy.on('error',()=>socket.destroy());proxy.end();
});
server.listen(port,'127.0.0.1',()=>console.log('Web development server: http://127.0.0.1:'+port));
