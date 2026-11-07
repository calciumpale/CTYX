import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';

const run=promisify(execFile);
const launcher=fileURLToPath(new URL('../tools/douyin-bridge/macos/Launcher.m',import.meta.url));

test('native proxy policy preserves bypasses and rejects unsupported or credential-bearing proxies',{skip:process.platform!=='darwin'},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'douyin-proxy-policy-'));
 try{
  const source=`#define main launcher_original_main
#import ${JSON.stringify(launcher)}
#undef main
#import <assert.h>
int main(void) { @autoreleasepool {
 NSURL *site=[NSURL URLWithString:@"https://workbench.example.test"];
 NSString *error=nil;
 NSDictionary *none=ProxyEnvironmentForURL(@{},site,&error);
 assert(none && !error && !none[@"HTTP_PROXY"] && !none[@"HTTPS_PROXY"]);
 assert([none[@"NO_PROXY"] containsString:@"localhost"] && [none[@"NO_PROXY"] containsString:@"127.0.0.1"] && [none[@"NO_PROXY"] containsString:@"::1"]);
 NSMutableDictionary *settings=[@{@"HTTPEnable":@1,@"HTTPProxy":@"127.0.0.1",@"HTTPPort":@7890,@"HTTPSEnable":@1,@"HTTPSProxy":@"127.0.0.1",@"HTTPSPort":@7890,@"SOCKSEnable":@1,@"SOCKSProxy":@"127.0.0.1",@"SOCKSPort":@7890} mutableCopy];
 NSDictionary *active=ProxyEnvironmentForURL(settings,site,&error);
 assert(active && !error);
 assert([active[@"HTTP_PROXY"] isEqualToString:@"http://127.0.0.1:7890"]);
 assert([active[@"HTTPS_PROXY"] isEqualToString:@"http://127.0.0.1:7890"]);
 settings[@"ExceptionsList"]=@[@"*.example.test"];
 NSDictionary *bypass=ProxyEnvironmentForURL(settings,site,&error);
 assert(bypass && !bypass[@"HTTPS_PROXY"] && !bypass[@"HTTP_PROXY"]);
 [settings removeObjectForKey:@"ExceptionsList"];
 settings[@"HTTPSEnable"]=@0;settings[@"SOCKSEnable"]=@0;
 NSDictionary *httpOnly=ProxyEnvironmentForURL(settings,site,&error);
 assert(httpOnly && !httpOnly[@"HTTP_PROXY"] && !httpOnly[@"HTTPS_PROXY"]);
 settings[@"HTTPSEnable"]=@1;
 for (NSString *key in @[@"ProxyAutoConfigEnable",@"ProxyAutoDiscoveryEnable",@"HTTPSProxyAuthenticated"]) {
  settings[key]=@1;error=nil;assert(!ProxyEnvironmentForURL(settings,site,&error));assert(error.length);[settings removeObjectForKey:key];
 }
 settings[@"HTTPSUser"]=@"private-user";error=nil;assert(!ProxyEnvironmentForURL(settings,site,&error));assert(error.length && ![error containsString:@"private-user"]);[settings removeObjectForKey:@"HTTPSUser"];
 settings[@"HTTPSProxy"]=@"user:private-password@proxy.example.test";error=nil;assert(!ProxyEnvironmentForURL(settings,site,&error));assert(error.length && ![error containsString:@"private-password"]);
 settings[@"HTTPSProxy"]=@"127.0.0.1";settings[@"HTTPSEnable"]=@0;settings[@"HTTPEnable"]=@0;settings[@"SOCKSEnable"]=@1;
 error=nil;assert(!ProxyEnvironmentForURL(settings,site,&error));assert(error.length);
 settings[@"HTTPSEnable"]=@1;settings[@"SOCKSEnable"]=@0;settings[@"HTTPSProxy"]=@"::1";error=nil;
 NSDictionary *ipv6=ProxyEnvironmentForURL(settings,site,&error);assert(ipv6 && [ipv6[@"HTTPS_PROXY"] isEqualToString:@"http://[::1]:7890"]);
 puts("native proxy policy passed");
 } return 0; }`;
  const input=join(directory,'ProxyPolicy.m'),binary=join(directory,'proxy-policy');await writeFile(input,source);
  await run('/usr/bin/clang',['-fobjc-arc','-O2','-Wall','-Wextra','-mmacosx-version-min=12.0','-framework','Cocoa','-framework','WebKit','-framework','UniformTypeIdentifiers','-framework','CFNetwork',input,'-o',binary]);
  assert.match((await run(binary,[])).stdout,/native proxy policy passed/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('Node environment proxy handles remote requests while loopback stays direct',{skip:!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')},async()=>{
 let proxied=0,direct=0;
 const proxy=createServer((_request,response)=>{proxied++;response.end('proxy');});
 const tunnels=new Set();
 proxy.on('connect',(_request,socket,head)=>{
  proxied++;tunnels.add(socket);socket.once('close',()=>tunnels.delete(socket));
  const respond=()=>socket.end('HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 5\r\n\r\nproxy');
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if(head.length)respond();else socket.once('data',respond);
 });
 const local=createServer((_request,response)=>{direct++;response.end('local');});
 await Promise.all([new Promise(done=>proxy.listen(0,'127.0.0.1',done)),new Promise(done=>local.listen(0,'::',done))]);
 try{
  const script=`const remote=await fetch('http://fixture.invalid/',{signal:AbortSignal.timeout(3000)}); if(await remote.text()!=='proxy')throw new Error('proxy not used'); for(const host of ['localhost','127.0.0.1','[::1]']){const r=await fetch('http://'+host+':${local.address().port}/',{signal:AbortSignal.timeout(3000)});if(await r.text()!=='local')throw new Error('loopback was proxied');}`;
  await run(process.execPath,['--use-env-proxy','--input-type=module','-e',script],{timeout:8000,env:{PATH:'/usr/bin:/bin',HTTP_PROXY:`http://127.0.0.1:${proxy.address().port}`,HTTPS_PROXY:`http://127.0.0.1:${proxy.address().port}`,NO_PROXY:'localhost,127.0.0.1,::1,[::1]'}});
  assert.equal(proxied,1);assert.equal(direct,3);
 }finally{for(const socket of tunnels)socket.destroy();proxy.closeAllConnections();local.closeAllConnections();await Promise.all([new Promise(done=>proxy.close(done)),new Promise(done=>local.close(done))]);}
});
