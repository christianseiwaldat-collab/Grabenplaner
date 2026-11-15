"""Build-only ZIP creator normalization; never recompress or change payload metadata.
The new package ZIP is owned by the caller. Unsupported layouts fail before writes.
"""
import argparse,hashlib,io,json,os,stat,struct,zipfile
from pathlib import Path
def need(v,message):
 if not v:raise ValueError(message)

def sha(raw):return hashlib.sha256(raw).hexdigest()

def extras(raw):
 at=0
 while at<len(raw):
  need(at+4<=len(raw),'Truncated ZIP extra');tag,size=struct.unpack_from('<HH',raw,at);at+=4
  need(tag!=1 and at+size<=len(raw),'ZIP64/invalid extra unsupported');at+=size

def parse(raw):
 need(len(raw)>=22 and raw[:4]==b'PK\x03\x04','Normal single-volume ZIP required')
 candidates=[];start=max(0,len(raw)-22-65535)
 for at in range(start,len(raw)-21):
  if raw[at:at+4]!=b'PK\x05\x06':continue
  fields=struct.unpack_from('<4s4H2IH',raw,at)
  if at+22+fields[-1]==len(raw):candidates.append((at,fields))
 need(len(candidates)==1,'Unique terminal EOCD required');end,e=candidates[0]
 _,disk,cd_disk,on_disk,count,cd_size,cd_at,comment_size=e
 need(disk==cd_disk==0 and on_disk==count and 0<count<65535 and
      cd_size!=0xffffffff and cd_at!=0xffffffff and cd_at+cd_size==end and
      cd_size>=46*count and cd_at>=30,'EOCD bounds/multivolume/ZIP64 unsupported')
 at=cd_at;records=[];names=set();local=[]
 for index in range(count):
  need(at+46<=end and raw[at:at+4]==b'PK\x01\x02','Central header missing/truncated')
  f=struct.unpack_from('<4s6H3I5H2I',raw,at)
  _,made,needed,flags,method,mtime,mdate,crc,csize,usize,nlen,xlen,clen,start_disk,iattr,eattr,offset=f
  length=46+nlen+xlen+clen;need(nlen>0 and at+length<=end and start_disk==0 and
       csize!=0xffffffff and usize!=0xffffffff and offset!=0xffffffff and
       made>>8 in(0,3) and not flags&1 and method in(0,8),'Central bounds/creator/type differ')
  name=raw[at+46:at+46+nlen];need(name not in names,'Duplicate central name');names.add(name)
  extras(raw[at+46+nlen:at+46+nlen+xlen])
  need(offset+30<=cd_at and raw[offset:offset+4]==b'PK\x03\x04','Local header offset differs')
  lf=struct.unpack_from('<4s5H3I2H',raw,offset)
  _,ln,fl,cm,tm,dt,lc,ls,lu,nl,xl=lf
  need((ln,fl,cm,tm,dt)==(needed,flags,method,mtime,mdate)and nl==nlen and
       raw[offset+30:offset+30+nl]==name,'Local and central metadata differ')
  payload=offset+30+nl+xl;finish=payload+csize
  need(payload<=cd_at and finish<=cd_at,'Local payload bounds differ');extras(raw[offset+30+nl:payload])
  if flags&8:
   need(lc in(0,crc)and ls in(0,csize)and lu in(0,usize),'Local descriptor placeholders differ')
   dd=finish+4 if raw[finish:finish+4]==b'PK\x07\x08'else finish
   need(dd+12<=cd_at and struct.unpack_from('<3I',raw,dd)==(crc,csize,usize),'Data descriptor differs');finish=dd+12
  else:need((lc,ls,lu)==(crc,csize,usize),'Local CRC/sizes differ')
  local.append((offset,finish));records.append({'offset':at,'length':length,'creatorByte':at+5,'externalAttr':eattr})
  at+=length
 need(at==end,'Central directory size/count differs')
 cursor=0
 for begin,finish in sorted(local):need(begin==cursor and finish>=begin,'Local record gaps/overlap');cursor=finish
 need(cursor==cd_at,'Local payload region not exact')
 return {'eocdOffset':end,'centralOffset':cd_at,'centralBytes':cd_size,'entryCount':count,'commentBytes':comment_size,'records':records}

def normalize_archive(filename):
 path=Path(filename);need(path.is_file()and not path.is_symlink(),'Regular archive required')
 with path.open('r+b')as stream:
  info=os.fstat(stream.fileno());need(stat.S_ISREG(info.st_mode)and info.st_nlink==1 and 22<=info.st_size<=2*1024**3,'Archive bound/type differs')
  original=stream.read(info.st_size+1);need(len(original)==info.st_size,'Archive changed while reading')
  layout=parse(original);normalized=bytearray(original);changed=[]
  for entry in layout['records']:
   at=entry['creatorByte']
   if normalized[at]==0:normalized[at]=3;changed.append(at)
  normalized=bytes(normalized);need(parse(normalized)==layout and all(normalized[r['creatorByte']]==3 for r in layout['records']),'Normalized ZIP structure differs')
  restored=bytearray(normalized)
  for at in changed:restored[at]=original[at]
  need(restored==original,'Reversing creator bytes did not reconstruct the full original')
  with zipfile.ZipFile(io.BytesIO(original))as before,zipfile.ZipFile(io.BytesIO(normalized))as after:
   left,right=before.infolist(),after.infolist();need(len(left)==len(right)==layout['entryCount'],'ZIP inventory differs')
   for a,b in zip(left,right):
    need(b.create_system==3 and all(getattr(a,k,None)==getattr(b,k,None)for k in zipfile.ZipInfo.__slots__ if k!='create_system'),'ZIP metadata other than creator differs')
  # Write ONLY already validated central creator bytes. The packager deletes a
  # failed newly-owned archive; no SHA sidecar exists yet on any failure.
  need(os.fstat(stream.fileno()).st_size==len(original),'Archive changed before normalization')
  for at in changed:stream.seek(at);need(stream.write(b'\x03')==1,'Creator write failed')
  stream.flush();os.fsync(stream.fileno());stream.seek(0);need(stream.read()==normalized,'Persisted ZIP differs')
 return {'format':'gp-linux-zip-unix-creator-v1','normalized':True,'entries':layout['entryCount'],'changedCreatorBytes':len(changed),
  'creatorSystem':3,'inputSha256':sha(original),'outputSha256':sha(normalized),'originalReconstructed':True,
  'payloadAndOtherMetadataUnchanged':True,'recompressed':False}

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('archive');args=parser.parse_args()
 print(json.dumps(normalize_archive(args.archive)))
if __name__=='__main__':main()
