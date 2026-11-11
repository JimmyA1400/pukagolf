/*
  An audit log the owner can read, and a place for the site to record its own
  errors.

  Every delete, clear, PIN change and score edit already writes to audit_log,
  but the only way to read it was the SQL editor. owner_audit_log() puts it on
  /admin.

  Errors used to exist only in the player's own browser console, which is to
  say nowhere anyone would see them. The site now reports them here. A hosted
  service would need an account and a key; this needs neither, and a league
  this size will not outgrow a table.

  client_errors has no policies at all. Reports come in through
  report_client_error(), which anyone can call, signed in or not, because the
  errors worth knowing about include the ones on the sign-in and outing pages.
  That makes it the one write path open to the whole internet, so it is
  bounded: 30 reports a minute across everyone, fields cut to size, and rows
  older than 90 days cleared as new ones arrive.
*/

create table if not exists client_errors (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  kind       text not null check (kind in ('error', 'rejection', 'boundary')),
  message    text not null check (length(message) between 1 and 500),
  stack      text check (stack is null or length(stack) <= 4000),
  path       text check (path is null or length(path) <= 500),
  user_agent text check (user_agent is null or length(user_agent) <= 300),
  digest     text check (digest is null or length(digest) <= 100),
  user_id    uuid references profiles on delete set null
);

create index if not exists client_errors_recent on client_errors (at desc);

alter table client_errors enable row level security;
-- Deliberately no policies: written by report_client_error, read by the owner.

create or replace function report_client_error(
  in_kind       text,
  in_message    text,
  in_stack      text default null,
  in_path       text default null,
  in_user_agent text default null,
  in_digest     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- A burst beyond this is one bug reporting itself, or someone spamming.
  -- Either way the first 30 say everything the rest would.
  if (select count(*) from client_errors where at > now() - interval '1 minute') >= 30 then
    return;
  end if;

  delete from client_errors where at < now() - interval '90 days';

  insert into client_errors (kind, message, stack, path, user_agent, digest, user_id)
  values (
    case when in_kind in ('error', 'rejection', 'boundary') then in_kind else 'error' end,
    left(coalesce(nullif(btrim(in_message), ''), '(no message)'), 500),
    left(in_stack, 4000),
    left(in_path, 500),
    left(in_user_agent, 300),
    left(in_digest, 100),
    -- Only a real profile: a signed-in id without one must not fail the report.
    (select id from profiles where id = auth.uid())
  );
end;
$fn$;

revoke execute on function report_client_error(text, text, text, text, text, text) from public;
grant execute on function report_client_error(text, text, text, text, text, text) to anon, authenticated;

/*
  The audit log, newest first, a page at a time. in_before is the timestamp of
  the oldest entry already shown.
*/
create or replace function owner_audit_log(
  in_limit  integer default 50,
  in_before timestamptz default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
begin
  if not is_owner() then
    raise exception 'Only the league owner can read the audit log.'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(x.entry order by x.at desc, x.id desc)
      from (
        select a.at,
               a.id,
               jsonb_build_object(
                 'id',       a.id,
                 'at',       a.at,
                 -- A deleted player's entries keep their label, if they had one.
                 'actor',    coalesce(p.full_name, a.actor_label, 'System'),
                 'action',   a.action,
                 'entity',   a.entity,
                 'entityId', a.entity_id,
                 'detail',   a.detail
               ) as entry
          from audit_log a
          left join profiles p on p.id = a.actor_id
         where in_before is null or a.at < in_before
         order by a.at desc, a.id desc
         limit least(greatest(coalesce(in_limit, 50), 1), 200)
      ) as x
  ), '[]'::jsonb);
end;
$fn$;

create or replace function owner_client_errors(in_limit integer default 50)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
begin
  if not is_owner() then
    raise exception 'Only the league owner can read site errors.'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(x.entry order by x.at desc, x.id desc)
      from (
        select e.at,
               e.id,
               jsonb_build_object(
                 'id',        e.id,
                 'at',        e.at,
                 'kind',      e.kind,
                 'message',   e.message,
                 'stack',     e.stack,
                 'path',      e.path,
                 'userAgent', e.user_agent,
                 'digest',    e.digest,
                 'who',       p.full_name
               ) as entry
          from client_errors e
          left join profiles p on p.id = e.user_id
         order by e.at desc, e.id desc
         limit least(greatest(coalesce(in_limit, 50), 1), 200)
      ) as x
  ), '[]'::jsonb);
end;
$fn$;

create or replace function owner_clear_client_errors()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  removed integer;
begin
  if not is_owner() then
    raise exception 'Only the league owner can clear site errors.'
      using errcode = 'insufficient_privilege';
  end if;

  delete from client_errors;
  get diagnostics removed = row_count;

  insert into audit_log (actor_id, action, entity, entity_id, detail)
  values (auth.uid(), 'clear', 'client_errors', 'all',
          jsonb_build_object('removed', removed));

  return removed;
end;
$fn$;

revoke execute on function owner_audit_log(integer, timestamptz) from public, anon;
revoke execute on function owner_client_errors(integer) from public, anon;
revoke execute on function owner_clear_client_errors() from public, anon;

grant execute on function owner_audit_log(integer, timestamptz) to authenticated;
grant execute on function owner_client_errors(integer) to authenticated;
grant execute on function owner_clear_client_errors() to authenticated;
