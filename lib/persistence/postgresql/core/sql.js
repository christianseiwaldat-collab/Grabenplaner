'use strict';
// Token-based conversion for the frozen, reviewed migration source, not user SQL.
function tokens(sql) {
  const result=[];let pos=0;
  const rx=/\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|\[[^\]]*\]|\$(?:[a-zA-Z_][\w]*|\d+)|[a-zA-Z_][\w]*|\d+(?:\.\d+)?|<>|!=|<=|>=|\|\||!~|::|./gy;
  while(pos<sql.length){rx.lastIndex=pos;const m=rx.exec(sql);if(!m)throw new Error('SQL tokenization failed');pos=rx.lastIndex;if(!/^\s|^--|^\/\*/.test(m[0]))result.push(m[0]);}
  return result;
}
const text=t=>t.join(' ');
const name=t=>t?.replace(/^"|"$/g,'').toLowerCase();
function matching(t,start,step=1){const open=step===1?'(':')',close=step===1?')':'(';let depth=0;for(let i=start;i>=0&&i<t.length;i+=step){if(t[i]===open)depth++;if(t[i]===close&&--depth===0)return i;}throw new Error('Unbalanced SQL');}
function split(t,delimiter=','){const result=[];let start=0,depth=0;for(let i=0;i<t.length;i++){if(t[i]==='(')depth++;else if(t[i]===')')depth--;else if(t[i]===delimiter&&depth===0){result.push(t.slice(start,i));start=i+1;}}result.push(t.slice(start));return result.filter(a=>a.length);}
function atomStart(t,end){let start=end;
  if(t[end]?.toUpperCase()==='END'){let depth=1;for(let i=end-1;i>=0;i--){if(t[i].toUpperCase()==='END')depth++;if(t[i].toUpperCase()==='CASE'&&--depth===0){start=i;break;}}}
  if(t[end]===')'){start=matching(t,end,-1);if(/^[\w]+$/.test(t[start-1]||'')&&!['IN','EXISTS','NOT','AND','OR','WHEN','SELECT','WHERE','THEN'].includes(t[start-1].toUpperCase()))start--;}
  while(start>=2&&t[start-1]==='.')start-=2;return start;}
function globPattern(literal){
  if(!/^'(?:[^']|'')*'$/.test(literal))throw new Error('GLOB requires a reviewed literal');
  const raw=literal.slice(1,-1).replace(/''/g,"'");let result='^',inClass=false;
  for(let i=0;i<raw.length;i++){const c=raw[i];if(inClass){result+=c;if(c===']')inClass=false;}
    else if(c==='['){result+='[';inClass=true;}else if(c==='*')result+='.*';else if(c==='?')result+='.';else result+=/[.()+{}^$|\\]/.test(c)?'\\'+c:c;}
  if(inClass)throw new Error('Unclosed GLOB class');return "'"+(result+'$').replace(/'/g,"''")+"'";
}
const FUNCTIONS=new Set(['json_valid','json_type','json_each','json_extract','json_array_length','julianday','date','datetime','strftime','instr','char','hex','randomblob','lower','upper','substr']);
function expression(input) {
  const t=Array.isArray(input)?[...input]:tokens(input);
  for(let i=0;i<t.length;i++) {
    if(t[i]?.toUpperCase()==='JOIN'&&t[i+1]?.toLowerCase()==='json_each'&&t[i+2]==='('){
      let after=matching(t,i+2)+1;
      if(t[after]?.toUpperCase()==='AS')after+=2;
      else if(/^[a-zA-Z_]\w*$/.test(t[after]||'')&&!['ON','USING','WHERE','JOIN','LEFT','RIGHT','INNER','CROSS','GROUP','ORDER'].includes(t[after].toUpperCase()))after++;
      if(!['ON','USING'].includes(t[after]?.toUpperCase())&&t[i-1]?.toUpperCase()!=='CROSS'){t.splice(i,0,'CROSS');i++;}
    }
    if(t[i].toLowerCase()==='instr'&&t[i+1]==='('){
      const end=matching(t,i+1),args=split(t.slice(i+2,end));
      if(args.length===2&&/^char \( 0 \)$/i.test(text(args[1])))t.splice(i,end-i+1,'0');
    }
    if(t[i]?.toLowerCase()==='json_valid'&&t[i+1]==='('){
      const end=matching(t,i+1);if(['AND','OR'].includes(t[end+1]?.toUpperCase())||(t[end+1]===')'&&t[i-2]?.toUpperCase()==='CHECK'))t.splice(end+1,0,'=','1');
    }
  }
  for(let i=0;i<t.length;i++){
    const upper=t[i].toUpperCase();
    if(upper==='GLOB'){
      const negative=t[i-1]?.toUpperCase()==='NOT',end=i-(negative?2:1),start=atomStart(t,end);
      const lhs=t.slice(start,end+1),regex=globPattern(t[i+1]);
      t.splice(start,i+2-start,'(',...lhs,negative?'!~':'~',regex,')');i=start+lhs.length+3;
    }else if(upper==='IS'&&!['NULL','TRUE','FALSE','DISTINCT'].includes(t[i+1]?.toUpperCase())){
      if(t[i+1]?.toUpperCase()==='NOT'&&!['NULL','TRUE','FALSE','DISTINCT'].includes(t[i+2]?.toUpperCase())){t.splice(i,2,'IS','DISTINCT','FROM');i+=2;}
      else if(t[i+1]?.toUpperCase()!=='NOT'){t.splice(i,1,'IS','NOT','DISTINCT','FROM');i+=3;}
    }else if(upper==='COLLATE'&&t[i+1]?.toUpperCase()==='NOCASE'){
      const start=atomStart(t,i-1),lhs=t.slice(start,i);t.splice(start,i+2-start,'gp.ascii_fold','(',...lhs,')','COLLATE','"C"');i=start+lhs.length+4;
    }else if(upper==='COLLATE'&&t[i+1]?.toUpperCase()==='BINARY'){t[i+1]='"C"';i++;}
  }
  for(let i=0;i<t.length;i++){
    const n=t[i].toLowerCase();
    if(n==='gp_unicode_casefold'&&t[i+1]==='(')t[i]='gp.unicode_lower';
    if(n==='sqlite_master'||n==='sqlite_schema')t[i]='gp.source_catalog';
    if(n==='sales_article_revisions')t[i]='gp.article_reference_snapshots';
    if(n==='json_extract'&&t[i+1]==='('){
      const args=split(t.slice(i+2,matching(t,i+1)));
      if(args.length===2&&["'$.completed'","'$.required'","'$.departmentId'"].includes(text(args[1])))t[i]='gp.json_integer';
    }
    if(FUNCTIONS.has(n)&&t[i]===n&&t[i+1]==='('&&t[i-1]!=='.')t[i]='gp.'+(n==='char'?'sqlite_char':n);
    else if(FUNCTIONS.has(n)&&t[i]!==n&&t[i].toLowerCase()===n&&t[i+1]==='('&&t[i-1]!=='.')t[i]='gp.'+(n==='char'?'sqlite_char':n);
    if(n==='current_timestamp')t[i]="to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')";
    if(n==='max'&&t[i+1]==='('){const end=matching(t,i+1);if(split(t.slice(i+2,end)).length>1)t[i]='greatest';}
  }
  return text(t);
}
function insertIgnore(sql){
  let result=expression(sql);
  if(/^INSERT OR IGNORE /i.test(result))result=result.replace(/^INSERT OR IGNORE /i,'INSERT ')+' ON CONFLICT DO NOTHING';
  return result;
}
module.exports={tokens,text,name,matching,split,expression,insertIgnore,atomStart};
