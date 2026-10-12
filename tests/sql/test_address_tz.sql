-- SQL tests for public.parse_us_address and public.us_state_tz.
-- Run: ./run_sql_tests.sh   (local throwaway Postgres only)
\o /dev/null
create temp table results(name text, ok boolean, got text, want text);
create or replace function pg_temp.chk(p_name text, p_addr text, p_line1 text, p_city text, p_state text, p_zip text)
returns void language plpgsql as $$
declare r record; g text; w text;
begin
  select * into r from public.parse_us_address(p_addr);
  g := concat_ws(' | ', coalesce(r.line1,'∅'), coalesce(r.city,'∅'), coalesce(r.state,'∅'), coalesce(r.zip,'∅'));
  w := concat_ws(' | ', coalesce(p_line1,'∅'), coalesce(p_city,'∅'), coalesce(p_state,'∅'), coalesce(p_zip,'∅'));
  insert into results values (p_name, g = w, g, w);
end $$;
create or replace function pg_temp.tz(p_name text, p_addr text, p_want text) returns void language sql as $$
  insert into results select p_name, coalesce(public.us_state_tz((public.parse_us_address(p_addr)).state),'∅') = p_want,
    coalesce(public.us_state_tz((public.parse_us_address(p_addr)).state),'∅'), p_want $$;

-- Multi-line
select pg_temp.chk('multiline: street\ncity, ST zip', E'123 Main St\nAtlanta, GA 30303', '123 Main St','Atlanta','GA','30303');
select pg_temp.chk('multiline: CRLF', E'123 Main St\r\nAtlanta, GA 30303', '123 Main St','Atlanta','GA','30303');
select pg_temp.chk('multiline: company + no comma + country', E'ACME Foods\n77 Rail Way\nChicago IL 60607\nUnited States', 'ACME Foods, 77 Rail Way','Chicago','IL','60607');
-- USA suffixes
select pg_temp.chk('USA after comma', '123 Main St, Atlanta, GA 30303, USA', '123 Main St','Atlanta','GA','30303');
select pg_temp.chk('USA no comma', '123 Main St, Atlanta, GA 30303 USA', '123 Main St','Atlanta','GA','30303');
select pg_temp.chk('U.S.A.', '123 Main St, Columbus, OH 43215, U.S.A.', '123 Main St','Columbus','OH','43215');
select pg_temp.chk('US', '4 Pine St, Augusta, GA 30901, US', '4 Pine St','Augusta','GA','30901');
select pg_temp.chk('United States of America', '1 Main St, Atlanta, GA 30303 United States of America', '1 Main St','Atlanta','GA','30303');
-- Lowercase in / or
select pg_temp.chk('lowercase in + zip', '1 Plant Rd, Indianapolis, in 46201', '1 Plant Rd','Indianapolis','IN','46201');
select pg_temp.chk('lowercase or + zip', '9 Dock Ave, Portland, or 97201', '9 Dock Ave','Portland','OR','97201');
select pg_temp.chk('lowercase in after comma, no zip', 'Stop in Gary, in', null,'Stop in Gary','IN',null);
select pg_temp.chk('words in/or mid-sentence ignored', 'Drop trailer in yard or dock 4, Dallas, TX 75201', 'Drop trailer in yard or dock 4','Dallas','TX','75201');
select pg_temp.chk('uppercase OR word + OR state', 'Gate 2 OR Gate 3, Portland, OR', 'Gate 2 OR Gate 3','Portland','OR',null);
select pg_temp.chk('lowercase me + zip', 'PO Box 5, Bangor, me 04401', 'PO Box 5','Bangor','ME','04401');
-- ZIP+4
select pg_temp.chk('ZIP+4', '500 W Madison St, Chicago, IL 60661-2591', '500 W Madison St','Chicago','IL','60661-2591');
select pg_temp.chk('ZIP+4 + USA', '1 Main St, Atlanta, GA 30303-1234 USA', '1 Main St','Atlanta','GA','30303-1234');
-- Misc
select pg_temp.chk('city, ST only', 'Atlanta, GA', null,'Atlanta','GA',null);
select pg_temp.chk('dotted state', '1 Main St., Atlanta, Ga. 30303', '1 Main St.','Atlanta','GA','30303');
select pg_temp.chk('comma before zip', '12 Elm, Springfield, IL, 62701', '12 Elm','Springfield','IL','62701');
select pg_temp.chk('state followed by other 2-letter uppercase', '5 Main St, Denver, CO 80202, Attn: IN dept', '5 Main St','Denver','CO','80202');
select pg_temp.chk('empty', '', null,null,null,null);
select pg_temp.chk('null', null, null,null,null,null);
select pg_temp.chk('non-US-state code XX', '1 Main St, Somewhere, XX 12345', '1 Main St, Somewhere, XX 12345',null,null,null);
-- Fixed in 20261012000740
select pg_temp.chk('no-comma City ST zip', 'Atlanta GA 30303', null,'Atlanta','GA','30303');
select pg_temp.chk('full state name', '123 Main St, Atlanta, Georgia 30303', '123 Main St','Atlanta','GA','30303');
select pg_temp.chk('9-digit ZIP normalised to ZIP+4', '1 Rd, Chicago, IL 606011234', '1 Rd','Chicago','IL','60601-1234');

