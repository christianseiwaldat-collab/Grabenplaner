"""Explicit build-only official download; never imported or used by the app."""
from pathlib import Path
import argparse,hashlib,importlib.util,json,os,time,urllib.parse,urllib.request
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('asset_materializer',HERE/'materialize_import_verifier_assets.py');M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
OFFICIAL={'github.com','release-assets.githubusercontent.com','repo.maven.apache.org'}
class OfficialRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  parsed=urllib.parse.urlsplit(newurl);M.need(parsed.scheme=='https'and parsed.hostname in OFFICIAL,'OFFICIAL_REDIRECT_REQUIRED')
  return super().redirect_request(req,fp,code,msg,headers,newurl)
def fetch(source_root,cache_root):
 source=M.root(source_root);cache=M.root(cache_root);M.need(not cache.is_relative_to(source),'BUILD_CACHE_OUTSIDE_SOURCE_REQUIRED')
 if os.name=='nt':M.need(cache.drive.upper()=='C:','BUILD_CACHE_INTERNAL_C_REQUIRED')
 lock,_=M.read_json(source,M.LOCK);M.validate_lock(lock);results=[]
 for item in [lock['archive'],*lock['jars']]:
  url=urllib.parse.urlsplit(item['url']);M.need(url.scheme=='https'and url.hostname in OFFICIAL and not url.username and not url.password and not url.fragment,'OFFICIAL_HTTPS_REQUIRED')
  target=M.inside(cache,item['cacheObject']);target.parent.mkdir(parents=True,exist_ok=True)
  if target.exists():
   stream,before=M.opened(cache,item['cacheObject'],item)
   with stream:M.consume(stream,None,item,before)
   results.append({'sha256':item['sha256'],'bytes':item['bytes'],'status':'verified_existing'});continue
  temp=target.with_name(target.name+'.download');M.need(not temp.exists()and not temp.is_symlink(),'BUILD_CACHE_DOWNLOAD_MUST_BE_NEW');started=time.monotonic();total=0;digest=hashlib.sha256()
  try:
   request=urllib.request.Request(item['url'],headers={'User-Agent':'Grabenplaner-pinned-build-cache-v2','Accept':'application/octet-stream'})
   with urllib.request.build_opener(OfficialRedirect()).open(request,timeout=30)as response,temp.open('xb')as output:
    final=urllib.parse.urlsplit(response.url);M.need(final.scheme=='https'and final.hostname in OFFICIAL,'OFFICIAL_REDIRECT_REQUIRED')
    remaining=item['bytes']+1
    while remaining:
     M.need(time.monotonic()-started<180,'BUILD_CACHE_DOWNLOAD_TIMEOUT');chunk=response.read(min(1024*1024,remaining))
     if not chunk:break
     total+=len(chunk);remaining-=len(chunk);digest.update(chunk);output.write(chunk)
   M.need(total==item['bytes']and digest.hexdigest()==item['sha256'],'BUILD_CACHE_DOWNLOAD_SHA');temp.rename(target)
  finally:
   if temp.exists():M.need(temp.resolve().parent==target.parent.resolve()and temp.name==target.name+'.download','BUILD_CACHE_CLEANUP_BOUNDARY');temp.unlink()
  results.append({'sha256':item['sha256'],'bytes':item['bytes'],'status':'downloaded_verified'})
 return {'format':'gp-af-explicit-build-cache-fetch-v2','objects':results,'runtimeFetch':False,'sourceRootWritten':False}
def main():
 p=argparse.ArgumentParser();p.add_argument('--source-root',required=True);p.add_argument('--cache-root',required=True);p.add_argument('--fetch-official-pinned-assets',required=True,action='store_true');a=p.parse_args();print(json.dumps(fetch(a.source_root,a.cache_root)))
if __name__=='__main__':main()
