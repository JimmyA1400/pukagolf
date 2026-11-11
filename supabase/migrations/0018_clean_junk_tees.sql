-- Strip junk tee names from courses already imported.
--
-- src/lib/tees.ts now filters these at import, but courses brought in before
-- that still carry them: a real course in the source publishes a tee called
-- "web", which shows up as a selectable set on the scorecard.
--
-- The vocabulary is repeated here rather than shared, because this runs once
-- against existing rows and the TypeScript list is what governs every future
-- import. If the two ever drift, the TypeScript one is authoritative.

create or replace function tee_name_is_recognised(name text)
returns boolean
language sql
immutable
as $fn$
  select name is not null
     and btrim(name) <> ''
     -- Every part must be tee vocabulary: "blue/white" and "blue-male" are
     -- real, "blue/web" is not.
     and not exists (
       select 1
         from unnest(regexp_split_to_array(lower(btrim(name)), '[/\-\s_]+')) as token
        where token <> ''
          and token not in (
            'white','blue','red','gold','black','green','yellow','silver',
            'bronze','copper','orange','purple','teal','maroon','navy','tan',
            'grey','gray','pink','brown','burgundy','charcoal',
            'championship','champion','champ','tips','back','middle','member',
            'members','forward','front','senior','seniors','ladies','lady',
            'women','womens','men','mens','junior','juniors','pro','regular',
            'tournament','executive','combo','combination','long','short',
            'male','female',
            -- Numbered tee sets. Courses really do use these, and leaving them
            -- out would delete the whole tee structure of most courses already
            -- imported. Capped low on purpose so "x" and long numbers stay junk.
            'i','ii','iii','iv','v','vi','vii','viii',
            '1','2','3','4','5','6','7','8'
          )
     );
$fn$;

-- Remove unrecognised keys from every hole's yardage map.
update course_holes
   set yardages = (
     select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
       from jsonb_each(yardages)
      where tee_name_is_recognised(key)
   )
 where yardages is not null
   and exists (
     select 1 from jsonb_object_keys(yardages) as key
      where not tee_name_is_recognised(key)
   );

-- And drop the tee sets themselves.
delete from course_tees
 where not tee_name_is_recognised(coalesce(tee_name, tee_key));

revoke execute on function tee_name_is_recognised(text) from public;