select pg_temp.chk('full name lowercase + no zip', '9 Oak Ave, Portland, oregon', '9 Oak Ave','Portland','OR',null);
select pg_temp.chk('two-word full name', '1 Main St, Raleigh, North Carolina 27601', '1 Main St','Raleigh','NC','27601');
select pg_temp.chk('Washington DC city untouched', '1600 Pennsylvania Ave NW, Washington, DC 20500', '1600 Pennsylvania Ave NW','Washington','DC','20500');
select pg_temp.chk('New York city untouched', '1 Broadway, New York, NY 10004', '1 Broadway','New York','NY','10004');
select pg_temp.chk('street + no-comma city kept in line1', '123 Main St Atlanta GA 30303', '123 Main St Atlanta',null,'GA','30303');

-- us_state_tz
insert into results select 'tz '||s, coalesce(public.us_state_tz(s),'∅') = w, coalesce(public.us_state_tz(s),'∅'), w
from (values ('GA','America/New_York'),('IL','America/Chicago'),('il','America/Chicago'),(' in ','America/Indiana/Indianapolis'),
             ('or','America/Los_Angeles'),('TX','America/Chicago'),('AZ','America/Phoenix'),('XX','∅'),('','∅')) t(s,w);
insert into results select 'tz null', public.us_state_tz(null) is null, coalesce(public.us_state_tz(null),'∅'), '∅';
insert into results select 'tz: every mapped zone is a valid IANA name', count(*) = 0, count(*)::text, '0'
from (select unnest(array['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','PR']) c) s
where public.us_state_tz(c) is null or not exists (select 1 from pg_timezone_names where name = public.us_state_tz(c));
-- End-to-end address -> zone (Atlanta/Chicago)
select pg_temp.tz('Atlanta multiline -> New_York', E'123 Peachtree St\nAtlanta, GA 30303', 'America/New_York');
select pg_temp.tz('Atlanta USA -> New_York', '123 Peachtree St, Atlanta, GA 30303, USA', 'America/New_York');
select pg_temp.tz('Chicago ZIP+4 -> Chicago', '500 W Madison St, Chicago, IL 60661-2591', 'America/Chicago');
select pg_temp.tz('Chicago multiline no comma -> Chicago', E'77 Rail Way\nChicago IL 60607', 'America/Chicago');
select pg_temp.tz('Indianapolis lowercase in', '1 Plant Rd, Indianapolis, in 46201', 'America/Indiana/Indianapolis');
select pg_temp.tz('Atlanta, Georgia -> New_York', '123 Main St, Atlanta, Georgia 30303', 'America/New_York');
-- Appointment conversion sanity: 08:00 local in Atlanta vs Chicago
insert into results select 'appt 2026-10-15 08:00 Atlanta = 12:00Z', ('2026-10-15 08:00'::timestamp at time zone public.us_state_tz('GA')) = '2026-10-15 12:00Z', '', '';
insert into results select 'appt 2026-10-15 08:00 Chicago = 13:00Z', ('2026-10-15 08:00'::timestamp at time zone public.us_state_tz('IL')) = '2026-10-15 13:00Z', '', '';

\o
\pset footer off
select case when ok then 'PASS' else 'FAIL' end as res, name, got, want from results;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from results;
do $$ begin if exists (select 1 from results where not ok) then raise exception 'SQL tests failed'; end if; end $$;
