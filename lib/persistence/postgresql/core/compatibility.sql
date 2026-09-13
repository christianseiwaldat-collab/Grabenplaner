-- Compatibility for existing Core field contracts: text timestamps, 0/1 flags,
-- ASCII SQLite NOCASE and exact string payloads. All routines are invoker-only.
CREATE FUNCTION gp.ascii_fold(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$SELECT translate(value,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')$$;
CREATE FUNCTION gp.lower(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$SELECT gp.ascii_fold(value)$$;
CREATE FUNCTION gp.upper(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$SELECT translate(value,'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ')$$;
CREATE FUNCTION gp.unicode_lower(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$SELECT pg_catalog.lower(value COLLATE pg_catalog.pg_unicode_fast) COLLATE "C"$$;
CREATE FUNCTION gp.sqlite_integer(value text) RETURNS bigint LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE prefix text;parsed numeric;BEGIN
 prefix=substring(value FROM '^[[:space:]]*([+-]?[0-9]+)');
 IF prefix IS NULL THEN RETURN 0;END IF;parsed=prefix::numeric;
 RETURN greatest(-9223372036854775808::numeric,least(9223372036854775807::numeric,parsed))::bigint;
END$$;
CREATE FUNCTION gp.instr(value text, needle text) RETURNS bigint LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$SELECT strpos(value,needle)::bigint$$;
CREATE FUNCTION gp.sqlite_char(VARIADIC codepoints integer[]) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$SELECT string_agg(chr(v),'') FROM unnest(codepoints) v$$;
CREATE FUNCTION gp.hex(value bytea) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT upper(encode(value,'hex'))$$;
CREATE FUNCTION gp.substr(value text, start_position integer, count integer) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE first_position integer;span integer;BEGIN
 first_position=CASE WHEN start_position<0 THEN length(value)+start_position+1 ELSE start_position END;
 span=count;
 IF span<0 THEN first_position=first_position+span;span=-span;END IF;
 RETURN substring(value FROM first_position FOR span);
END$$;
CREATE FUNCTION gp.substr(value text, start_position integer) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$SELECT substring(value FROM CASE WHEN start_position<0 THEN length(value)+start_position+1 ELSE start_position END)$$;
CREATE FUNCTION gp.substr(value text, start_position bigint) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$SELECT gp.substr(value,start_position::integer)$$;
CREATE FUNCTION gp.randomblob(size integer) RETURNS bytea LANGUAGE sql VOLATILE STRICT AS $$SELECT gp.gen_random_bytes(size)$$;
CREATE FUNCTION gp.json_valid(value text) RETURNS integer LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN PERFORM value::jsonb;RETURN 1;EXCEPTION WHEN invalid_text_representation THEN RETURN 0;END$$;
CREATE FUNCTION gp.json_path(path text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
 IF path='$' THEN RETURN ARRAY[]::text[];END IF;
 IF path !~ '^\$((\.[A-Za-z_][A-Za-z_0-9]*)|(\[[0-9]+\]))+$' THEN RAISE EXCEPTION 'Unsupported JSON path';END IF;
 RETURN regexp_split_to_array(trim(both '.' FROM replace(replace(substring(path FROM 2),'[','.'),']','')),'\.');
END$$;
CREATE FUNCTION gp.json_extract(value text,path text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$SELECT value::jsonb #>> gp.json_path(path)$$;
CREATE FUNCTION gp.json_integer(value text,path text) RETURNS bigint LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE item jsonb;BEGIN item=value::jsonb #> gp.json_path(path);
 IF item='true'::jsonb THEN RETURN 1;ELSIF item='false'::jsonb THEN RETURN 0;END IF;
 IF jsonb_typeof(item)='number' AND item::text ~ '^-?[0-9]+$' THEN RETURN item::text::bigint;END IF;RETURN NULL;
EXCEPTION WHEN numeric_value_out_of_range THEN RETURN NULL;END$$;
CREATE FUNCTION gp.json_type(value text,path text DEFAULT '$') RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE item jsonb; kind text;
BEGIN item=value::jsonb #> gp.json_path(path);kind=jsonb_typeof(item);
 IF kind='number' THEN RETURN CASE WHEN item::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END; END IF;
 IF kind='boolean' THEN RETURN item::text;END IF;
 RETURN CASE WHEN kind='string' THEN 'text' ELSE kind END;
END$$;
CREATE FUNCTION gp.json_array_length(value text,path text DEFAULT '$') RETURNS bigint LANGUAGE sql IMMUTABLE STRICT AS $$SELECT CASE WHEN (value::jsonb #> gp.json_path(path)) IS NULL THEN NULL WHEN jsonb_typeof(value::jsonb #> gp.json_path(path))='array' THEN jsonb_array_length(value::jsonb #> gp.json_path(path)) ELSE 0 END::bigint$$;
CREATE FUNCTION gp.json_scalar_text(item jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT CASE WHEN item='null'::jsonb THEN NULL WHEN item='true'::jsonb THEN '1'
 WHEN item='false'::jsonb THEN '0' WHEN jsonb_typeof(item)='string' THEN item#>>'{}' ELSE item::text END
$$;
CREATE FUNCTION gp.json_each(input text,path text DEFAULT '$') RETURNS TABLE(key text,value text,type text) LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE item jsonb; pair record;
BEGIN
 item=input::jsonb #> gp.json_path(path);
 IF jsonb_typeof(item)='array' THEN
  FOR pair IN SELECT ordinality-1 AS k,v FROM jsonb_array_elements(item) WITH ORDINALITY AS a(v,ordinality) LOOP
   key=pair.k::text;value=gp.json_scalar_text(pair.v);type=gp.json_type(pair.v::text);RETURN NEXT;
  END LOOP;
 ELSIF jsonb_typeof(item)='object' THEN
  FOR pair IN SELECT k,v FROM jsonb_each(item) AS a(k,v) LOOP
   key=pair.k;value=gp.json_scalar_text(pair.v);type=gp.json_type(pair.v::text);RETURN NEXT;
  END LOOP;
 ELSIF item IS NOT NULL THEN key=NULL;value=gp.json_scalar_text(item);type=gp.json_type(item::text);RETURN NEXT;
 END IF;
END$$;
CREATE FUNCTION gp.sqlite_timestamp(value text,VARIADIC modifiers text[]) RETURNS timestamp LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE result timestamp;modifier text;day_offset interval;
BEGIN
 IF value='now' THEN result=statement_timestamp() AT TIME ZONE 'UTC';
 ELSIF value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
  IF value ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN result=value::timestamptz AT TIME ZONE 'UTC';ELSE result=value::timestamp;END IF;
 ELSE RETURN NULL; END IF;
 FOREACH modifier IN ARRAY modifiers LOOP
  IF modifier='start of month' THEN result=date_trunc('month',result);
  ELSIF modifier='start of year' THEN result=date_trunc('year',result);
  ELSIF modifier='start of day' THEN result=date_trunc('day',result);
  ELSIF modifier='localtime' THEN result=(result AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Vienna';
  ELSIF modifier ~ '^[+-]?[0-9]+ (month|months|year|years)$' THEN
   -- SQLite defaults to a ceiling on month/year overflow, unlike PostgreSQL's
   -- clamp to the last day of the target month. Preserve the day displacement.
   day_offset=result-date_trunc('month',result);
   result=date_trunc('month',result)+modifier::interval+day_offset;
  ELSIF modifier ~ '^[+-]?[0-9]+ (day|days|month|months|year|years|hour|hours|minute|minutes|second|seconds)$' THEN result=result+modifier::interval;
  ELSE RAISE EXCEPTION 'Unsupported SQLite timestamp modifier'; END IF;
 END LOOP;
 RETURN result;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END$$;
CREATE FUNCTION gp.date(value text,VARIADIC modifiers text[] DEFAULT '{}') RETURNS text LANGUAGE sql STABLE STRICT AS $$SELECT to_char(gp.sqlite_timestamp(value,VARIADIC modifiers),'YYYY-MM-DD')$$;
CREATE FUNCTION gp.datetime(value text,VARIADIC modifiers text[] DEFAULT '{}') RETURNS text LANGUAGE sql STABLE STRICT AS $$SELECT to_char(gp.sqlite_timestamp(value,VARIADIC modifiers),'YYYY-MM-DD HH24:MI:SS')$$;
CREATE FUNCTION gp.julianday(value text,VARIADIC modifiers text[] DEFAULT '{}') RETURNS double precision LANGUAGE sql STABLE STRICT AS $$SELECT extract(epoch FROM gp.sqlite_timestamp(value,VARIADIC modifiers))::double precision/86400.0+2440587.5$$;
CREATE FUNCTION gp.strftime(format text,value text,VARIADIC modifiers text[] DEFAULT '{}') RETURNS text LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE stamp timestamp;result text;
BEGIN stamp=gp.sqlite_timestamp(value,VARIADIC modifiers);
 IF stamp IS NULL THEN RETURN NULL;END IF;
 result=replace(format,'%%','{percent}');
 result=replace(result,'%Y',to_char(stamp,'YYYY'));result=replace(result,'%m',to_char(stamp,'MM'));result=replace(result,'%d',to_char(stamp,'DD'));
 result=replace(result,'%H',to_char(stamp,'HH24'));result=replace(result,'%M',to_char(stamp,'MI'));result=replace(result,'%S',to_char(stamp,'SS'));
 result=replace(result,'%f',to_char(stamp,'SS.MS'));result=replace(result,'%w',extract(dow FROM stamp)::text);
 result=replace(result,'%s',floor(extract(epoch FROM stamp))::bigint::text);
 IF result LIKE '%\%%' ESCAPE '\' THEN RETURN NULL;END IF;
 RETURN replace(result,'{percent}','%');
END$$;
