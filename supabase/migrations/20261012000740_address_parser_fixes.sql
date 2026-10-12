-- Run after 20261010000670_address_parser.sql / 20261010000680_stops_timezone.sql.
-- public.parse_us_address fixes (same signature, return columns and grants;
-- create_load_from_document is unchanged and picks this up automatically):
--   1) full state names ("Atlanta, Georgia 30303") -> state code, so the stop tz resolves
--   2) "Atlanta GA 30303" (no comma) keeps the city
--   3) 9-digit ZIP without a hyphen is normalised to 12345-6789
-- Existing stops are not changed.

create or replace function public.parse_us_address(
  p_addr text,
  out line1 text, out city text, out state text, out zip text
)
language plpgsql
immutable
set search_path = public
as $$
declare
  v_norm text;
  v_pat constant text := '\m([A-Za-z]{2})\M[\s,.]*(\d{5}(?:-?\d{4})?)?';
  v_name record;
  v_m text[];
  v_n int := 0;
  v_best int;           -- occurrence index of the chosen state match
  v_best_zip boolean := false;
  v_pos int;
  v_prefix text;
  v_segs text[];
  v_cpos int;
  v_ok boolean;
begin
  if p_addr is null or btrim(p_addr) = '' then
    return;
  end if;

  -- Normalise: newlines -> ', ', collapse whitespace and repeated commas, strip trailing country.
  v_norm := regexp_replace(p_addr, '[\r\n]+', ', ', 'g');
  v_norm := regexp_replace(v_norm, '\s+', ' ', 'g');
  v_norm := regexp_replace(v_norm, '\s*,[\s,]*', ', ', 'g');
  v_norm := regexp_replace(v_norm, '[\s,]*\m(u\.s\.a\.?|u\.s\.?|usa|us|united states( of america)?)\.?\s*$', '', 'i');
  v_norm := btrim(v_norm, ' ,');

  -- Full state names -> codes (case-insensitive), only when followed by a ZIP or the end of the address,
  -- so cities like "Washington, DC" or "New York, NY" are left alone. Longest names first.
  for v_name in
    select n, c from (values
      ('Alabama','AL'),('Alaska','AK'),('Arizona','AZ'),('Arkansas','AR'),('California','CA'),('Colorado','CO'),
      ('Connecticut','CT'),('Delaware','DE'),('District of Columbia','DC'),('Florida','FL'),('Georgia','GA'),
      ('Hawaii','HI'),('Idaho','ID'),('Illinois','IL'),('Indiana','IN'),('Iowa','IA'),('Kansas','KS'),
      ('Kentucky','KY'),('Louisiana','LA'),('Maine','ME'),('Maryland','MD'),('Massachusetts','MA'),
      ('Michigan','MI'),('Minnesota','MN'),('Mississippi','MS'),('Missouri','MO'),('Montana','MT'),
      ('Nebraska','NE'),('Nevada','NV'),('New Hampshire','NH'),('New Jersey','NJ'),('New Mexico','NM'),
      ('New York','NY'),('North Carolina','NC'),('North Dakota','ND'),('Ohio','OH'),('Oklahoma','OK'),
      ('Oregon','OR'),('Pennsylvania','PA'),('Rhode Island','RI'),('South Carolina','SC'),('South Dakota','SD'),
      ('Tennessee','TN'),('Texas','TX'),('Utah','UT'),('Vermont','VT'),('Virginia','VA'),('Washington','WA'),
      ('West Virginia','WV'),('Wisconsin','WI'),('Wyoming','WY')
    ) t(n, c) order by length(n) desc
  loop
    v_norm := regexp_replace(v_norm,
      '(^|,\s*|\s)' || replace(v_name.n, ' ', '\s+') || '\M(?=[\s,.]*(\d{5}|$))', '\1' || v_name.c, 'gi');
  end loop;

  line1 := nullif(v_norm, '');

  -- State candidate = valid US state code AND (written in UPPERCASE, or right after a comma,
  -- or right before a ZIP). So lowercase words like 'in', 'or', 'me' don't match mid-sentence.
  -- Prefer a candidate followed by a ZIP; otherwise the LAST valid one.
  for v_m in select regexp_matches(v_norm, v_pat, 'g') loop
    v_n := v_n + 1;
    if public.us_state_tz(v_m[1]) is null then
      continue;
    end if;
    v_cpos := regexp_instr(v_norm, v_pat, 1, v_n);
    v_ok := v_m[1] = upper(v_m[1])                                -- (a) uppercase as written
         or substr(v_norm, 1, v_cpos - 1) ~ ',\s*$'               -- (b) preceded by a comma
         or v_m[2] is not null;                                   -- (c) followed by a ZIP
    if not v_ok then
      continue;
    end if;
    if v_m[2] is not null then
      v_best := v_n; v_best_zip := true; state := upper(v_m[1]);
      zip := case when length(v_m[2]) = 9 then substr(v_m[2], 1, 5) || '-' || substr(v_m[2], 6) else v_m[2] end;
    elsif not v_best_zip then
      v_best := v_n; state := upper(v_m[1]); zip := null;
    end if;
  end loop;

  if v_best is null then
    return;  -- unparsed: line1 = full normalised address
  end if;

  -- City = the comma segment right before the state; line1 = everything before the city.
  v_pos := regexp_instr(v_norm, v_pat, 1, v_best);
  v_prefix := btrim(substr(v_norm, 1, v_pos - 1), ' ,');
  if v_prefix = '' then
    line1 := null;
  elsif position(',' in v_prefix) > 0 then
    v_segs := regexp_split_to_array(v_prefix, '\s*,\s*');
    city := nullif(btrim(v_segs[array_length(v_segs, 1)]), '');
    line1 := nullif(btrim(array_to_string(v_segs[1:array_length(v_segs, 1) - 1], ', ')), '');
  elsif substr(v_norm, v_pos - 2, 2) = ', ' then
    city := v_prefix;  -- "Atlanta, GA ..."
    line1 := null;
  elsif v_best_zip and v_prefix !~ '\d' then
    city := v_prefix;  -- "Atlanta GA 30303": no digits, so it's a city, not a street
    line1 := null;
  else
    line1 := v_prefix; -- no comma: can't separate street from city reliably
  end if;
end;
$$;

revoke execute on function public.parse_us_address(text) from public, anon;
grant execute on function public.parse_us_address(text) to authenticated;
