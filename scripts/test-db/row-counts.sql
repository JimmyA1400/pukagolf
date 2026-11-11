-- Exact row count of every table that holds league data, one "table|rows"
-- line each, sorted. Run against the live and the test database and the two
-- outputs must be identical: that is the proof the copy lost nothing.
--
-- Exact counts, not pg_stat estimates: an estimate can be off by a few rows,
-- and a few rows is a missing scorecard.

select t, n
  from (
    select format('%I.%I', table_schema, table_name) as t,
           (xpath('/row/n/text()',
                  query_to_xml(format('select count(*) as n from %I.%I',
                                      table_schema, table_name),
                               false, true, '')))[1]::text::bigint as n
      from information_schema.tables
     where table_schema = 'public'
       and table_type = 'BASE TABLE'
    union all
    select 'auth.users', (select count(*) from auth.users)
  ) as counts
 order by t;
