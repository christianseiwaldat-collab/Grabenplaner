// Exact known AFv2 independent aggregate protocol. RAM-only stdin; parent owns trust/approval.
import com.healthmarketscience.jackcess.*;
import com.healthmarketscience.jackcess.util.MemFileChannel;
import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.lang.management.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.logging.*;

public final class KnownAfCountVerifier {
  static final String PROFILE="6f0b0798b089440320a755b9999334aad7ef858a28cb1efacf2e63437eb52a41";
  static final String APPLICATION_SCHEMA="6eb145ac270d384c290e3f8f67d888c31b6bf75f13b04ac312cbcc1255d6ef7e";
  static final String SOURCE_SYSTEM="tradefoto.history.trade",SOURCE_INSTANCE="tradefoto-trade",TABLE="ARTIKEL_FILIALEN";
  static final long MAX_BYTES=512L*1024*1024,ROW_LIMIT=2000000;
  static final String CONTRACT_SHA="819108532d5dfdb76dd4de7a3bc7081f73717e620e0a470b6db3152d922d09ca";
  static final String CONTRACT_BASE64="eyJhcHBsaWNhdGlvblNjaGVtYVNoYTI1NiI6IjZlYjE0NWFjMjcwZDM4NGMyOTBlM2Y4ZjY3ZDg4OGMzMWI2YmY3NWYxM2IwNGFjMzEyY2JjYzEyNTVkNmVmN2UiLCJjYW5BcHByb3ZlIjpmYWxzZSwiY2FuSW1wb3J0IjpmYWxzZSwiY29sdW1ucyI6W3siYXV0b051bWJlciI6ZmFsc2UsImNvbHVtbkluZGV4IjowLCJjb21wcmVzc2VkVW5pY29kZSI6ZmFsc2UsImxlbmd0aEJ5dGVzIjoyNiwibGVuZ3RoVW5pdHMiOjEzLCJuYW1lIjoiRUFOIiwicHJlY2lzaW9uIjowLCJzY2FsZSI6MCwidHlwZSI6IlRFWFQiLCJ2YXJpYWJsZUxlbmd0aCI6dHJ1ZX0seyJhdXRvTnVtYmVyIjpmYWxzZSwiY29sdW1uSW5kZXgiOjEsImNvbXByZXNzZWRVbmljb2RlIjpmYWxzZSwibGVuZ3RoQnl0ZXMiOjEsImxlbmd0aFVuaXRzIjoxLCJuYW1lIjoiRmlsaWFsSUQiLCJwcmVjaXNpb24iOjAsInNjYWxlIjowLCJ0eXBlIjoiQllURSIsInZhcmlhYmxlTGVuZ3RoIjpmYWxzZX0seyJhdXRvTnVtYmVyIjpmYWxzZSwiY29sdW1uSW5kZXgiOjIsImNvbXByZXNzZWRVbmljb2RlIjpmYWxzZSwibGVuZ3RoQnl0ZXMiOjQsImxlbmd0aFVuaXRzIjoyLCJuYW1lIjoiUHJvdmlzaW9uS1oiLCJwcmVjaXNpb24iOjAsInNjYWxlIjowLCJ0eXBlIjoiVEVYVCIsInZhcmlhYmxlTGVuZ3RoIjp0cnVlfSx7ImF1dG9OdW1iZXIiOmZhbHNlLCJjb2x1bW5JbmRleCI6MywiY29tcHJlc3NlZFVuaWNvZGUiOmZhbHNlLCJsZW5ndGhCeXRlcyI6OCwibGVuZ3RoVW5pdHMiOjgsIm5hbWUiOiJHw7xsdGlnYWIiLCJwcmVjaXNpb24iOjAsInNjYWxlIjowLCJ0eXBlIjoiU0hPUlRfREFURV9USU1FIiwidmFyaWFibGVMZW5ndGgiOmZhbHNlfSx7ImF1dG9OdW1iZXIiOmZhbHNlLCJjb2x1bW5JbmRleCI6NCwiY29tcHJlc3NlZFVuaWNvZGUiOmZhbHNlLCJsZW5ndGhCeXRlcyI6OCwibGVuZ3RoVW5pdHMiOjgsIm5hbWUiOiJHw7xsdGlnYmlzIiwicHJlY2lzaW9uIjowLCJzY2FsZSI6MCwidHlwZSI6IlNIT1JUX0RBVEVfVElNRSIsInZhcmlhYmxlTGVuZ3RoIjpmYWxzZX0seyJhdXRvTnVtYmVyIjpmYWxzZSwiY29sdW1uSW5kZXgiOjUsImNvbXByZXNzZWRVbmljb2RlIjpmYWxzZSwibGVuZ3RoQnl0ZXMiOjQsImxlbmd0aFVuaXRzIjo0LCJuYW1lIjoiVmVycGFja3VuZ3NlaW5oZWl0IiwicHJlY2lzaW9uIjowLCJzY2FsZSI6MCwidHlwZSI6IkxPTkciLCJ2YXJpYWJsZUxlbmd0aCI6ZmFsc2V9LHsiYXV0b051bWJlciI6ZmFsc2UsImNvbHVtbkluZGV4Ijo2LCJjb21wcmVzc2VkVW5pY29kZSI6ZmFsc2UsImxlbmd0aEJ5dGVzIjo0LCJsZW5ndGhVbml0cyI6NCwibmFtZSI6IkjDtmNoc3RtZW5nZSIsInByZWNpc2lvbiI6MCwic2NhbGUiOjAsInR5cGUiOiJMT05HIiwidmFyaWFibGVMZW5ndGgiOmZhbHNlfSx7ImF1dG9OdW1iZXIiOmZhbHNlLCJjb2x1bW5JbmRleCI6NywiY29tcHJlc3NlZFVuaWNvZGUiOmZhbHNlLCJsZW5ndGhCeXRlcyI6OCwibGVuZ3RoVW5pdHMiOjgsIm5hbWUiOiJGQmVzdGFuZCIsInByZWNpc2lvbiI6MCwic2NhbGUiOjAsInR5cGUiOiJET1VCTEUiLCJ2YXJpYWJsZUxlbmd0aCI6ZmFsc2V9LHsiYXV0b051bWJlciI6ZmFsc2UsImNvbHVtbkluZGV4Ijo4LCJjb21wcmVzc2VkVW5pY29kZSI6ZmFsc2UsImxlbmd0aEJ5dGVzIjo4LCJsZW5ndGhVbml0cyI6OCwibmFtZSI6IkZ2a2oiLCJwcmVjaXNpb24iOjAsInNjYWxlIjowLCJ0eXBlIjoiRE9VQkxFIiwidmFyaWFibGVMZW5ndGgiOmZhbHNlfSx7ImF1dG9OdW1iZXIiOmZhbHNlLCJjb2x1bW5JbmRleCI6OSwiY29tcHJlc3NlZFVuaWNvZGUiOmZhbHNlLCJsZW5ndGhCeXRlcyI6OCwibGVuZ3RoVW5pdHMiOjgsIm5hbWUiOiJGdmt3IiwicHJlY2lzaW9uIjowLCJzY2FsZSI6MCwidHlwZSI6IkRPVUJMRSIsInZhcmlhYmxlTGVuZ3RoIjpmYWxzZX0seyJhdXRvTnVtYmVyIjpmYWxzZSwiY29sdW1uSW5kZXgiOjEwLCJjb21wcmVzc2VkVW5pY29kZSI6ZmFsc2UsImxlbmd0aEJ5dGVzIjo4LCJsZW5ndGhVbml0cyI6OCwibmFtZSI6IkZ2azR3IiwicHJlY2lzaW9uIjowLCJzY2FsZSI6MCwidHlwZSI6IkRPVUJMRSIsInZhcmlhYmxlTGVuZ3RoIjpmYWxzZX0seyJhdXRvTnVtYmVyIjpmYWxzZSwiY29sdW1uSW5kZXgiOjExLCJjb21wcmVzc2VkVW5pY29kZSI6ZmFsc2UsImxlbmd0aEJ5dGVzIjo4LCJsZW5ndGhVbml0cyI6OCwibmFtZSI6IkFrdGlvblZlcmthdWZzcHJlaXMiLCJwcmVjaXNpb24iOjAsInNjYWxlIjowLCJ0eXBlIjoiRE9VQkxFIiwidmFyaWFibGVMZW5ndGgiOmZhbHNlfSx7ImF1dG9OdW1iZXIiOmZhbHNlLCJjb2x1bW5JbmRleCI6MTIsImNvbXByZXNzZWRVbmljb2RlIjpmYWxzZSwibGVuZ3RoQnl0ZXMiOjgsImxlbmd0aFVuaXRzIjo4LCJuYW1lIjoiVmVya2F1ZnNwcmVpcyIsInByZWNpc2lvbiI6MCwic2NhbGUiOjAsInR5cGUiOiJET1VCTEUiLCJ2YXJpYWJsZUxlbmd0aCI6ZmFsc2V9LHsiYXV0b051bWJlciI6ZmFsc2UsImNvbHVtbkluZGV4IjoxMywiY29tcHJlc3NlZFVuaWNvZGUiOmZhbHNlLCJsZW5ndGhCeXRlcyI6OCwibGVuZ3RoVW5pdHMiOjgsIm5hbWUiOiJBVmVya2F1ZnNwcmVpcyIsInByZWNpc2lvbiI6MCwic2NhbGUiOjAsInR5cGUiOiJET1VCTEUiLCJ2YXJpYWJsZUxlbmd0aCI6ZmFsc2V9LHsiYXV0b051bWJlciI6ZmFsc2UsImNvbHVtbkluZGV4IjoxNCwiY29tcHJlc3NlZFVuaWNvZGUiOmZhbHNlLCJsZW5ndGhCeXRlcyI6OCwibGVuZ3RoVW5pdHMiOjgsIm5hbWUiOiJXZXJ0U29uZGVyYXJ0aWtlbCIsInByZWNpc2lvbiI6MCwic2NhbGUiOjAsInR5cGUiOiJET1VCTEUiLCJ2YXJpYWJsZUxlbmd0aCI6ZmFsc2V9LHsiYXV0b051bWJlciI6ZmFsc2UsImNvbHVtbkluZGV4IjoxNSwiY29tcHJlc3NlZFVuaWNvZGUiOmZhbHNlLCJsZW5ndGhCeXRlcyI6OCwibGVuZ3RoVW5pdHMiOjgsIm5hbWUiOiJCZXN0ZWxsdCIsInByZWNpc2lvbiI6MCwic2NhbGUiOjAsInR5cGUiOiJET1VCTEUiLCJ2YXJpYWJsZUxlbmd0aCI6ZmFsc2V9LHsiYXV0b051bWJlciI6ZmFsc2UsImNvbHVtbkluZGV4IjoxNiwiY29tcHJlc3NlZFVuaWNvZGUiOmZhbHNlLCJsZW5ndGhCeXRlcyI6OCwibGVuZ3RoVW5pdHMiOjgsIm5hbWUiOiJXZXJ0bWVuZ2UiLCJwcmVjaXNpb24iOjAsInNjYWxlIjowLCJ0eXBlIjoiRE9VQkxFIiwidmFyaWFibGVMZW5ndGgiOmZhbHNlfSx7ImF1dG9OdW1iZXIiOmZhbHNlLCJjb2x1bW5JbmRleCI6MTcsImNvbXByZXNzZWRVbmljb2RlIjpmYWxzZSwibGVuZ3RoQnl0ZXMiOjgsImxlbmd0aFVuaXRzIjo4LCJuYW1lIjoiaW52ZW50dXJkYXQiLCJwcmVjaXNpb24iOjAsInNjYWxlIjowLCJ0eXBlIjoiU0hPUlRfREFURV9USU1FIiwidmFyaWFibGVMZW5ndGgiOmZhbHNlfSx7ImF1dG9OdW1iZXIiOmZhbHNlLCJjb2x1bW5JbmRleCI6MTgsImNvbXByZXNzZWRVbmljb2RlIjpmYWxzZSwibGVuZ3RoQnl0ZXMiOjEsImxlbmd0aFVuaXRzIjoxLCJuYW1lIjoiSUYiLCJwcmVjaXNpb24iOjAsInNjYWxlIjowLCJ0eXBlIjoiQk9PTEVBTiIsInZhcmlhYmxlTGVuZ3RoIjpmYWxzZX0seyJhdXRvTnVtYmVyIjpmYWxzZSwiY29sdW1uSW5kZXgiOjE5LCJjb21wcmVzc2VkVW5pY29kZSI6ZmFsc2UsImxlbmd0aEJ5dGVzIjo4LCJsZW5ndGhVbml0cyI6OCwibmFtZSI6IkFWIiwicHJlY2lzaW9uIjowLCJzY2FsZSI6MCwidHlwZSI6IkRPVUJMRSIsInZhcmlhYmxlTGVuZ3RoIjpmYWxzZX0seyJhdXRvTnVtYmVyIjpmYWxzZSwiY29sdW1uSW5kZXgiOjIwLCJjb21wcmVzc2VkVW5pY29kZSI6ZmFsc2UsImxlbmd0aEJ5dGVzIjo4LCJsZW5ndGhVbml0cyI6OCwibmFtZSI6IkZWSzNNIiwicHJlY2lzaW9uIjowLCJzY2FsZSI6MCwidHlwZSI6IkRPVUJMRSIsInZhcmlhYmxlTGVuZ3RoIjpmYWxzZX0seyJhdXRvTnVtYmVyIjpmYWxzZSwiY29sdW1uSW5kZXgiOjIxLCJjb21wcmVzc2VkVW5pY29kZSI6ZmFsc2UsImxlbmd0aEJ5dGVzIjo4LCJsZW5ndGhVbml0cyI6OCwibmFtZSI6IlNfb3V0IiwicHJlY2lzaW9uIjowLCJzY2FsZSI6MCwidHlwZSI6IkRPVUJMRSIsInZhcmlhYmxlTGVuZ3RoIjpmYWxzZX0seyJhdXRvTnVtYmVyIjpmYWxzZSwiY29sdW1uSW5kZXgiOjIyLCJjb21wcmVzc2VkVW5pY29kZSI6ZmFsc2UsImxlbmd0aEJ5dGVzIjo4LCJsZW5ndGhVbml0cyI6OCwibmFtZSI6IkxJbnZlbnR1ckJlc3RhbmQiLCJwcmVjaXNpb24iOjAsInNjYWxlIjowLCJ0eXBlIjoiRE9VQkxFIiwidmFyaWFibGVMZW5ndGgiOmZhbHNlfSx7ImF1dG9OdW1iZXIiOmZhbHNlLCJjb2x1bW5JbmRleCI6MjMsImNvbXByZXNzZWRVbmljb2RlIjpmYWxzZSwibGVuZ3RoQnl0ZXMiOjEsImxlbmd0aFVuaXRzIjoxLCJuYW1lIjoiSW50ZXJuZXRGaWxpYWxlIiwicHJlY2lzaW9uIjowLCJzY2FsZSI6MCwidHlwZSI6IkJPT0xFQU4iLCJ2YXJpYWJsZUxlbmd0aCI6ZmFsc2V9LHsiYXV0b051bWJlciI6ZmFsc2UsImNvbHVtbkluZGV4IjoyNCwiY29tcHJlc3NlZFVuaWNvZGUiOmZhbHNlLCJsZW5ndGhCeXRlcyI6NCwibGVuZ3RoVW5pdHMiOjQsIm5hbWUiOiJMR1BMYXR6IiwicHJlY2lzaW9uIjowLCJzY2FsZSI6MCwidHlwZSI6IkxPTkciLCJ2YXJpYWJsZUxlbmd0aCI6ZmFsc2V9LHsiYXV0b051bWJlciI6ZmFsc2UsImNvbHVtbkluZGV4IjoyNSwiY29tcHJlc3NlZFVuaWNvZGUiOmZhbHNlLCJsZW5ndGhCeXRlcyI6OCwibGVuZ3RoVW5pdHMiOjgsIm5hbWUiOiJCZXN0YW5kc8OkbmRlcnVuZ3NkYXR1bSIsInByZWNpc2lvbiI6MCwic2NhbGUiOjAsInR5cGUiOiJTSE9SVF9EQVRFX1RJTUUiLCJ2YXJpYWJsZUxlbmd0aCI6ZmFsc2V9LHsiYXV0b051bWJlciI6ZmFsc2UsImNvbHVtbkluZGV4IjoyNiwiY29tcHJlc3NlZFVuaWNvZGUiOmZhbHNlLCJsZW5ndGhCeXRlcyI6OCwibGVuZ3RoVW5pdHMiOjgsIm5hbWUiOiJpbV9adWxhdWYiLCJwcmVjaXNpb24iOjAsInNjYWxlIjowLCJ0eXBlIjoiRE9VQkxFIiwidmFyaWFibGVMZW5ndGgiOmZhbHNlfV0sImZpbGVIYXNoUG9saWN5IjoiZnV0dXJlLXByb29mLW11c3QtYmluZC1leGFjdC1keW5hbWljLW9yaWdpbmFsLWJ5dGVzLXNoYTI1NiIsImZvcm1hdCI6ImdwLWFmdjItbG9naWNhbC1tZXRhZGF0YS1jb250cmFjdC12MiIsImluZGV4ZXMiOlt7ImNvbHVtbnMiOlt7ImFzY2VuZGluZyI6dHJ1ZSwibmFtZSI6IkVBTiJ9XSwiaWdub3Jlc051bGxzIjpmYWxzZSwibmFtZSI6IkFSVElLRUxfU1RBTU1BUlRJS0VMX0ZJTElBTEVOIiwicHJpbWFyeSI6ZmFsc2UsInJlcXVpcmVkIjpmYWxzZSwidW5pcXVlIjpmYWxzZX0seyJjb2x1bW5zIjpbeyJhc2NlbmRpbmciOnRydWUsIm5hbWUiOiJGaWxpYWxJRCJ9XSwiaWdub3Jlc051bGxzIjpmYWxzZSwibmFtZSI6IkZpbGlhbElEIiwicHJpbWFyeSI6ZmFsc2UsInJlcXVpcmVkIjpmYWxzZSwidW5pcXVlIjpmYWxzZX0seyJjb2x1bW5zIjpbeyJhc2NlbmRpbmciOnRydWUsIm5hbWUiOiJFQU4ifSx7ImFzY2VuZGluZyI6dHJ1ZSwibmFtZSI6IkZpbGlhbElEIn1dLCJpZ25vcmVzTnVsbHMiOmZhbHNlLCJuYW1lIjoiUHJpbWFyeUtleSIsInByaW1hcnkiOnRydWUsInJlcXVpcmVkIjp0cnVlLCJ1bmlxdWUiOnRydWV9LHsiY29sdW1ucyI6W3siYXNjZW5kaW5nIjp0cnVlLCJuYW1lIjoiRmlsaWFsSUQifV0sImlnbm9yZXNOdWxscyI6ZmFsc2UsIm5hbWUiOiJ7QkU0RDczNDctN0U4RC00QTMyLUJDMjEtN0RFNEYzOEQxQUFBfSIsInByaW1hcnkiOmZhbHNlLCJyZXF1aXJlZCI6ZmFsc2UsInVuaXF1ZSI6ZmFsc2V9XSwicHJvZmlsZUhhc2giOiI2ZjBiMDc5OGIwODk0NDAzMjBhNzU1Yjk5OTkzMzRhYWQ3ZWY4NThhMjhjYjFlZmFjZjJlNjM0MzdlYjUyYTQxIiwicmF3SW5kZXhGbGFncyI6bnVsbCwicmF3SW5kZXhGbGFnc0F2YWlsYWJsZSI6ZmFsc2UsInJvd0NvdW50c1BvbGljeSI6ImhlYWRlci1hbmQtaW5kZXBlbmRlbnQtbG9naWNhbC1jb3VudC1hcmUtZHluYW1pYy1ub3QtdGhpcy1maWxlLWNvbnN0YW50cyIsInNvdXJjZUluc3RhbmNlIjoidHJhZGVmb3RvLXRyYWRlIiwic291cmNlU3lzdGVtIjoidHJhZGVmb3RvLmhpc3RvcnkudHJhZGUiLCJ0YWJsZSI6IkFSVElLRUxfRklMSUFMRU4iLCJ0cnVzdGVkQ291bnRQcm9vZiI6ZmFsc2UsInVua25vd25GbGFnUG9saWN5IjoiRG8gbm90IGluZmVyIHVubmFtZWQgZmxhZ3M7IG9ubHkgZXhwbGljaXRseSBvYnNlcnZlZCBwdWJsaWMgZmxhZ3MgYXJlIHF1YWxpZmllZC4gUGFyc2VyL0pBUiBpZGVudGl0eSByZW1haW5zIHNlcGFyYXRlbHkgcGlubmVkLiJ9";
  static final Gson JSON=new GsonBuilder().serializeNulls().create();
  record Options(long bytes,String sha,long deadlineMs,long rowLimit,int jsonCap){}
  static final class Rejected extends RuntimeException{private static final long serialVersionUID=1L;final String code;Rejected(String c){super(c);code=c;}}
  static void fail(String c){throw new Rejected(c);}
  static Map<String,Object> obj(Object... pairs){Map<String,Object> out=new LinkedHashMap<>();for(int i=0;i<pairs.length;i+=2)out.put((String)pairs[i],pairs[i+1]);return out;}
  static String sha(byte[] b)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));}
  static long number(String s,long max){if(s==null||!s.matches("[1-9][0-9]{0,17}"))fail("OPTIONS_INVALID");try{long n=Long.parseLong(s);if(n>max)fail("OPTIONS_INVALID");return n;}catch(NumberFormatException e){fail("OPTIONS_INVALID");return 0;}}
  static Options options(String[] a){
    Set<String> allowed=Set.of("--bytes","--sha256","--deadline-ms","--row-limit","--json-cap");Map<String,String> m=new HashMap<>();
    if(a.length%2!=0||a.length>10)fail("OPTIONS_INVALID");for(int i=0;i<a.length;i+=2)if(!allowed.contains(a[i])||m.put(a[i],a[i+1])!=null)fail("OPTIONS_INVALID");
    long bytes=number(m.get("--bytes"),MAX_BYTES);String hash=m.get("--sha256");
    if(bytes<4096||hash==null||!hash.matches("[a-f0-9]{64}"))fail("OPTIONS_INVALID");
    int json=(int)number(m.getOrDefault("--json-cap","65536"),65536);if(json<1024)fail("OPTIONS_INVALID");
    return new Options(bytes,hash,number(m.getOrDefault("--deadline-ms","80000"),80000),number(m.getOrDefault("--row-limit",Long.toString(ROW_LIMIT)),ROW_LIMIT),json);
  }
  static final class Deadline{final long end;Deadline(long ms){end=System.nanoTime()+ms*1000000;}void check(){if(System.nanoTime()>end)fail("DEADLINE_EXCEEDED");}}
  static final class Input extends FilterInputStream{
    final Deadline deadline;final long expected;final MessageDigest digest;long count;boolean eof;
    Input(InputStream in,long expected,Deadline d)throws Exception{super(in);this.expected=expected;deadline=d;digest=MessageDigest.getInstance("SHA-256");}
    public int read()throws IOException{byte[] b=new byte[1];int n=read(b,0,1);return n<0?-1:b[0]&255;}
    public int read(byte[] b,int off,int len)throws IOException{
      Objects.checkFromIndexSize(off,len,b.length);deadline.check();if(len==0)return 0;if(eof)return -1;
      if(count==expected){int extra=in.read();deadline.check();if(extra!=-1)fail("INPUT_OVERLONG");eof=true;return -1;}
      int n=in.read(b,off,(int)Math.min(len,expected-count));deadline.check();if(n<0){eof=true;return -1;}if(n==0)fail("INPUT_NO_PROGRESS");digest.update(b,off,n);count+=n;return n;
    }
    String finish()throws IOException{if(read()!=-1)fail("INPUT_NOT_CONSUMED");if(count!=expected)fail("INPUT_LENGTH_MISMATCH");return HexFormat.of().formatHex(digest.digest());}
  }
  static JsonObject knownContract()throws Exception{
    byte[] bytes=Base64.getDecoder().decode(CONTRACT_BASE64);if(!CONTRACT_SHA.equals(sha(bytes)))fail("CONTRACT_INTEGRITY");
    JsonObject c=JsonParser.parseString(new String(bytes,StandardCharsets.UTF_8)).getAsJsonObject();
    if(!PROFILE.equals(c.get("profileHash").getAsString())||!APPLICATION_SCHEMA.equals(c.get("applicationSchemaSha256").getAsString())||!SOURCE_SYSTEM.equals(c.get("sourceSystem").getAsString())||!SOURCE_INSTANCE.equals(c.get("sourceInstance").getAsString())||!TABLE.equals(c.get("table").getAsString()))fail("CONTRACT_INTEGRITY");
    return c;
  }
  static Object optional(Object target,Class<?> api,String name)throws Exception{try{return api.getMethod(name).invoke(target);}catch(NoSuchMethodException e){return null;}}
  static JsonArray columns(Table t)throws Exception{
    JsonArray out=new JsonArray();if(t.getColumns().size()!=27)fail("COLUMN_CONTRACT_MISMATCH");
    for(Column c:t.getColumns())out.add(JSON.toJsonTree(obj("name",c.getName(),"type",c.getType().name(),"columnIndex",c.getColumnIndex(),"lengthBytes",(int)c.getLength(),"lengthUnits",(int)c.getLengthInUnits(),"precision",(int)c.getPrecision(),"scale",(int)c.getScale(),"variableLength",c.isVariableLength(),"autoNumber",optional(c,Column.class,"isAutoNumber"),"compressedUnicode",optional(c,Column.class,"isCompressedUnicode"))));return out;
  }
  static Map<String,Object> indexContract(Index i)throws Exception{
    Object unique=optional(i,Index.class,"isUnique"),required=optional(i,Index.class,"isRequired");if(!(unique instanceof Boolean)||!(required instanceof Boolean))fail("INDEX_FLAGS_UNAVAILABLE");
    List<Object> cols=new ArrayList<>();for(Index.Column c:i.getColumns())cols.add(obj("name",c.getName(),"ascending",c.isAscending()));
    return obj("name",i.getName(),"primary",i.isPrimaryKey(),"unique",unique,"required",required,"ignoresNulls",i.shouldIgnoreNulls(),"columns",cols);
  }
  static List<Index> validateMetadata(Table t,JsonObject contract,Deadline d)throws Exception{
    d.check();if(!columns(t).equals(contract.getAsJsonArray("columns")))fail("COLUMN_CONTRACT_MISMATCH");
    List<Index> indexes=new ArrayList<>(t.getIndexes());indexes.sort(Comparator.comparing(Index::getName));if(indexes.size()!=4)fail("INDEX_CONTRACT_MISMATCH");
    JsonArray actual=new JsonArray();Set<String> names=new HashSet<>();int primaries=0;
    for(Index i:indexes){d.check();if(!names.add(i.getName())||i.shouldIgnoreNulls())fail("INDEX_CONTRACT_MISMATCH");if(i.isPrimaryKey())primaries++;actual.add(JSON.toJsonTree(indexContract(i)));}
    if(primaries!=1||!actual.equals(contract.getAsJsonArray("indexes")))fail("INDEX_CONTRACT_MISMATCH");return indexes;
  }
  static long cpu(){var b=ManagementFactory.getOperatingSystemMXBean();return b instanceof com.sun.management.OperatingSystemMXBean o?o.getProcessCpuTime():-1;}
  static long peakHeap(){long n=0;for(MemoryPoolMXBean p:ManagementFactory.getMemoryPoolMXBeans())if(p.getType()==MemoryType.HEAP)n+=p.getPeakUsage().getUsed();return n;}
  static Table requireOrdinaryAf(Database db)throws Exception{
    // Install DENY before any user-table metadata traversal or table open.
    db.setLinkResolver((from,name)->{throw new IOException("LINK_RESOLUTION_FORBIDDEN");});
    TableMetaData metadata=db.getTableMetaData(TABLE);
    if(metadata==null||!TABLE.equals(metadata.getName())||metadata.isLinked()||metadata.isSystem()||metadata.getType()!=TableMetaData.Type.LOCAL)fail("AF_PHYSICAL_TABLE_REQUIRED");
    Table t=db.getTable(TABLE);if(t==null)fail("TABLE_MISSING");return t;
  }
  static Map<String,Object> verify(InputStream stdin,Options opt)throws Exception{
    Deadline d=new Deadline(opt.deadlineMs);JsonObject contract=knownContract();
    Input input=new Input(stdin,opt.bytes,d);String actualSha;long logical=0;int header;List<Object> checked=new ArrayList<>();
    try(MemFileChannel ram=MemFileChannel.newChannel(input,"r")){
      actualSha=input.finish();if(!MessageDigest.isEqual(actualSha.getBytes(StandardCharsets.US_ASCII),opt.sha.getBytes(StandardCharsets.US_ASCII)))fail("SOURCE_HASH_MISMATCH");
      d.check();try(Database db=new DatabaseBuilder().setChannel(ram).setReadOnly(true).setAutoSync(false).open()){
        Table t=requireOrdinaryAf(db);
        // Absolutely no row cursor exists until the complete known metadata matches.
        List<Index> indexes=validateMetadata(t,contract,d);header=t.getRowCount();if(header<0||header>ROW_LIMIT)fail("HEADER_COUNT_INVALID");
        Set<RowId> logicalIds=new HashSet<>();Cursor scan=t.newCursor().toCursor();Row row;
        while((row=scan.getNextRow(Collections.emptySet()))!=null){d.check();if(++logical>opt.rowLimit)fail("ROW_LIMIT_EXCEEDED");if(row.getId()==null||!logicalIds.add(row.getId()))fail("LOGICAL_ROW_ID_DUPLICATE");}
        for(Index index:indexes){
          d.check();Set<RowId> indexIds=new HashSet<>();long rows=0,duplicates=0,extra=0,missing=0;Cursor ic=t.newCursor().setIndex(index).toCursor();
          while((row=ic.getNextRow(Collections.emptySet()))!=null){d.check();if(++rows>opt.rowLimit)fail("INDEX_ROW_LIMIT_EXCEEDED");RowId id=row.getId();if(id==null||!indexIds.add(id))duplicates++;if(!logicalIds.contains(id))extra++;}
          for(RowId id:logicalIds){d.check();if(!indexIds.contains(id))missing++;}
          boolean exact=rows==logical&&indexIds.size()==logicalIds.size()&&duplicates==0&&extra==0&&missing==0;
          if(!exact)fail("INDEX_FULL_ROW_ID_COVERAGE_MISMATCH");
          checked.add(obj("name",index.getName(),"rows",rows,"uniqueRowIds",indexIds.size(),"duplicates",duplicates,"extra",extra,"missing",missing,"exactCoverage",true));
          // Only one index RowID set is live at once; no per-row values are retained.
          indexIds.clear();
        }
      }
    }
    Map<String,Object> binding=obj("fileSha256",actualSha,"bytes",input.count,"sourceSystem",SOURCE_SYSTEM,"sourceInstance",SOURCE_INSTANCE,"sourceTable",TABLE,"profileHash",PROFILE,"applicationSchemaSha256",APPLICATION_SCHEMA,"physicalContractSha256",CONTRACT_SHA);
    return obj("format","gp-known-af-independent-count-v1","passed",true,"binding",binding,"counts",obj("headerRows",header,"logicalRows",logical,"uniqueLogicalRowIds",logical),"metadataMatchedBeforeRowCursor",true,"physicalOrdinaryTable",true,"externalLinksDenied",true,"primaryIndexChecked",true,"indexes",checked,"allFourIndexesExact",checked.size()==4);
  }
  static String error(String code){return JSON.toJson(obj("format","gp-known-af-independent-count-v1","passed",false,"code",code));}

  public static void main(String[] args){
    System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.out),true,StandardCharsets.UTF_8));Logger.getLogger("").setLevel(Level.OFF);Logger.getLogger("com.healthmarketscience.jackcess").setLevel(Level.OFF);
    AtomicBoolean done=new AtomicBoolean();Thread watchdog=null;String output;int exit=0;
    try{Options opt=options(args);watchdog=new Thread(()->{try{Thread.sleep(opt.deadlineMs);}catch(InterruptedException e){return;}if(done.compareAndSet(false,true)){System.out.println(error("DEADLINE_EXCEEDED"));System.out.flush();Runtime.getRuntime().halt(2);}},"af-ram-hard-deadline");watchdog.setDaemon(true);watchdog.start();
      output=JSON.toJson(verify(System.in,opt));if(output.getBytes(StandardCharsets.UTF_8).length>opt.jsonCap)fail("JSON_OUTPUT_LIMIT");
    }catch(Throwable e){output=error(e instanceof Rejected r?r.code:e instanceof OutOfMemoryError?"MEMORY_LIMIT_EXCEEDED":"AF_COUNT_VERIFICATION_FAILED");exit=2;}
    if(done.compareAndSet(false,true)){if(watchdog!=null)watchdog.interrupt();System.out.println(output);System.out.flush();if(exit!=0)System.exit(exit);}
  }
}
